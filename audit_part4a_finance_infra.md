# Adversarial System Audit — Part 4a of 4
## Categories 7 & 8: Data Integrity/Financial + Deployment/Infrastructure

---

# CATEGORY 7: DATA INTEGRITY & FINANCIAL ACCURACY

---

## ISSUE ID: FIN-7a
**SEVERITY: High**
**TITLE: Multiple order amendments produce cumulative deltas — ledger query must sum all deltas, not just the latest**

### FAILURE SCENARIO
Customer confirms order (total ₹500). Amendment 1: removes an item → `amount_delta = -100`. Amendment 2: adds a different item → `amount_delta = +60`. Two rows in `order_amendments`. The final amount owed is ₹500 - ₹100 + ₹60 = ₹460. But a naive query that only reads `orders.total` would return ₹500 (the original, pre-amendment total) if amendments don't update the order row.

### EXACT ERROR OR SYMPTOM
If `orders.total` is not updated on each amendment: Reports show wrong revenue. Cashier collects wrong amount. If `orders.total` IS updated on each amendment: total is ₹460 (correct), but the `order_amendments` table is the only record of what changed. A query that sums `amount_delta` without checking if the original total was already updated would double-count.

### ROOT CAUSE
Ambiguity in where the "final amount" lives — is it `orders.total` (latest state) or `orders.original_total + SUM(order_amendments.amount_delta)` (computed)?

### PERMANENT FIX

Always update `orders.total` on each amendment AND store deltas for audit trail. The source of truth for "what to charge" is always `orders.total`. The amendments table is the audit trail.

```sql
-- Stored procedure for order amendment
CREATE OR REPLACE FUNCTION amend_order(
  p_order_id     INT,
  p_new_items    JSONB,
  p_amended_by   TEXT  -- 'customer' or staff_id
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

  -- Calculate new totals from new items (prices from DB)
  SELECT COALESCE(SUM(m.price * (elem ->> 'quantity')::INT), 0)
  INTO v_new_subtotal
  FROM jsonb_array_elements(p_new_items) AS elem
  JOIN menu_items m ON m.item_code = (elem ->> 'item_code')
  WHERE m.available = TRUE;

  v_new_tax   := ROUND(v_new_subtotal * v_old_order.tax_rate, 2);
  v_new_total := v_new_subtotal + v_new_tax;
  v_delta     := v_new_total - v_old_order.total;

  -- Record amendment
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

  -- Update the order with new totals
  UPDATE orders
  SET items = p_new_items,
      subtotal = v_new_subtotal,
      tax_amount = v_new_tax,
      total = v_new_total
  WHERE order_id = p_order_id;

  RETURN jsonb_build_object(
    'order_id', p_order_id,
    'old_total', v_old_order.total,
    'new_total', v_new_total,
    'delta', v_delta
  );
END;
$$;

-- Query: final amount owed (always orders.total — it's the live value)
-- Verification query (cross-check):
SELECT
  o.order_id,
  o.total AS current_total,
  COALESCE(
    (SELECT (a.before_state ->> 'total')::NUMERIC
     FROM order_amendments a WHERE a.order_id = o.order_id ORDER BY a.amended_at ASC LIMIT 1),
    o.total
  ) AS original_total,
  COALESCE(SUM(a.amount_delta), 0) AS total_deltas,
  o.total =
    COALESCE(
      (SELECT (a2.before_state ->> 'total')::NUMERIC
       FROM order_amendments a2 WHERE a2.order_id = o.order_id ORDER BY a2.amended_at ASC LIMIT 1),
      o.total
    ) + COALESCE(SUM(a.amount_delta), 0) AS ledger_balanced
FROM orders o
LEFT JOIN order_amendments a ON a.order_id = o.order_id
GROUP BY o.order_id, o.total;
-- ledger_balanced should be TRUE for every row
```

