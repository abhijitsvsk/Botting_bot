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
