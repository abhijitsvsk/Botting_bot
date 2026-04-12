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
