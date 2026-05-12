-- Core enum for order lifecycle
CREATE TYPE order_status AS ENUM (
  'order_received',
  'preparing',
  'ready_for_pickup',
  'completed',
  'cancelled'
);

-- Staff authentication (extends Supabase auth.users)
CREATE TABLE staff (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','manager','cashier','kitchen')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Menu catalog
CREATE TABLE menu_items (
  item_code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  price NUMERIC(10,2) NOT NULL,
  category TEXT,
  available BOOLEAN DEFAULT true,
  station TEXT,
  similar_items TEXT[],
  times_ordered INT DEFAULT 0,
  allergens TEXT[],
  modifiers_whitelist JSONB DEFAULT '[]'
  -- modifiers_whitelist format: [{"code":"XTRA_CHEESE","label":"Extra cheese","upcharge":30.00}]
);

-- Customer sessions
CREATE TABLE user_sessions (
  phone TEXT PRIMARY KEY,
  cart JSONB DEFAULT '[]',
  table_number TEXT,
  preferences JSONB DEFAULT '{}',
  consent_given_at TIMESTAMPTZ,
  policy_version TEXT,
  opt_out BOOLEAN DEFAULT false,
  deletion_requested_at TIMESTAMPTZ,
  last_order JSONB,
  last_inbound_at TIMESTAMPTZ DEFAULT NOW(),
  idempotency_key UUID,
  idempotency_expires_at TIMESTAMPTZ,
  language_code TEXT DEFAULT 'en',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Orders
CREATE TABLE orders (
  order_id SERIAL PRIMARY KEY,
  display_id TEXT UNIQUE NOT NULL,
  phone TEXT NOT NULL,
  table_number TEXT,
  items JSONB NOT NULL,
  status order_status DEFAULT 'order_received',
  subtotal NUMERIC(10,2) NOT NULL,
  tax_rate NUMERIC(5,4) NOT NULL,
  tax_amount NUMERIC(10,2) NOT NULL,
  total NUMERIC(10,2) NOT NULL,
  allergen_alert BOOLEAN DEFAULT false,
  allergen_text TEXT,
  allergen_ack_at TIMESTAMPTZ,
  allergen_ack_device TEXT,
  confirmed_at TIMESTAMPTZ DEFAULT NOW(),
  idempotency_key UUID UNIQUE,
  delivery_failed BOOLEAN DEFAULT false,
  amendment_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Order amendments audit trail
CREATE TABLE order_amendments (
  id SERIAL PRIMARY KEY,
  order_id INT REFERENCES orders(order_id),
  before_state JSONB NOT NULL,
  after_state JSONB NOT NULL,
  amount_delta NUMERIC(10,2) NOT NULL,
  amended_by UUID REFERENCES staff(id),
  amended_at TIMESTAMPTZ DEFAULT NOW()
);

-- Staff action audit log
CREATE TABLE audit_log (
  id SERIAL PRIMARY KEY,
  staff_id UUID REFERENCES staff(id),
  action TEXT NOT NULL,
  order_id INT REFERENCES orders(order_id),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Inbound/outbound message log (used for rate limiting and idempotency)
CREATE TABLE message_logs (
  id SERIAL PRIMARY KEY,
  message_id TEXT UNIQUE,
  phone TEXT NOT NULL,
  direction TEXT CHECK (direction IN ('inbound','outbound')),
  content_preview TEXT,
  channel TEXT CHECK (channel IN ('whatsapp','sms')),
  delivery_status TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Complaints
CREATE TABLE complaints (
  id SERIAL PRIMARY KEY,
  order_id INT REFERENCES orders(order_id),
  phone TEXT,
  complaint_text TEXT,
  resolved BOOLEAN DEFAULT false,
  resolved_by UUID REFERENCES staff(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Refunds (cash-based; no payment gateway yet)
CREATE TABLE refunds (
  id SERIAL PRIMARY KEY,
  order_id INT REFERENCES orders(order_id),
  items_refunded JSONB,
  amount NUMERIC(10,2) NOT NULL,
  reason TEXT NOT NULL,
  manager_id UUID REFERENCES staff(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Cash transactions
CREATE TABLE cash_transactions (
  id SERIAL PRIMARY KEY,
  order_id INT REFERENCES orders(order_id),
  amount NUMERIC(10,2) NOT NULL,
  transaction_type TEXT CHECK (transaction_type IN ('payment','refund','adjustment')),
  staff_id UUID REFERENCES staff(id),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Promotions and discount codes
CREATE TABLE promotions (
  code TEXT PRIMARY KEY,
  type TEXT CHECK (type IN ('percentage','flat')),
  discount NUMERIC(10,2) NOT NULL,
  min_order_value NUMERIC(10,2) DEFAULT 0,
  valid_hours_start TIME,
  valid_hours_end TIME,
  valid_days TEXT[],
  max_uses INT,
  current_uses INT DEFAULT 0,
  expiry DATE,
  active BOOLEAN DEFAULT true
);

-- KDS ping table for application-level realtime health check
CREATE TABLE kds_pings (
  id SERIAL PRIMARY KEY,
  device_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Device registrations for KDS
CREATE TABLE kds_devices (
  device_uuid TEXT PRIMARY KEY,
  station TEXT NOT NULL,
  registered_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW()
);

-- System settings (the single brain)
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by UUID REFERENCES staff(id)
);

-- Seed essential settings
INSERT INTO settings (key, value) VALUES
  ('kitchen_status', 'open'),
  ('bot_mode', 'ai'),
  ('kds_last_heartbeat', NOW()::TEXT),
  ('allergen_enforcement', 'true'),
  ('operating_hours_enforcement', 'true'),
  ('amendment_window_enforcement', 'true'),
  ('rate_limiting', 'true'),
  ('groq_circuit_breaker_open', 'false'),
  ('groq_failure_count', '0'),
  ('groq_last_failure_at', '');

-- Sessions archive (no PK copy, uses its own identity)
CREATE TABLE sessions_archive (
  archive_id SERIAL PRIMARY KEY,
  archived_at TIMESTAMPTZ DEFAULT NOW(),
  LIKE user_sessions INCLUDING DEFAULTS
);

-- Indexes
CREATE INDEX idx_orders_phone ON orders(phone);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX idx_orders_display_id ON orders(display_id);
CREATE INDEX idx_message_logs_phone_created ON message_logs(phone, created_at DESC);
CREATE INDEX idx_message_logs_message_id ON message_logs(message_id);
CREATE INDEX idx_audit_log_order_id ON audit_log(order_id);
CREATE INDEX idx_user_sessions_updated ON user_sessions(updated_at);
CREATE INDEX idx_kds_pings_created ON kds_pings(created_at DESC);

-- Auto-update updated_at on orders
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER orders_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER sessions_updated_at BEFORE UPDATE ON user_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Auto-run GDPR deletion when an order completes for a pending deletion request
CREATE OR REPLACE FUNCTION check_pending_deletion()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IN ('completed','cancelled') THEN
    UPDATE user_sessions
    SET phone = 'DELETED_' || encode(sha256(phone::bytea), 'hex'),
        cart = '[]', preferences = '{}', last_order = NULL
    WHERE phone = NEW.phone AND deletion_requested_at IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER auto_gdpr_deletion AFTER UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION check_pending_deletion();
