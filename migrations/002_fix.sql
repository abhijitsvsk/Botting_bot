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
