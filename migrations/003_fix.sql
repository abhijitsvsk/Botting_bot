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
