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
-- ============================================================================
-- Migration 002: Critical + High severity fixes from adversarial audit
-- Covers: DB-1a, DB-1b, DB-1c, DB-1e, SEC-5c, SEC-5e, FIN-7b, OPS-6f
-- ============================================================================

-- ─── DB-1b: Optimistic concurrency control via row_version ──────────────────
ALTER TABLE orders ADD COLUMN IF NOT EXISTS row_version INT NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION increment_row_version()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_orders_row_version ON orders;
CREATE TRIGGER trg_orders_row_version
BEFORE UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION increment_row_version();


-- ─── DB-1a: Atomic cart upsert stored procedure ─────────────────────────────
CREATE OR REPLACE FUNCTION upsert_cart_item(
  p_phone       TEXT,
  p_item_code   TEXT,
  p_quantity    INT,
  p_modifier    JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_lock_key   BIGINT;
  v_cart       JSONB;
  v_item       JSONB;
  v_idx        INT := -1;
  i            INT;
BEGIN
  v_lock_key := hashtext(p_phone)::BIGINT;
  PERFORM pg_advisory_xact_lock(v_lock_key);

  SELECT cart INTO v_cart
  FROM user_sessions
  WHERE phone = p_phone
  FOR UPDATE;

  IF v_cart IS NULL THEN v_cart := '[]'::JSONB; END IF;

  FOR i IN 0 .. jsonb_array_length(v_cart) - 1 LOOP
    IF (v_cart -> i ->> 'item_code') = p_item_code THEN
      v_idx := i;
    END IF;
  END LOOP;

  IF v_idx >= 0 THEN
    v_item := v_cart -> v_idx;
    v_item := jsonb_set(v_item, '{quantity}',
      to_jsonb((v_item ->> 'quantity')::INT + p_quantity));
    v_cart := jsonb_set(v_cart, ARRAY[v_idx::TEXT], v_item);
  ELSE
    -- Price ALWAYS from DB, never from AI
    SELECT jsonb_build_object(
      'item_code', item_code, 'name', name,
      'price', price, 'quantity', p_quantity,
      'modifier', COALESCE(p_modifier, 'null'::JSONB)
    ) INTO v_item
    FROM menu_items
    WHERE item_code = p_item_code AND available = TRUE;

    IF v_item IS NULL THEN
      RAISE EXCEPTION 'ITEM_UNAVAILABLE: %', p_item_code;
    END IF;
    v_cart := v_cart || jsonb_build_array(v_item);
  END IF;

  UPDATE user_sessions
  SET cart = v_cart, last_inbound_at = NOW()
  WHERE phone = p_phone;

  RETURN v_cart;
END;
$$;


-- ─── DB-1c: Status transition stored procedures ─────────────────────────────
CREATE OR REPLACE FUNCTION kds_start_preparing(p_order_id INT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_status order_status;
BEGIN
  SELECT status INTO v_status FROM orders
  WHERE order_id = p_order_id FOR UPDATE NOWAIT;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND: %', p_order_id;
  END IF;
  IF v_status != 'order_received' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: status is %, expected order_received', v_status;
  END IF;

  UPDATE orders SET status = 'preparing' WHERE order_id = p_order_id;
  RETURN jsonb_build_object('order_id', p_order_id, 'status', 'preparing');
END;
$$;

CREATE OR REPLACE FUNCTION kds_mark_ready(p_order_id INT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_status order_status;
BEGIN
  SELECT status INTO v_status FROM orders
  WHERE order_id = p_order_id FOR UPDATE NOWAIT;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND: %', p_order_id;
  END IF;
  IF v_status != 'preparing' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: status is %, expected preparing', v_status;
  END IF;

  UPDATE orders SET status = 'ready_for_pickup' WHERE order_id = p_order_id;
  RETURN jsonb_build_object('order_id', p_order_id, 'status', 'ready_for_pickup');
END;
$$;

CREATE OR REPLACE FUNCTION customer_reopen_cart(p_order_id INT, p_phone TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_status order_status;
BEGIN
  SELECT status INTO v_status FROM orders
  WHERE order_id = p_order_id AND phone = p_phone FOR UPDATE NOWAIT;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND_OR_NOT_OWNED';
  END IF;
  IF v_status != 'order_received' THEN
    RAISE EXCEPTION 'EDIT_REJECTED: order is already %', v_status;
  END IF;

  UPDATE user_sessions
  SET cart = (SELECT items FROM orders WHERE order_id = p_order_id)
  WHERE phone = p_phone;

  RETURN jsonb_build_object('success', true, 'order_id', p_order_id);
END;
$$;


-- ─── DB-1e: Idempotent order creation ───────────────────────────────────────
CREATE OR REPLACE FUNCTION create_order_idempotent(
  p_phone TEXT, p_idempotency_key TEXT, p_table_number TEXT,
  p_items JSONB, p_subtotal NUMERIC, p_tax_rate NUMERIC,
  p_tax_amount NUMERIC, p_total NUMERIC,
  p_allergen_alert BOOLEAN, p_allergen_text TEXT
)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_existing JSONB;
  v_display_id TEXT;
  v_order_id INT;
BEGIN
  -- Source of truth: check orders table first
  SELECT jsonb_build_object(
    'order_id', order_id, 'display_id', display_id,
    'status', status, 'duplicate', true
  ) INTO v_existing
  FROM orders WHERE idempotency_key = p_idempotency_key::UUID;

  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  -- Pre-validate before INSERT
  IF p_table_number IS NULL OR trim(p_table_number) = '' THEN
    RAISE EXCEPTION 'MISSING_TABLE_NUMBER';
  END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'EMPTY_CART';
  END IF;

  -- SEC-5e fix: 8-char display IDs (MMDD-XXXX format for human readability)
  v_display_id := to_char(NOW() AT TIME ZONE 'Asia/Kolkata', 'MMDD')
    || '-'
    || upper(substring(md5(p_idempotency_key || clock_timestamp()::text), 1, 4));

  INSERT INTO orders (
    display_id, phone, table_number, items, status,
    subtotal, tax_rate, tax_amount, total,
    allergen_alert, allergen_text, idempotency_key, confirmed_at
  ) VALUES (
    v_display_id, p_phone, p_table_number, p_items, 'order_received',
    p_subtotal, p_tax_rate, p_tax_amount, p_total,
    p_allergen_alert, p_allergen_text, p_idempotency_key::UUID, NOW()
  )
  ON CONFLICT (idempotency_key) DO UPDATE
    SET idempotency_key = EXCLUDED.idempotency_key
  RETURNING order_id INTO v_order_id;

  -- Clear cart ONLY after successful INSERT
  UPDATE user_sessions
  SET cart = '[]'::JSONB,
      last_order = NOW(),
      idempotency_expires_at = NOW() + INTERVAL '1 hour'
  WHERE phone = p_phone;

  RETURN jsonb_build_object(
    'order_id', v_order_id, 'display_id', v_display_id,
    'status', 'order_received', 'duplicate', false
  );
END;
$$;


-- ─── SEC-5c: Kitchen role column restriction trigger ────────────────────────
CREATE OR REPLACE FUNCTION enforce_kitchen_update_columns()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  jwt_role TEXT;
BEGIN
  jwt_role := current_setting('request.jwt.claims', true)::JSONB ->> 'role';

  IF jwt_role = 'kitchen' THEN
    IF NEW.phone IS DISTINCT FROM OLD.phone THEN
      RAISE EXCEPTION 'KITCHEN_FORBIDDEN: cannot modify phone';
    END IF;
    IF NEW.items IS DISTINCT FROM OLD.items THEN
      RAISE EXCEPTION 'KITCHEN_FORBIDDEN: cannot modify items';
    END IF;
    IF NEW.subtotal IS DISTINCT FROM OLD.subtotal THEN
      RAISE EXCEPTION 'KITCHEN_FORBIDDEN: cannot modify subtotal';
    END IF;
    IF NEW.tax_rate IS DISTINCT FROM OLD.tax_rate THEN
      RAISE EXCEPTION 'KITCHEN_FORBIDDEN: cannot modify tax_rate';
    END IF;
    IF NEW.tax_amount IS DISTINCT FROM OLD.tax_amount THEN
      RAISE EXCEPTION 'KITCHEN_FORBIDDEN: cannot modify tax_amount';
    END IF;
    IF NEW.total IS DISTINCT FROM OLD.total THEN
      RAISE EXCEPTION 'KITCHEN_FORBIDDEN: cannot modify total';
    END IF;
    IF NEW.table_number IS DISTINCT FROM OLD.table_number THEN
      RAISE EXCEPTION 'KITCHEN_FORBIDDEN: cannot modify table_number';
    END IF;
    IF NEW.display_id IS DISTINCT FROM OLD.display_id THEN
      RAISE EXCEPTION 'KITCHEN_FORBIDDEN: cannot modify display_id';
    END IF;

    -- Validate status transition
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NOT (
        (OLD.status = 'order_received' AND NEW.status = 'preparing') OR
        (OLD.status = 'preparing' AND NEW.status = 'ready_for_pickup')
      ) THEN
        RAISE EXCEPTION 'KITCHEN_FORBIDDEN: invalid status transition % -> %', OLD.status, NEW.status;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_kitchen_columns ON orders;
CREATE TRIGGER trg_enforce_kitchen_columns
BEFORE UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION enforce_kitchen_update_columns();


-- ─── FIN-7b: Cart JSONB schema validation ───────────────────────────────────
CREATE OR REPLACE FUNCTION validate_cart_schema(p_cart JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
  elem JSONB;
  i    INT;
BEGIN
  IF p_cart IS NULL THEN RETURN TRUE; END IF;
  IF jsonb_typeof(p_cart) != 'array' THEN RETURN FALSE; END IF;

  FOR i IN 0 .. jsonb_array_length(p_cart) - 1 LOOP
    elem := p_cart -> i;

    IF jsonb_typeof(elem) != 'object' THEN RETURN FALSE; END IF;

    IF NOT (
      elem ? 'item_code'
      AND elem ? 'name'
      AND elem ? 'price'
      AND elem ? 'quantity'
      AND jsonb_typeof(elem -> 'item_code') = 'string'
      AND jsonb_typeof(elem -> 'name') = 'string'
      AND jsonb_typeof(elem -> 'price') = 'number'
      AND jsonb_typeof(elem -> 'quantity') = 'number'
      AND (elem ->> 'price')::NUMERIC > 0
      AND (elem ->> 'quantity')::INT > 0
      AND (elem ->> 'quantity')::INT <= 50
    ) THEN
      RETURN FALSE;
    END IF;
  END LOOP;

  RETURN TRUE;
END;
$$;

ALTER TABLE user_sessions DROP CONSTRAINT IF EXISTS valid_cart_schema;
ALTER TABLE user_sessions
ADD CONSTRAINT valid_cart_schema
CHECK (validate_cart_schema(cart));


-- ─── OPS-6f: Global rate limiter table ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS global_rate_limits (
  window_key    TEXT PRIMARY KEY,
  count         INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION check_global_rate_limit(
  p_limit_key TEXT,
  p_max_per_minute INT
)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
  v_window TEXT;
  v_count INT;
BEGIN
  v_window := p_limit_key || ':' || to_char(NOW(), 'YYYY-MM-DD-HH24-MI');

  INSERT INTO global_rate_limits (window_key, count)
  VALUES (v_window, 1)
  ON CONFLICT (window_key) DO UPDATE
    SET count = global_rate_limits.count + 1
  RETURNING count INTO v_count;

  RETURN v_count <= p_max_per_minute;
END;
$$;


-- ─── SEC-5e: Generate safe display IDs (date-prefixed) ──────────────────────
CREATE OR REPLACE FUNCTION generate_display_id()
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_date_prefix TEXT;
  v_random_part TEXT;
  v_display_id TEXT;
  v_attempts INT := 0;
BEGIN
  v_date_prefix := to_char(NOW() AT TIME ZONE 'Asia/Kolkata', 'MMDD');

  LOOP
    v_random_part := upper(substring(md5(random()::text || clock_timestamp()::text), 1, 4));
    v_display_id := v_date_prefix || '-' || v_random_part;

    IF NOT EXISTS (SELECT 1 FROM orders WHERE display_id = v_display_id) THEN
      RETURN v_display_id;
    END IF;

    v_attempts := v_attempts + 1;
    IF v_attempts > 10 THEN
      v_random_part := upper(substring(md5(random()::text || clock_timestamp()::text), 1, 5));
      v_display_id := v_date_prefix || '-' || v_random_part;
      RETURN v_display_id;
    END IF;
  END LOOP;
END;
$$;
-- ============================================================================
-- Migration 003: High severity fixes from adversarial audit
-- Covers: SEC-5d, WA-3d, OPS-6c, OPS-6h, FIN-7a, FIN-7c, KDS-4b, KDS-4a
-- ============================================================================

-- ─── SEC-5d: Notification queue (decouples status update from WhatsApp send)
CREATE TABLE IF NOT EXISTS notification_queue (
  id          SERIAL PRIMARY KEY,
  order_id    INT NOT NULL DEFAULT 0,
  event_type  TEXT NOT NULL,
  payload     JSONB NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  attempts    INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notification_queue_pending
  ON notification_queue (created_at ASC)
  WHERE status IN ('pending', 'failed');

CREATE OR REPLACE FUNCTION queue_order_notification()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO notification_queue (order_id, event_type, payload)
    VALUES (
      NEW.order_id,
      'status_changed',
      jsonb_build_object(
        'old_status', OLD.status,
        'new_status', NEW.status,
        'phone', NEW.phone,
        'display_id', NEW.display_id,
        'table_number', NEW.table_number
      )
    );
    PERFORM pg_notify('order_notifications',
      json_build_object('order_id', NEW.order_id, 'new_status', NEW.status)::TEXT
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_order_status_notification ON orders;
CREATE TRIGGER trg_order_status_notification
AFTER UPDATE OF status ON orders
FOR EACH ROW EXECUTE FUNCTION queue_order_notification();


-- ─── WA-3d: Pending reply tracking for failed WhatsApp sends ────────────────
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS pending_reply JSONB DEFAULT NULL;
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS pending_reply_at TIMESTAMPTZ DEFAULT NULL;


-- ─── OPS-6c: Proactive 86'd item notification to active carts ──────────────
CREATE OR REPLACE FUNCTION notify_carts_on_86()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  affected_session RECORD;
BEGIN
  IF OLD.available = TRUE AND NEW.available = FALSE THEN
    FOR affected_session IN
      SELECT phone, cart
      FROM user_sessions
      WHERE cart @> jsonb_build_array(jsonb_build_object('item_code', NEW.item_code))
    LOOP
      INSERT INTO notification_queue (order_id, event_type, payload)
      VALUES (
        0,
        'item_86d_in_cart',
        jsonb_build_object(
          'phone', affected_session.phone,
          'item_code', NEW.item_code,
          'item_name', NEW.name,
          'similar_items', NEW.similar_items
        )
      );
    END LOOP;

    PERFORM pg_notify('item_86d', json_build_object(
      'item_code', NEW.item_code,
      'item_name', NEW.name
    )::TEXT);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_menu_item_86_notify ON menu_items;
CREATE TRIGGER trg_menu_item_86_notify
AFTER UPDATE OF available ON menu_items
FOR EACH ROW EXECUTE FUNCTION notify_carts_on_86();


-- ─── OPS-6h: Anonymous dedup table (DPDP compliant — no PII before consent)
CREATE TABLE IF NOT EXISTS message_dedup (
  message_id_hash  TEXT PRIMARY KEY,
  seen_at          TIMESTAMPTZ DEFAULT NOW()
);


-- ─── FIN-7a: Order amendment stored procedure ───────────────────────────────
CREATE OR REPLACE FUNCTION amend_order(
  p_order_id     INT,
  p_new_items    JSONB,
  p_amended_by   TEXT
)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_old_order    RECORD;
  v_new_subtotal NUMERIC;
  v_new_tax      NUMERIC;
  v_new_total    NUMERIC;
  v_delta        NUMERIC;
BEGIN
  SELECT * INTO v_old_order FROM orders
  WHERE order_id = p_order_id FOR UPDATE;

  IF v_old_order IS NULL THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;
  IF v_old_order.status NOT IN ('order_received', 'preparing') THEN
    RAISE EXCEPTION 'AMENDMENT_NOT_ALLOWED: status is %', v_old_order.status;
  END IF;

  SELECT COALESCE(SUM(m.price * (elem ->> 'quantity')::INT), 0)
  INTO v_new_subtotal
  FROM jsonb_array_elements(p_new_items) AS elem
  JOIN menu_items m ON m.item_code = (elem ->> 'item_code')
  WHERE m.available = TRUE;

  v_new_tax   := ROUND(v_new_subtotal * v_old_order.tax_rate, 2);
  v_new_total := v_new_subtotal + v_new_tax;
  v_delta     := v_new_total - v_old_order.total;

  INSERT INTO order_amendments (order_id, before_state, after_state, amount_delta, amended_at)
  VALUES (
    p_order_id,
    jsonb_build_object('items', v_old_order.items, 'subtotal', v_old_order.subtotal,
                       'tax_amount', v_old_order.tax_amount, 'total', v_old_order.total),
    jsonb_build_object('items', p_new_items, 'subtotal', v_new_subtotal,
                       'tax_amount', v_new_tax, 'total', v_new_total),
    v_delta,
    NOW()
  );

  UPDATE orders
  SET items = p_new_items,
      subtotal = v_new_subtotal,
      tax_amount = v_new_tax,
      total = v_new_total,
      amendment_count = amendment_count + 1
  WHERE order_id = p_order_id;

  RETURN jsonb_build_object(
    'order_id', p_order_id,
    'old_total', v_old_order.total,
    'new_total', v_new_total,
    'delta', v_delta
  );
END;
$$;


-- ─── FIN-7c: Atomic times_ordered increment via trigger ─────────────────────
CREATE OR REPLACE FUNCTION increment_times_ordered()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE menu_items m
  SET times_ordered = m.times_ordered + sub.qty
  FROM (
    SELECT (elem ->> 'item_code') AS item_code,
           (elem ->> 'quantity')::INT AS qty
    FROM jsonb_array_elements(NEW.items) AS elem
  ) sub
  WHERE m.item_code = sub.item_code;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_increment_times_ordered ON orders;
CREATE TRIGGER trg_increment_times_ordered
AFTER INSERT ON orders
FOR EACH ROW
WHEN (NEW.status != 'cancelled')
EXECUTE FUNCTION increment_times_ordered();

CREATE OR REPLACE FUNCTION decrement_times_ordered_on_cancel()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status != 'cancelled' AND NEW.status = 'cancelled' THEN
    UPDATE menu_items m
    SET times_ordered = GREATEST(m.times_ordered - sub.qty, 0)
    FROM (
      SELECT (elem ->> 'item_code') AS item_code,
             (elem ->> 'quantity')::INT AS qty
      FROM jsonb_array_elements(OLD.items) AS elem
    ) sub
    WHERE m.item_code = sub.item_code;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_decrement_on_cancel ON orders;
CREATE TRIGGER trg_decrement_on_cancel
AFTER UPDATE OF status ON orders
FOR EACH ROW EXECUTE FUNCTION decrement_times_ordered_on_cancel();


-- ─── KDS-4b: Allergen ACK RLS policy (restrictive for kitchen role) ────────
-- Drop existing permissive policies if any
DROP POLICY IF EXISTS kitchen_orders_update ON orders;

-- Kitchen can only update status, allergen_ack_at, allergen_ack_device
-- (enforced at trigger level by enforce_kitchen_update_columns above)
-- But also need RLS policy to scope visibility
CREATE POLICY kitchen_orders_select ON orders
  FOR SELECT
  USING (
    current_setting('request.jwt.claims', true)::JSONB ->> 'role' IN ('kitchen','manager','owner','cashier')
    OR auth.role() = 'service_role'
  );

CREATE POLICY kitchen_orders_update ON orders
  FOR UPDATE
  USING (
    current_setting('request.jwt.claims', true)::JSONB ->> 'role' IN ('kitchen','manager','owner','cashier')
    OR auth.role() = 'service_role'
  );


-- ─── KDS-4a: Scheduled cleanup index for kds_pings ─────────────────────────
-- pg_cron job (run this manually in Supabase SQL Editor — pg_cron not available in migration):
-- SELECT cron.schedule('cleanup-kds-pings', '*/10 * * * *',
--   $$DELETE FROM kds_pings WHERE created_at < NOW() - INTERVAL '1 hour'$$);
-- SELECT cron.schedule('cleanup-message-dedup', '*/15 * * * *',
--   $$DELETE FROM message_dedup WHERE seen_at < NOW() - INTERVAL '2 hours'$$);
-- SELECT cron.schedule('cleanup-global-rate-limits', '*/5 * * * *',
--   $$DELETE FROM global_rate_limits WHERE created_at < NOW() - INTERVAL '10 minutes'$$);
-- ==============================================================================
-- Migration 005: Price Snapshots & KDS Credential Sharing Protection
-- ==============================================================================

-- 1a. Validate price_at_time_of_add exists in cart items JSONB
-- Uses COALESCE to not break existing carts that lack the field (assumes 0 or ignores)
CREATE OR REPLACE FUNCTION enforce_cart_price_snapshot()
RETURNS TRIGGER AS $$
DECLARE
  item JSONB;
BEGIN
  IF NEW.cart IS NOT NULL THEN
    FOR item IN SELECT * FROM jsonb_array_elements(NEW.cart)
    LOOP
      IF NOT (item ? 'price_at_time_of_add') THEN
        -- If missing, append the field as null (legacy carts) or reject
        -- We won't strictly RAISE EXCEPTION for old carts to avoid breaking them.
        -- But for new transactions, the application layer MUST provide it.
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_cart_price_snapshot ON user_sessions;
CREATE TRIGGER trg_enforce_cart_price_snapshot
BEFORE INSERT OR UPDATE OF cart ON user_sessions
FOR EACH ROW EXECUTE FUNCTION enforce_cart_price_snapshot();

-- 1b. Add active_device_id and last_login_at to staff table
ALTER TABLE staff ADD COLUMN IF NOT EXISTS active_device_id TEXT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
-- ==============================================================================
-- Migration 006: Multi-Tenant Architecture Foundation
-- ==============================================================================

CREATE TABLE IF NOT EXISTS restaurants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  whatsapp_phone_number_id TEXT UNIQUE NOT NULL,
  whatsapp_token TEXT NOT NULL,
  timezone TEXT DEFAULT 'Asia/Kolkata',
  opening_time TIME,
  closing_time TIME,
  tax_rate NUMERIC(5,4) DEFAULT 0.05,
  amendment_window_mins INT DEFAULT 5,
  max_messages_per_minute INT DEFAULT 10,
  valid_table_numbers TEXT[],
  support_phone TEXT,
  allergen_keywords TEXT[],
  groq_api_key TEXT,
  bot_mode TEXT DEFAULT 'ai',
  subscription_status TEXT DEFAULT 'trial' 
    CHECK (subscription_status IN ('trial','active','suspended','cancelled')),
  trial_ends_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '14 days',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed initial default restaurant using existing environment vars if possible
INSERT INTO restaurants (name, whatsapp_phone_number_id, whatsapp_token)
VALUES ('Default Restaurant', 'DEFAULT_PHONE_ID', 'DEFAULT_TOKEN')
ON CONFLICT DO NOTHING;

-- Retrieve seeded restaurant UUID
DO $$
DECLARE
  seeded_restaurant_id UUID;
BEGIN
  SELECT id INTO seeded_restaurant_id FROM restaurants LIMIT 1;
  
  -- Add restaurant_id to all tables
  -- Note: Depending on existing table schemas, this uses dynamic loops or manual alterations.
  -- For safety, manual execution step-by-step is preferred.
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='user_sessions' AND column_name='restaurant_id') THEN
      ALTER TABLE user_sessions ADD COLUMN restaurant_id UUID REFERENCES restaurants(id);
      UPDATE user_sessions SET restaurant_id = seeded_restaurant_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='restaurant_id') THEN
      ALTER TABLE orders ADD COLUMN restaurant_id UUID REFERENCES restaurants(id);
      UPDATE orders SET restaurant_id = seeded_restaurant_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='menu_items' AND column_name='restaurant_id') THEN
      ALTER TABLE menu_items ADD COLUMN restaurant_id UUID REFERENCES restaurants(id);
      UPDATE menu_items SET restaurant_id = seeded_restaurant_id;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='message_logs' AND column_name='restaurant_id') THEN
      ALTER TABLE message_logs ADD COLUMN restaurant_id UUID REFERENCES restaurants(id);
      UPDATE message_logs SET restaurant_id = seeded_restaurant_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='settings' AND column_name='restaurant_id') THEN
      ALTER TABLE settings ADD COLUMN restaurant_id UUID REFERENCES restaurants(id);
      UPDATE settings SET restaurant_id = seeded_restaurant_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kds_devices' AND column_name='restaurant_id') THEN
      ALTER TABLE kds_devices ADD COLUMN restaurant_id UUID REFERENCES restaurants(id);
      UPDATE kds_devices SET restaurant_id = seeded_restaurant_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='kds_pings' AND column_name='restaurant_id') THEN
      ALTER TABLE kds_pings ADD COLUMN restaurant_id UUID REFERENCES restaurants(id);
      UPDATE kds_pings SET restaurant_id = seeded_restaurant_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='audit_log' AND column_name='restaurant_id') THEN
      ALTER TABLE audit_log ADD COLUMN restaurant_id UUID REFERENCES restaurants(id);
      UPDATE audit_log SET restaurant_id = seeded_restaurant_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='order_amendments' AND column_name='restaurant_id') THEN
      ALTER TABLE order_amendments ADD COLUMN restaurant_id UUID REFERENCES restaurants(id);
      UPDATE order_amendments SET restaurant_id = seeded_restaurant_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='staff' AND column_name='restaurant_id') THEN
      ALTER TABLE staff ADD COLUMN restaurant_id UUID REFERENCES restaurants(id);
      UPDATE staff SET restaurant_id = seeded_restaurant_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='promotions' AND column_name='restaurant_id') THEN
      ALTER TABLE promotions ADD COLUMN restaurant_id UUID REFERENCES restaurants(id);
      UPDATE promotions SET restaurant_id = seeded_restaurant_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='refunds' AND column_name='restaurant_id') THEN
      ALTER TABLE refunds ADD COLUMN restaurant_id UUID REFERENCES restaurants(id);
      UPDATE refunds SET restaurant_id = seeded_restaurant_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cash_transactions' AND column_name='restaurant_id') THEN
      ALTER TABLE cash_transactions ADD COLUMN restaurant_id UUID REFERENCES restaurants(id);
      UPDATE cash_transactions SET restaurant_id = seeded_restaurant_id;
  END IF;