### VERIFICATION TEST
```bash
psql $PGB_URL -c "
-- Create order at ₹500
INSERT INTO orders (display_id,phone,table_number,items,status,subtotal,tax_rate,tax_amount,total,idempotency_key,confirmed_at)
VALUES ('AM01','+91T','T1','[{\"item_code\":\"D01\",\"quantity\":5,\"price\":100}]','order_received',500,0.05,25,525,'AMEND01',NOW());

-- Amendment 1: remove 1 item (new total = ₹400 + tax)
SELECT amend_order(currval('orders_order_id_seq')::INT, '[{\"item_code\":\"D01\",\"quantity\":4}]', 'customer');

-- Amendment 2: add coffee (new total = ₹450 + tax)
SELECT amend_order(currval('orders_order_id_seq')::INT, '[{\"item_code\":\"D01\",\"quantity\":4},{\"item_code\":\"C01\",\"quantity\":1}]', 'customer');

-- Verify ledger balance
SELECT order_id, total, ledger_balanced FROM (
  SELECT o.order_id, o.total,
    o.total = COALESCE((SELECT (a2.before_state->>'total')::NUMERIC FROM order_amendments a2 WHERE a2.order_id=o.order_id ORDER BY a2.amended_at ASC LIMIT 1), o.total) + COALESCE(SUM(a.amount_delta),0) AS ledger_balanced
  FROM orders o LEFT JOIN order_amendments a ON a.order_id=o.order_id
  GROUP BY o.order_id, o.total
) sub;
-- PASS: ledger_balanced = true"
```

### PREVENTION
Nightly check: run the verification query, alert if any `ledger_balanced = false`.

---

## ISSUE ID: FIN-7b
**SEVERITY: High**
**TITLE: No schema validation on cart JSONB — corrupted cart structure causes checkout crash**

### FAILURE SCENARIO
A Groq hallucination slips past the DB cross-check (e.g., returns valid item_code but with quantity as a string "two" instead of integer 2). Or a mid-write failure leaves a partially constructed JSONB object in the cart column. The cart is stored as `[{"item_code":"D01","name":"Dosa","price":"sixty","quantity":"two"}]` — prices and quantities as strings rather than numbers.

### EXACT ERROR OR SYMPTOM
At checkout, the subtotal calculation does `SUM(price * quantity)` — both are strings, multiplication either fails with `ERROR: operator does not exist: text * text` or, if JS-side, silently produces `NaN`. The order is created with `subtotal = NaN`, `total = NaN`. Financial data is corrupted.

### PERMANENT FIX

```sql
-- PostgreSQL function to validate cart JSONB schema
CREATE OR REPLACE FUNCTION validate_cart_schema(p_cart JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
  elem JSONB;
  i    INT;
BEGIN
  -- Null or empty array are valid (empty cart)
  IF p_cart IS NULL THEN RETURN TRUE; END IF;
  IF jsonb_typeof(p_cart) != 'array' THEN RETURN FALSE; END IF;

  FOR i IN 0 .. jsonb_array_length(p_cart) - 1 LOOP
    elem := p_cart -> i;

    -- Must be an object
    IF jsonb_typeof(elem) != 'object' THEN RETURN FALSE; END IF;

    -- Required fields with correct types
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
      AND (elem ->> 'quantity')::INT <= 50  -- sanity max
    ) THEN
      RETURN FALSE;
    END IF;
  END LOOP;

  RETURN TRUE;
END;
$$;

-- CHECK constraint on user_sessions
ALTER TABLE user_sessions
ADD CONSTRAINT valid_cart_schema
CHECK (validate_cart_schema(cart));
```