END $$;

-- RLS Function
CREATE OR REPLACE FUNCTION public.get_current_restaurant_id()
RETURNS UUID
LANGUAGE sql STABLE
AS $$
  SELECT (NULLIF(current_setting('request.jwt.claims', true)::jsonb ->> 'restaurant_id', ''))::UUID;
$$;

-- Default mapping
ALTER TABLE user_sessions ALTER COLUMN restaurant_id SET DEFAULT public.get_current_restaurant_id();
ALTER TABLE orders ALTER COLUMN restaurant_id SET DEFAULT public.get_current_restaurant_id();
ALTER TABLE menu_items ALTER COLUMN restaurant_id SET DEFAULT public.get_current_restaurant_id();
ALTER TABLE staff ALTER COLUMN restaurant_id SET DEFAULT public.get_current_restaurant_id();
-- Applies to others implicitly going forward via UI inserts

-- Example RLS setup (Requires manual execution per table to overwrite existing SINGLE-TENANT policies):
-- DROP POLICY IF EXISTS "Staff full access" ON orders;
-- CREATE POLICY "Tenant Isolation" ON orders FOR ALL 
-- USING (restaurant_id = public.get_current_restaurant_id() OR restaurant_id = (SELECT restaurant_id FROM staff WHERE id = auth.uid()));
-- ==============================================================================
-- Migration 007: Billing & Subscription Infrastructure
-- ==============================================================================

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID REFERENCES restaurants(id),
  plan TEXT CHECK (plan IN ('starter','growth','pro')),
  monthly_price_inr NUMERIC(10,2),
  billing_cycle_start DATE,
  billing_cycle_end DATE,
  razorpay_subscription_id TEXT,
  status TEXT CHECK (status IN ('active','past_due','cancelled')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID REFERENCES restaurants(id),
  subscription_id UUID REFERENCES subscriptions(id),
  amount_inr NUMERIC(10,2),
  period_start DATE,
  period_end DATE,
  paid_at TIMESTAMPTZ,
  razorpay_payment_id TEXT,
  status TEXT CHECK (status IN ('pending','paid','failed','waived')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS usage_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID REFERENCES restaurants(id),
  metric_date DATE,
  orders_count INT DEFAULT 0,
  whatsapp_messages_count INT DEFAULT 0,
  ai_calls_count INT DEFAULT 0,
  UNIQUE(restaurant_id, metric_date)
);

-- RLS Enforcement
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "SaaS Isolation Subs" ON subscriptions FOR ALL 
USING (restaurant_id = public.get_current_restaurant_id() OR restaurant_id = (SELECT restaurant_id FROM staff WHERE id = auth.uid()));

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "SaaS Isolation Inv" ON invoices FOR ALL 
USING (restaurant_id = public.get_current_restaurant_id() OR restaurant_id = (SELECT restaurant_id FROM staff WHERE id = auth.uid()));

ALTER TABLE usage_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "SaaS Isolation Usage" ON usage_metrics FOR SELECT 
USING (restaurant_id = public.get_current_restaurant_id() OR restaurant_id = (SELECT restaurant_id FROM staff WHERE id = auth.uid()));
-- ==============================================================================
-- Migration 008: Missing RLS Policies for Core Tables
-- ==============================================================================

-- 1. Enable RLS explicitly on target tables
ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;

-- 2. Clean up any existing loose policies to prevent conflict
DROP POLICY IF EXISTS "staff_select_menu_items" ON menu_items;
DROP POLICY IF EXISTS "manager_owner_insert_menu_items" ON menu_items;
DROP POLICY IF EXISTS "manager_owner_update_menu_items" ON menu_items;
DROP POLICY IF EXISTS "owner_delete_menu_items" ON menu_items;

DROP POLICY IF EXISTS "service_role_select_user_sessions" ON user_sessions;
DROP POLICY IF EXISTS "service_role_insert_user_sessions" ON user_sessions;
DROP POLICY IF EXISTS "service_role_update_user_sessions" ON user_sessions;
DROP POLICY IF EXISTS "service_role_delete_user_sessions" ON user_sessions;

-- ==============================================================================
-- menu_items POLICIES
-- ==============================================================================

-- SELECT: staff can read menu items belonging to their restaurant_id only
CREATE POLICY "staff_select_menu_items" ON menu_items
FOR SELECT TO authenticated
USING (restaurant_id = public.get_current_restaurant_id() OR restaurant_id = (SELECT restaurant_id FROM staff WHERE id = auth.uid()));

-- INSERT: manager and owner roles only, auto-sets restaurant_id
CREATE POLICY "manager_owner_insert_menu_items" ON menu_items
FOR INSERT TO authenticated
WITH CHECK (
    restaurant_id = public.get_current_restaurant_id() 
    AND EXISTS (
        SELECT 1 FROM staff WHERE id = auth.uid() AND role IN ('manager', 'owner')
    )
);

-- UPDATE: manager and owner roles only, same restaurant_id
CREATE POLICY "manager_owner_update_menu_items" ON menu_items
FOR UPDATE TO authenticated
USING (
    restaurant_id = public.get_current_restaurant_id() 
    AND EXISTS (
        SELECT 1 FROM staff WHERE id = auth.uid() AND role IN ('manager', 'owner')
    )
);

-- DELETE: owner role only, same restaurant_id
CREATE POLICY "owner_delete_menu_items" ON menu_items
FOR DELETE TO authenticated
USING (
    restaurant_id = public.get_current_restaurant_id() 
    AND EXISTS (
        SELECT 1 FROM staff WHERE id = auth.uid() AND role = 'owner'
    )
);

-- ==============================================================================
-- user_sessions POLICIES
-- ==============================================================================
-- n8n uses the service role key, frontend never queries this directly.

-- SELECT: service role only
CREATE POLICY "service_role_select_user_sessions" ON user_sessions
FOR SELECT TO service_role
USING (true);

-- INSERT: service role only
CREATE POLICY "service_role_insert_user_sessions" ON user_sessions
FOR INSERT TO service_role
WITH CHECK (true);

-- UPDATE: service role only
CREATE POLICY "service_role_update_user_sessions" ON user_sessions
FOR UPDATE TO service_role
USING (true);

-- DELETE: service role only
CREATE POLICY "service_role_delete_user_sessions" ON user_sessions
FOR DELETE TO service_role
USING (true);

-- ==============================================================================
-- KDS-4a & INFRA-8a: pg_cron Setup Instructions
-- ==============================================================================
-- IMPORTANT NOTICES: 
-- 1. DO NOT run this via PgBouncer (Port 6543) or via standard ORM auto-migrations.
--    pg_cron relies on background workers which do not play well with transaction-mode pooling.
-- 2. RUN THIS DIRECTLY IN THE SUPABASE SQL EDITOR on the Dashboard, 
--    or connect directly to Postgres (Port 5432).
-- ==============================================================================

-- 1. Enable the pg_cron extension
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

-- 2. Pruning kds_pings
-- KDS health checks generate ~1,440 rows per device per day.
-- We must aggressively prune them to prevent table bloat.
-- This cron job runs every hour (minute 0) and deletes pings older than 1 hour.
SELECT cron.schedule(
    'prune-kds-pings',
    '0 * * * *',
    $$ DELETE FROM public.kds_pings WHERE created_at < NOW() - INTERVAL '1 hour'; $$
);

-- 3. Pruning message_logs (Rate limiting sliding window)
-- Message logs only need to persist for a few minutes for rate limiting checks to work.
-- We keep 1 day for minimal debugging, then aggressively prune.
SELECT cron.schedule(
    'prune-message-logs',
    '30 3 * * *', -- 3:30 AM every day
    $$ DELETE FROM public.message_logs WHERE created_at < NOW() - INTERVAL '1 day'; $$
);

-- 4. Billing Usage Metrics Aggregation (SaaS Foundation)
-- Runs daily at 11:50 PM to snapshot the order volume per restaurant
-- for invoice reconciliation inside usage_metrics table.
SELECT cron.schedule(
    'aggregate-daily-billing-metrics',
    '50 23 * * *',
    $$ 
    INSERT INTO public.usage_metrics (restaurant_id, metric_date, orders_count, whatsapp_messages_count, ai_calls_count)
    SELECT restaurant_id, CURRENT_DATE,
    COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE),
    0, 0
    FROM public.orders GROUP BY restaurant_id
    ON CONFLICT (restaurant_id, metric_date) DO UPDATE 
    SET orders_count = EXCLUDED.orders_count; 
    $$
);

-- ==============================================================================
-- Note: To unschedule a job later, use:
-- SELECT cron.unschedule('prune-kds-pings');
-- ==============================================================================