JSON Schema definition (for documentation and client-side validation):
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "array",
  "items": {
    "type": "object",
    "required": ["item_code", "name", "price", "quantity"],
    "properties": {
      "item_code": { "type": "string", "minLength": 1, "maxLength": 20 },
      "name":      { "type": "string", "minLength": 1, "maxLength": 100 },
      "price":     { "type": "number", "minimum": 0.01, "maximum": 100000 },
      "quantity":  { "type": "integer", "minimum": 1, "maximum": 50 },
      "modifier":  { "type": ["object", "null"] }
    },
    "additionalProperties": false
  }
}
```

### VERIFICATION TEST
```bash
# Valid cart — should succeed
psql $PGB_URL -c "
UPDATE user_sessions SET cart='[{\"item_code\":\"D01\",\"name\":\"Dosa\",\"price\":60,\"quantity\":1}]' WHERE phone='+91TEST';"
# PASS: update succeeds

# Invalid cart (price as string) — should fail
psql $PGB_URL -c "
UPDATE user_sessions SET cart='[{\"item_code\":\"D01\",\"name\":\"Dosa\",\"price\":\"sixty\",\"quantity\":1}]' WHERE phone='+91TEST';"
# PASS: ERROR violates check constraint "valid_cart_schema"

# Invalid cart (quantity 0) — should fail
psql $PGB_URL -c "
UPDATE user_sessions SET cart='[{\"item_code\":\"D01\",\"name\":\"Dosa\",\"price\":60,\"quantity\":0}]' WHERE phone='+91TEST';"
# PASS: ERROR violates check constraint
```

### PREVENTION
The CHECK constraint enforces schema on every write. No additional monitoring needed — invalid writes are structurally impossible once the constraint is active.

---

## ISSUE ID: FIN-7c
**SEVERITY: Medium**
**TITLE: times_ordered increment in n8n is non-atomic — n8n crash between INSERT and UPDATE permanently skews popularity data**

### FAILURE SCENARIO
Order INSERT succeeds. n8n proceeds to the next node: `UPDATE menu_items SET times_ordered = times_ordered + 1 WHERE item_code = ANY(...)`. n8n crashes (OOM, node timeout, uncaught exception). The `times_ordered` increment is lost. Over months, some items show lower popularity than reality. Menu optimization decisions based on this data are wrong.

### PERMANENT FIX

```sql
-- Trigger: automatically increment times_ordered on order INSERT
CREATE OR REPLACE FUNCTION increment_times_ordered()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Extract item_codes and quantities from the new order's items JSONB
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

CREATE TRIGGER trg_increment_times_ordered
AFTER INSERT ON orders
FOR EACH ROW
WHEN (NEW.status != 'cancelled')
EXECUTE FUNCTION increment_times_ordered();

-- Also handle cancellations (decrement):
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

CREATE TRIGGER trg_decrement_on_cancel
AFTER UPDATE OF status ON orders
FOR EACH ROW EXECUTE FUNCTION decrement_times_ordered_on_cancel();
```

Remove the n8n increment node (it's now redundant).

### VERIFICATION TEST
```bash
# Check current count
psql $PGB_URL -c "SELECT item_code, times_ordered FROM menu_items WHERE item_code='D01';"
# Note the value, say N

# Insert an order with D01 x3
psql $PGB_URL -c "
INSERT INTO orders (display_id,phone,table_number,items,status,subtotal,tax_rate,tax_amount,total,idempotency_key,confirmed_at)
VALUES ('TO01','+91T','T1','[{\"item_code\":\"D01\",\"quantity\":3}]','order_received',300,0.05,15,315,'TRIG01',NOW());"

# Check count again
psql $PGB_URL -c "SELECT item_code, times_ordered FROM menu_items WHERE item_code='D01';"
# PASS: times_ordered = N + 3 (incremented by trigger, not n8n)
```

### PREVENTION
Periodic reconciliation: `SELECT m.item_code, m.times_ordered, COALESCE(SUM((elem->>'quantity')::INT),0) AS actual FROM menu_items m LEFT JOIN LATERAL (SELECT jsonb_array_elements(o.items) AS elem FROM orders o WHERE o.status!='cancelled') sub ON (sub.elem->>'item_code')=m.item_code GROUP BY m.item_code, m.times_ordered HAVING m.times_ordered != COALESCE(SUM((elem->>'quantity')::INT),0)` — detect drift.

---

## ISSUE ID: FIN-7d
**SEVERITY: High**
**TITLE: Reports page includes cancelled orders in Total Revenue — overstates revenue**

### FAILURE SCENARIO
Reports page query: `SELECT SUM(total) FROM orders WHERE confirmed_at BETWEEN $1 AND $2`. Cancelled orders are included. If 10% of orders are cancelled, revenue is overstated by 10%.

### PERMANENT FIX

```sql
-- === Correct Report Queries ===

-- 1. Total Revenue (EXCLUDES cancelled orders)
SELECT SUM(total) AS total_revenue
FROM orders
WHERE status NOT IN ('cancelled')
  AND confirmed_at >= $1 AND confirmed_at < $2;

-- 2. Tax Reserves (EXCLUDES cancelled — tax was never collected)
SELECT SUM(tax_amount) AS tax_reserves
FROM orders
WHERE status NOT IN ('cancelled')
  AND confirmed_at >= $1 AND confirmed_at < $2;

-- 3. Completed Tickets (only fully completed orders)
SELECT COUNT(*) AS completed_tickets
FROM orders
WHERE status = 'completed'
  AND confirmed_at >= $1 AND confirmed_at < $2;

-- 4. Gross Average Order Value (excludes cancelled)
SELECT ROUND(AVG(total), 2) AS avg_order_value
FROM orders
WHERE status NOT IN ('cancelled')
  AND confirmed_at >= $1 AND confirmed_at < $2;

-- 5. Cancellation Rate (useful metric — INCLUDES cancelled for this one)
SELECT
  COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_count,
  COUNT(*) AS total_count,
  ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'cancelled') / NULLIF(COUNT(*), 0), 1) AS cancel_rate_pct
FROM orders
WHERE confirmed_at >= $1 AND confirmed_at < $2;

-- 6. Complete daily summary
SELECT
  DATE(confirmed_at AT TIME ZONE 'Asia/Kolkata') AS order_date,
  COUNT(*) FILTER (WHERE status NOT IN ('cancelled')) AS active_orders,
  COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_orders,
  SUM(total) FILTER (WHERE status NOT IN ('cancelled')) AS revenue,
  SUM(tax_amount) FILTER (WHERE status NOT IN ('cancelled')) AS tax_collected,
  ROUND(AVG(total) FILTER (WHERE status NOT IN ('cancelled')), 2) AS avg_order_value
FROM orders
WHERE confirmed_at >= $1 AND confirmed_at < $2
GROUP BY DATE(confirmed_at AT TIME ZONE 'Asia/Kolkata')
ORDER BY order_date;
```

### VERIFICATION TEST
```bash
# Insert a cancelled order and a completed order on the same day
psql $PGB_URL -c "
INSERT INTO orders VALUES
(DEFAULT,'RP01','+91T','T1','[{\"item_code\":\"D01\",\"quantity\":1}]','completed',100,0.05,5,105,false,NULL,NULL,NULL,NOW(),'RPRT01',false,1),
(DEFAULT,'RP02','+91T','T1','[{\"item_code\":\"D01\",\"quantity\":2}]','cancelled',200,0.05,10,210,false,NULL,NULL,NULL,NOW(),'RPRT02',false,1);"

# Total revenue should be 105, NOT 315
psql $PGB_URL -c "SELECT SUM(total) FROM orders WHERE status NOT IN ('cancelled') AND display_id IN ('RP01','RP02');"
# PASS: 105
```

### PREVENTION
Add a banner in the Reports UI: "Note: Revenue figures exclude cancelled orders." Add the cancellation rate metric to every daily report.

---

# CATEGORY 8: DEPLOYMENT & INFRASTRUCTURE

---

## ISSUE ID: INFRA-8a
**SEVERITY: Medium**
**TITLE: pg_cron jobs behave differently from n8n queries — advisory locks and connection settings diverge**

### FAILURE SCENARIO
pg_cron runs inside PostgreSQL using a direct connection (not through PgBouncer). A maintenance job that uses `pg_advisory_lock` works correctly via pg_cron (session-scoped lock holds because it's a real session) but the same function would fail if called from n8n via PgBouncer. Conversely, a pg_cron job that depends on `SET statement_timeout` will hold that setting for the entire session, whereas n8n queries through PgBouncer may lose per-session settings between statements.

### ROOT CAUSE
pg_cron uses a direct PostgreSQL connection (bypasses PgBouncer). This means: (a) session-scoped locks work, (b) session variables persist, (c) connection limits are consumed from the direct pool, not PgBouncer pool. If a developer tests a function via pg_cron and it works, then deploys the same function to be called from n8n, behavior may differ.

### PERMANENT FIX

Document and enforce the rule: **all functions callable from both pg_cron and n8n must use only transaction-scoped primitives.**

```sql
-- Audit existing pg_cron jobs for session-scoped dependencies:
SELECT jobid, schedule, command
FROM cron.job
WHERE command ILIKE '%pg_advisory_lock(%'
  AND command NOT ILIKE '%pg_advisory_xact_lock(%';
-- Any results: rewrite to use pg_advisory_xact_lock

-- Jobs that are safe to run only via pg_cron (never called from n8n):
-- These CAN use session-scoped features:
-- 1. cleanup-kds-pings: simple DELETE, no locks needed
-- 2. cleanup-message-dedup: simple DELETE, no locks needed
-- 3. cleanup-global-rate-limits: simple DELETE, no locks needed
-- 4. Nightly VACUUM: session-level operation, pg_cron only

-- Jobs that MIGHT be called from both:
-- Any function in the public schema callable via supabase.rpc()
-- These MUST avoid session-scoped primitives.
```

### VERIFICATION TEST
```bash
# List all pg_cron jobs:
psql $SUPABASE_DIRECT_URL -c "SELECT jobid, schedule, command FROM cron.job;"
# Review each command for session-scoped dependencies
# PASS: none use pg_advisory_lock or SET session-level variables
```

### PREVENTION
Code review checklist item: "Does this function use session-scoped PostgreSQL features? If yes, it cannot be called via PgBouncer."

---

## ISSUE ID: INFRA-8b
**SEVERITY: High**
**TITLE: Vercel proxy 10s timeout causes 504 on slow n8n operations — Manager Portal shows error, retries create duplicates**

### FAILURE SCENARIO
Manager clicks "Ready for Pickup." Vercel proxy validates JWT (fast), forwards to n8n webhook, waits for n8n response. n8n processes for 12 seconds (lock contention + WhatsApp send). Vercel function hits 10s timeout, returns 504 to the Manager Portal. Manager sees "error", clicks again. n8n processes the second click too.

### PERMANENT FIX

Fire-and-forget proxy — validate auth, forward request, return 202 immediately:

```javascript
// vercel-proxy/api/notify.js
import { jwtVerify, createRemoteJWKSet } from 'jose'

const JWKS = createRemoteJWKSet(
  new URL(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/.well-known/jwks.json`),
  { cacheMaxAge: 300000 }
)

export const config = { maxDuration: 5 }  // 5s max — only for auth validation

export default async function handler(req, res) {
  // 1. Validate JWT
  const token = (req.headers.authorization || '').replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Missing token' })

  let payload
  try {
    const result = await jwtVerify(token, JWKS, {
      issuer: `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1`,
    })
    payload = result.payload
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' })
  }

  // 2. Inject staff identity into the forwarded request
  const body = {
    ...(req.body || {}),
    _staff_id: payload.sub,
    _staff_role: payload.user_metadata?.role || payload.role,
    _timestamp: Date.now()
  }

  // 3. Fire and forget — send to n8n, DO NOT AWAIT response
  const n8nUrl = process.env.N8N_INTERNAL_WEBHOOK_URL

  // Use fetch without await — response will be ignored
  fetch(n8nUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(err => {
    // Log silently — don't fail the proxy
    console.error('n8n forward error (non-blocking):', err.message)
  })

  // 4. Return immediately — Manager Portal gets instant feedback
  return res.status(202).json({
    accepted: true,
    message: 'Action queued for processing',
    staff_id: payload.sub
  })
}
```

Manager Portal — handle 202 gracefully:
```javascript
// manager-portal/src/lib/api.js
export async function sendManagerAction(endpoint, body) {
  const { data: { session } } = await supabase.auth.getSession()
  
  const res = await fetch(`/api/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`
    },
    body: JSON.stringify(body)
  })

  if (res.status === 202) {
    // Action accepted — wait for DB update via realtime subscription
    toast.info('Action sent — waiting for confirmation...')
    return { accepted: true }
  }

  if (res.status === 401) {
    await supabase.auth.refreshSession()
    throw new Error('Session expired — please retry')
  }

  throw new Error(`Proxy error: ${res.status}`)
}
```

### VERIFICATION TEST
```bash
# Time the proxy response:
time curl -X POST https://your-proxy.vercel.app/api/notify \
  -H "Authorization: Bearer $VALID_JWT" \
  -H "Content-Type: application/json" \
  -d '{"order_id":1,"action":"mark_ready"}'
# PASS: responds in < 1 second with 202
# FAIL: hangs for 10+ seconds or returns 504
```

### PREVENTION
Monitor Vercel function duration. Alert if any invocation exceeds 5 seconds (shouldn't happen with fire-and-forget).

---

## ISSUE ID: INFRA-8c
**SEVERITY: Medium**
**TITLE: n8n execution logs grow unbounded — 328K records/year, disk exhaustion on self-hosted instance**

### FAILURE SCENARIO
n8n stores every workflow execution with full input/output data. At 300 orders/day × 3 executions/order = 900/day = 328,500/year. Each execution log can be 5–50 KB. At average 20 KB: 6.4 GB/year of execution data.

### PERMANENT FIX

n8n environment variables for execution log pruning:

```bash
# .env for n8n
EXECUTIONS_DATA_PRUNE=true
EXECUTIONS_DATA_MAX_AGE=168        # 7 days (in hours) — enough for debugging
EXECUTIONS_DATA_SAVE_ON_ERROR=all  # always save error executions
EXECUTIONS_DATA_SAVE_ON_SUCCESS=all # save successes too (for 7 days)
EXECUTIONS_DATA_SAVE_ON_PROGRESS=false # don't save intermediate states
EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS=true

# For production, also limit the absolute count:
EXECUTIONS_DATA_MAX_COUNT=10000    # keep max 10K executions regardless of age
```

If n8n uses PostgreSQL as its backend (recommended for production), add a pg_cron cleanup:
```sql
-- Run weekly: clean n8n execution data older than 14 days
-- This is a safety net in case n8n's built-in pruning fails
SELECT cron.schedule('cleanup-n8n-executions', '0 3 * * 0',
  $$DELETE FROM execution_entity WHERE "startedAt" < NOW() - INTERVAL '14 days' AND finished = true$$
);
```

### VERIFICATION TEST
```bash
# Check current execution count:
# If n8n uses SQLite:
sqlite3 /path/to/n8n/database.sqlite "SELECT count(*) FROM execution_entity;"
# If n8n uses PostgreSQL:
psql $N8N_DB_URL -c "SELECT count(*), pg_size_pretty(pg_total_relation_size('execution_entity')) FROM execution_entity;"

# After setting env vars and restarting n8n:
# Wait 24 hours, count again
# PASS: count stabilizes at <= 10000
# FAIL: count keeps growing unbounded
```

### PREVENTION
Weekly disk space alert: check the n8n database size. Alert if >2 GB (indicates pruning is not working).

---

*End of Part 4a — Categories 7 & 8 complete. Part 4b covers Sections A–D (Priority Matrix, Demo Risk, Missing Monitoring, Health Check).*
