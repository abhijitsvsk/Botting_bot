# Adversarial System Audit — WhatsApp Restaurant Ordering System
## Part 1 of 4 — Categories 1 & 2: Database Concurrency + AI Failure Modes

---

# CATEGORY 1: DATABASE CONCURRENCY & TRANSACTION INTEGRITY

---

## ISSUE ID: DB-1a
**SEVERITY: High**
**TITLE: Concurrent cart mutations from rapid double-send cause last-write-wins data loss despite advisory lock**

### FAILURE SCENARIO
Customer sends "Add dosa" then "Add coffee" within 200ms. Both messages arrive at the n8n webhook concurrently. n8n spawns two parallel execution threads. Both threads reach the cart mutation block simultaneously.

### EXACT ERROR OR SYMPTOM
No error thrown. Thread A reads `cart=[]`, appends dosa → `[{dosa}]`. Thread B also reads `cart=[]` before Thread A commits, appends coffee → `[{coffee}]`. Thread B commits last. Cart contains only coffee. Dosa is lost. No log, no alert, no customer notification.

### ROOT CAUSE
`pg_advisory_xact_lock` only serialises threads if: (a) they lock on the same key AND (b) both stay on the same connection within the same transaction. Under PgBouncer transaction mode, each n8n Postgres node is a separate implicit transaction on a potentially different backend connection. If the advisory lock acquisition and the cart SELECT are in separate n8n nodes, PgBouncer may route them to different backends. Lock on Connection A provides zero protection for a SELECT on Connection B.

### PERMANENT FIX
Wrap lock → read → mutate → write in a single stored procedure call — one round-trip, one transaction, one connection guaranteed.

```sql
-- migrations/002_cart_upsert_proc.sql
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
```

n8n Postgres node — single call:
```sql
SELECT upsert_cart_item(
  '{{ $json.phone }}',
  '{{ $json.item_code }}',
  {{ $json.quantity }},
  '{{ $json.modifier }}'::JSONB
);
```

### VERIFICATION TEST
```bash
# Terminal 1 — hold lock for 3 seconds
psql $SUPABASE_PGBOUNCER_URL -c "
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('+919876543210')::BIGINT);
SELECT pg_sleep(3);
SELECT upsert_cart_item('+919876543210','DOSA01',1,NULL);
COMMIT;"

# Terminal 2 — run immediately after Terminal 1 starts
psql $SUPABASE_PGBOUNCER_URL -c "
SELECT upsert_cart_item('+919876543210','COFFEE01',1,NULL);"

# Terminal 2 must block ~3s then succeed.
# Verify:
psql $SUPABASE_PGBOUNCER_URL -c "SELECT cart FROM user_sessions WHERE phone='+919876543210';"
# PASS: [{dosa,qty:1},{coffee,qty:1}]  FAIL: only one item
```

### PREVENTION
Monitor `pg_stat_activity` for `wait_event_type='Lock'` on `user_sessions`. Alert if cart-lock waits >500ms more than 5 times/minute.

---

## ISSUE ID: DB-1b
**SEVERITY: High**
**TITLE: Manager override and customer confirm-order race — last-write-wins silent data loss**

### FAILURE SCENARIO
Customer taps "Confirm" at T=0ms. Manager selects "Preparing" in the dropdown at T=2ms. Both issue concurrent UPDATEs on the same orders row. Both receive HTTP 200. No conflict is detected.

### EXACT ERROR OR SYMPTOM
Last writer wins silently. `confirmed_at` may be overwritten to NULL if manager's UPDATE doesn't include it. KDS shows correct visual status but audit timestamps are corrupt. No error on either client.

### ROOT CAUSE
PostgreSQL READ COMMITTED (Supabase default) serialises writes to the same row but both UPDATEs succeed — the application has no mechanism to detect that the row changed between the time it was read and when the write committed.

### PERMANENT FIX

```sql
-- Add optimistic concurrency version to orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS row_version INT NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION increment_row_version()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_orders_row_version
BEFORE UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION increment_row_version();
```

Manager Portal conflict-aware update:
```javascript
// manager-portal/src/lib/orderActions.js
export async function overrideOrderStatus(orderId, newStatus, knownVersion) {
  const { data, error } = await supabase
    .from('orders')
    .update({ status: newStatus })
    .eq('order_id', orderId)
    .eq('row_version', knownVersion)  // optimistic lock
    .select('order_id, row_version, status')

  if (error) throw error
  if (!data || data.length === 0) {
    throw new Error('CONFLICT: Order modified concurrently. Refresh and retry.')
  }
  return data[0]
}
```

n8n customer confirm (Postgres node):
```sql
UPDATE orders
SET status = 'order_received', confirmed_at = NOW()
WHERE order_id = {{ $json.order_id }}
  AND row_version = {{ $json.known_version }}
  AND status = 'pending';
-- If rowCount === 0: conflict — fetch fresh version and retry or alert
```

### VERIFICATION TEST
```bash
# Session A: update and hold
BEGIN;
UPDATE orders SET status='order_received' WHERE order_id=1 AND row_version=1;
-- do NOT commit

# Session B simultaneously:
UPDATE orders SET status='preparing' WHERE order_id=1 AND row_version=1;
# Session A commits first: row_version becomes 2
# Session B: UPDATE 0 rows (version mismatch)
# PASS: conflict detected, 0 rows updated
```

### PREVENTION
Log `update_conflict` to `audit_log` on every 0-row-affected UPDATE. Alert if conflict rate exceeds 1% of order updates per hour.

---

## ISSUE ID: DB-1c
**SEVERITY: High**
**TITLE: EDIT ORDER vs START PREPARING race — PostgREST direct UPDATE bypasses SELECT FOR UPDATE guard**

### FAILURE SCENARIO
Customer sends "EDIT ORDER" (via n8n, which may use `FOR UPDATE`). Chef taps "START PREPARING" on KDS (via PostgREST `.update()`, which does NOT use `FOR UPDATE`). The two code paths have different locking strategies. At READ COMMITTED isolation, both can succeed concurrently.

### EXACT ERROR OR SYMPTOM
Order status becomes `preparing`. Cart is simultaneously reopened in `user_sessions`. Customer edits and reconfirms. Chef prepares the original version. Customer gets wrong food from the original un-edited order. No error anywhere.

### ROOT CAUSE
Supabase PostgREST `.update()` is a direct `UPDATE WHERE` with no row-level lock acquisition. READ COMMITTED does not protect against this pattern. Both transactions can read the pre-update state and both writes succeed.

### PERMANENT FIX

```sql
-- Chef: start preparing (KDS calls via .rpc())
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

-- Customer: reopen cart (n8n calls this)
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
```

KDS React:
```javascript
const { data, error } = await supabase.rpc('kds_start_preparing', { p_order_id: orderId })
if (error?.message?.includes('INVALID_TRANSITION')) {
  toast.error('Order status changed — refreshing')
  refetchOrders()
}
```

### VERIFICATION TEST
```bash
# Session A: lock the row
BEGIN;
SELECT status FROM orders WHERE order_id=1 FOR UPDATE;
-- hold open

# Session B (concurrent):
SELECT customer_reopen_cart(1, '+91TEST');
# Expected: ERROR: could not obtain lock on row (NOWAIT fires immediately)
# PASS: no silent dual-write
```

### PREVENTION
ALL order status transitions must go through stored procedures — ban bare PostgREST `.update()` for status columns via a PostgREST column-level permission restriction or a DB trigger that enforces the transition state machine.

---

## ISSUE ID: DB-1d
**SEVERITY: Critical**
**TITLE: pg_advisory_lock (session-scoped) silently provides zero protection on PgBouncer transaction mode**

### FAILURE SCENARIO
Developer writes cart code using `pg_advisory_lock` instead of `pg_advisory_xact_lock`. Passes code review. Ships to production. Every cart write is now completely unprotected despite appearing to acquire a lock.

### EXACT ERROR OR SYMPTOM
Zero errors. Zero warnings. `pg_advisory_lock` returns `true` (success). But under PgBouncer transaction mode, the lock lives on a backend connection that is immediately returned to the pool after the statement. The next statement runs on a different connection. Two concurrent threads race freely on the same cart. Data loss with no indication.

### ROOT CAUSE
`pg_advisory_lock` = session-scoped. Persists until explicit unlock or session disconnect. PgBouncer transaction mode recycles connections after each `BEGIN...COMMIT` block. Lock on Connection A doesn't protect Connection B. `pg_advisory_xact_lock` = transaction-scoped. Auto-releases at COMMIT/ROLLBACK. Both the lock acquisition and the critical section must be in one transaction, which forces PgBouncer to use the same backend connection for the entire transaction.

### PERMANENT FIX AND PROOF TEST

```bash
# Run these concurrently against PgBouncer port 6543:

# --- Test 1: BROKEN (session-scoped) ---
# Process A:
psql $PGB_URL -c "BEGIN; SELECT pg_advisory_lock(12345); SELECT pg_sleep(5); COMMIT;"
# Process B (immediately):
psql $PGB_URL -c "SELECT pg_advisory_lock(12345); SELECT 'I acquired it immediately — LOCK IS BROKEN';"
# If Process B prints immediately: FAIL

# --- Test 2: CORRECT (transaction-scoped) ---
# Process A:
psql $PGB_URL -c "BEGIN; SELECT pg_advisory_xact_lock(99999); SELECT pg_sleep(5); COMMIT;"
# Process B (immediately):
psql $PGB_URL -c "BEGIN; SELECT pg_advisory_xact_lock(99999); SELECT 'acquired after wait'; COMMIT;"
# Process B blocks ~5s then runs: PASS
```

Pre-commit lint hook:
```bash
#!/bin/bash
# .githooks/pre-commit
if grep -rn --include="*.sql" --include="*.js" "pg_advisory_lock(" . \
   | grep -v "pg_advisory_xact_lock" \
   | grep -v "pg_advisory_unlock" \
   | grep -q "pg_advisory_lock("; then
  echo "ERROR: pg_advisory_lock is unsafe with PgBouncer. Use pg_advisory_xact_lock."
  exit 1
fi
```

### VERIFICATION TEST
Run Test 1 and Test 2 above against live PgBouncer URL. Total time: under 2 minutes. Results are unambiguous pass/fail.

### PREVENTION
Add lint hook above. Add to code review checklist. Add a monthly CI job that runs the proof test and fails the build if session locks work (would indicate PgBouncer mode changed unexpectedly to session mode).

---

## ISSUE ID: DB-1e
**SEVERITY: Critical**
**TITLE: Failed order INSERT with idempotency key already committed in user_sessions blocks all future retries**

### FAILURE SCENARIO
Customer confirms order. n8n Step 1 writes `idempotency_key` to `user_sessions` (separate Postgres node = separate committed transaction). n8n Step 2 runs `INSERT INTO orders` — fails with a constraint violation (e.g. `table_number` is NULL). Step 2's transaction rolls back but Step 1 already committed. Meta retries 10 minutes later with the same message. n8n reads `user_sessions.idempotency_key`, finds a match, skips order creation. Order is never placed.

### EXACT ERROR OR SYMPTOM
Customer receives nothing (no order confirmation, no error). KDS never shows the order. Food never arrives. Manual retry won't help because new message IDs bypass the idempotency check but hit the same constraint. Restaurant loses revenue silently.

### ROOT CAUSE
Idempotency key stored in `user_sessions` is the wrong source of truth. The correct source of truth is `orders.idempotency_key` (UNIQUE constraint). Writing to `user_sessions` before the `orders` INSERT creates a commit ordering vulnerability: the session write survives but the order does not.

### PERMANENT FIX

```sql
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
  FROM orders WHERE idempotency_key = p_idempotency_key;

  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  -- Pre-validate before INSERT to surface constraint errors early
  IF p_table_number IS NULL OR trim(p_table_number) = '' THEN
    RAISE EXCEPTION 'MISSING_TABLE_NUMBER';
  END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'EMPTY_CART';
  END IF;

  v_display_id := upper(substring(md5(p_idempotency_key || clock_timestamp()::text), 1, 6));

  INSERT INTO orders (
    display_id, phone, table_number, items, status,
    subtotal, tax_rate, tax_amount, total,
    allergen_alert, allergen_text, idempotency_key, confirmed_at
  ) VALUES (
    v_display_id, p_phone, p_table_number, p_items, 'order_received',
    p_subtotal, p_tax_rate, p_tax_amount, p_total,
    p_allergen_alert, p_allergen_text, p_idempotency_key, NOW()
  )
  ON CONFLICT (idempotency_key) DO UPDATE
    SET idempotency_key = EXCLUDED.idempotency_key  -- no-op; satisfies RETURNING
  RETURNING order_id INTO v_order_id;

  -- ONLY update user_sessions AFTER successful INSERT
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
```

### VERIFICATION TEST
```bash
# Step 1: INSERT with NULL table_number → must raise exception
psql $PGB_URL -c "SELECT create_order_idempotent('+91T','KEY001',NULL,'[]',100,0.05,5,105,false,NULL);"
# Expected: ERROR: MISSING_TABLE_NUMBER

# Step 2: idempotency_key must NOT be in user_sessions (no partial write)
psql $PGB_URL -c "SELECT idempotency_key FROM user_sessions WHERE phone='+91T';"
# PASS: NULL

# Step 3: Fix table_number, retry same KEY001
psql $PGB_URL -c "SELECT create_order_idempotent('+91T','KEY001','T5','[{\"item_code\":\"D01\"}]',100,0.05,5,105,false,NULL);"
# PASS: {duplicate: false, order_id: N}

# Step 4: Meta retry with same KEY001
psql $PGB_URL -c "SELECT create_order_idempotent('+91T','KEY001','T5','[{\"item_code\":\"D01\"}]',100,0.05,5,105,false,NULL);"
# PASS: {duplicate: true}
```

### PREVENTION
Alert on `EXCEPTION MISSING_TABLE_NUMBER` — indicates the table-collection flow is broken upstream. Alert on any order where `user_sessions.idempotency_key IS NOT NULL` but no matching row in `orders` (orphaned key).

---

# CATEGORY 2: AI MODEL FAILURE MODES

---

## ISSUE ID: AI-2a
**SEVERITY: Medium**
**TITLE: Malayalam-script message to GPT-4o-mini returns empty items array — customer receives silence**

### FAILURE SCENARIO
Customer types "ഒരു ദോശ വേണം" (I want one dosa) in Malayalam. Groq classifies as `PARSE_ORDER`. GPT-4o-mini cannot map Malayalam to menu codes but must return valid JSON. Returns `{"items":[],"parse_failed":true}`. n8n workflow only branches on JSON parse exceptions — not on structurally valid empty responses. No WhatsApp reply sent.

### EXACT ERROR OR SYMPTOM
Customer sees nothing. Resends message repeatedly. Burns rate-limit budget. After 10 unanswered messages gives up. Zero revenue, zero error in logs — just silence.

### ROOT CAUSE
Missing explicit handling of the `items.length === 0` valid-but-empty case. The workflow assumes GPT failure = thrown exception, but `json_object` format forces a structurally valid response even on semantic failure.

### PERMANENT FIX

Add to system prompt (static section — does not break caching):
```
If no menu items can be identified, return:
{"items": [], "parse_failed": true, "reason": "unrecognized_language|no_menu_match|empty_message"}
```

n8n Code node after GPT HTTP Request:
```javascript
const raw = $input.first().json.choices[0].message.content;
let ai;
try { ai = JSON.parse(raw); }
catch(e) { throw new Error('AI_JSON_PARSE_ERROR: ' + raw.slice(0, 200)); }

if (!Array.isArray(ai.items)) {
  throw new Error('AI_MALFORMED: no items array');
}

if (ai.items.length === 0) {
  const reason = ai.reason || 'no_menu_match';
  const lang = $('FetchSession').first().json.language_code || 'en';

  const MSGS = {
    unrecognized_language: {
      en: "Sorry, I only understand English orders. Type MENU for item codes.",
      ml: "ക്ഷമിക്കണം, ഇംഗ്ലീഷിൽ ഓർഡർ ചെയ്യൂ. MENU ടൈപ്പ് ചെയ്തോ."
    },
    no_menu_match: {
      en: "I couldn't find that on our menu. Type MENU to browse items."
    },
    empty_message: {
      en: "Please type your order."
    }
  };

  const msgMap = MSGS[reason] || MSGS.no_menu_match;
  const msg = msgMap[lang] || msgMap.en;

  return [{ json: { action: 'SEND_MESSAGE', message: msg, parse_failed: true, terminate: true } }];
}

return [{ json: { items: ai.items, parse_failed: false } }];
```

### VERIFICATION TEST
```bash
# Trigger test webhook with Malayalam message
# Expected: WhatsApp outbound message in Malayalam directing to use codes
# Check message_logs:
psql $PGB_URL -c "
SELECT direction, created_at FROM message_logs
WHERE phone='+919876543210' ORDER BY created_at DESC LIMIT 1;"
# PASS: direction='outbound', message contains Malayalam fallback text
```

### PREVENTION
Counter `ai_parse_empty_items_total` per language code. Alert if >10% of parse calls return empty items and no corresponding outbound message is logged within 30 seconds.

---

## ISSUE ID: AI-2b
**SEVERITY: High**
**TITLE: Groq misclassifies bare "cancel" as CANCEL_ORDER — cart destroyed when customer meant remove-last-item**

### FAILURE SCENARIO
Customer has 3 items in cart. Types "cancel" to remove the last added item. Groq classifies as `CANCEL_ORDER`. Cart cleared. Customer receives "Your order has been cancelled." Customer furious.

### EXACT ERROR OR SYMPTOM
Cart is cleared. Order record is cancelled if already confirmed. Customer must retype entire order. If post-confirmation, refund workflow triggers unnecessarily. No recovery path without messaging the restaurant directly.

### ROOT CAUSE
"cancel" is genuinely ambiguous. Groq 8B lacks sufficient context-window reasoning for this disambiguation without explicit few-shot examples. The prompt doesn't distinguish bare "cancel" from "cancel my order."

### PERMANENT FIX

Updated Groq intent prompt (static — add to system prompt):
```
CRITICAL DISAMBIGUATION:
- "cancel" alone → REMOVE_ITEM_AMBIGUOUS  (NEVER CANCEL_ORDER for bare "cancel")
- "cancel that", "cancel it" → REMOVE_ITEM_AMBIGUOUS
- "cancel my order", "cancel order", "cancel everything" → CANCEL_ORDER
- "cancel the coffee", "remove the dosa" → REMOVE_ITEM

Return JSON: {"intent": "REMOVE_ITEM_AMBIGUOUS", "confidence": 0.7}
```

n8n handler for REMOVE_ITEM_AMBIGUOUS:
```javascript
const cart = $('FetchSession').first().json.cart || [];

if (cart.length === 0) {
  return [{ json: {
    action: 'SEND_MESSAGE',
    message: 'Your cart is empty. Did you mean to cancel a confirmed order?\nReply "YES CANCEL ORDER" to cancel, or type your order.'
  }}];
}

const last = cart[cart.length - 1];
return [{ json: {
  action: 'SEND_INTERACTIVE',
  type: 'button',
  body: `Remove "${last.name}" from your cart, or cancel the entire order?`,
  buttons: [
    { id: 'REMOVE_LAST', title: `Remove ${last.name}` },
    { id: 'CANCEL_ALL',  title: 'Cancel entire order' },
    { id: 'KEEP_ALL',    title: 'Keep everything' }
  ]
}}];
```

### VERIFICATION TEST
```bash
# Add DOSA01 to cart, then send message "cancel"
# Expected: Interactive button message asking to clarify
# NOT expected: "order cancelled" or cart clearing
psql $PGB_URL -c "SELECT cart FROM user_sessions WHERE phone='+91TEST';"
# PASS: cart still contains DOSA01
```

### PREVENTION
Log all `REMOVE_ITEM_AMBIGUOUS` events to `audit_log`. Alert if any `CANCEL_ORDER` execution happens when `user_sessions.cart` was non-empty and no interactive confirmation button was pressed first.

---

## ISSUE ID: AI-2c
**SEVERITY: High**
**TITLE: DB cross-check missing available=TRUE filter — 86'd items enter customer carts**

### FAILURE SCENARIO
Manager marks BURGER01 `available=false` at 7:05 PM. At 7:06 PM customer says "I want a truffle burger." GPT-4o-mini correctly returns `BURGER01`. Cross-check query is `SELECT ... FROM menu_items WHERE item_code = ANY($1)` — no availability filter. BURGER01 passes validation and enters cart. Customer confirms.

### EXACT ERROR OR SYMPTOM
KDS shows order with unavailable item. Chef manually rejects. Customer unhappy. During peak service this creates a cascade of angry follow-up messages.

### ROOT CAUSE
Single missing `AND available = TRUE` in the validation query.

### PERMANENT FIX

```sql
-- n8n DB Cross-Check query (Postgres node):
SELECT
  m.item_code, m.name, m.price, m.available,
  m.allergens, m.station,
  CASE WHEN NOT m.available THEN (
    SELECT jsonb_agg(jsonb_build_object(
      'item_code', s.item_code, 'name', s.name, 'price', s.price
    ))
    FROM menu_items s
    WHERE s.item_code = ANY(m.similar_items) AND s.available = TRUE
  ) ELSE NULL END AS alternatives
FROM menu_items m
WHERE m.item_code = ANY(
  ARRAY(SELECT jsonb_array_elements_text($1::JSONB))
);
-- Returns all matched items; Code node below filters on available
```

n8n Code node — Filter and Respond:
```javascript
const aiItems = $('AIParse').first().json.items;
const dbRows  = $input.all().map(r => r.json);
const available = [], unavailable = [];

for (const ai of aiItems) {
  const db = dbRows.find(r => r.item_code === ai.item_code);
  if (!db) {
    unavailable.push({ ...ai, reason: 'not_on_menu' });
    continue;
  }
  if (!db.available) {
    unavailable.push({ ...ai, name: db.name, reason: '86d', alternatives: db.alternatives });
    continue;
  }
  // Price ALWAYS from DB
  available.push({
    item_code: db.item_code, name: db.name, price: db.price,
    quantity: ai.quantity, allergens: db.allergens, station: db.station
  });
}

const replyLines = unavailable.map(u => {
  if (u.reason === '86d') {
    const alt = u.alternatives?.length
      ? ` Try: ${u.alternatives.map(a => `${a.name} ₹${a.price}`).join(', ')}`
      : '';
    return `❌ *${u.name}* is unavailable today.${alt}`;
  }
  return `❌ "${u.item_code}" not found on our menu.`;
});

return [{ json: { available, unavailable, replyLines } }];
```

### VERIFICATION TEST
```bash
psql $PGB_URL -c "UPDATE menu_items SET available=FALSE WHERE item_code='BURGER01';"
# Send: "one truffle burger"
# Expected: customer message "❌ Truffle Burger is unavailable today."
psql $PGB_URL -c "SELECT cart FROM user_sessions WHERE phone='+91TEST';"
# PASS: no BURGER01 in cart
psql $PGB_URL -c "UPDATE menu_items SET available=TRUE WHERE item_code='BURGER01';" # cleanup
```

### PREVENTION
Add pg_notify trigger on `available` column change. n8n workflow alerts any customer whose active cart contains the newly 86'd item.

---

## ISSUE ID: AI-2d
**SEVERITY: Medium**
**TITLE: Circuit breaker opens mid-session — customer receives cryptic code-only instructions, unaware cart is preserved**

### FAILURE SCENARIO
Customer has `[{dosa,qty:1}]` in active cart. Groq fails 3× on other traffic. `bot_mode` → `menu_code_only`. Customer sends "Add two coffees." Bot switches to code-only mode without explaining what happened to the cart.

### EXACT ERROR OR SYMPTOM
Customer receives generic instruction to use codes. They don't know their cart is safe. They may start over (creating duplicate intent), or give up entirely.

### PERMANENT FIX

n8n Route By Bot Mode node — runs before intent classification:
```javascript
const settings = $('FetchSettings').first().json;
const session  = $('FetchSession').first().json;
const botMode  = settings.bot_mode || 'ai';
const cart     = session.cart || [];
const msg      = $input.first().json.message.trim().toUpperCase();

if (botMode === 'menu_code_only') {
  const CODE_RE = /^([A-Z0-9]{2,8})(\s+[Xx]?\s*\d+)?(\s*,\s*[A-Z0-9]{2,8}(\s+[Xx]?\s*\d+)?)*$/;

  if (CODE_RE.test(msg)) {
    return [{ json: { mode: 'code_parse', message: msg } }];
  }

  const cartNote = cart.length
    ? `\n\n✅ Your cart is intact: ${cart.map(i => `${i.name} x${i.quantity}`).join(', ')}.`
    : '';

  return [{ json: {
    action: 'SEND_MESSAGE',
    message: `🔧 AI ordering is temporarily offline.\n\nPlease order by item code.\nExample: "D01 x1, C02 x2"\n\nType MENU to see all codes.${cartNote}`,
    terminate: true
  }}];
}

return [{ json: { mode: 'ai', message: $input.first().json.message } }];
```

### VERIFICATION TEST
```bash
psql $PGB_URL -c "UPDATE settings SET value='menu_code_only' WHERE key='bot_mode';"
psql $PGB_URL -c "UPDATE user_sessions SET cart='[{\"name\":\"Dosa\",\"quantity\":1,\"item_code\":\"D01\",\"price\":60}]' WHERE phone='+91TEST';"
# Send natural language message
# Expected: WhatsApp message with "✅ Your cart is intact: Dosa x1"
# PASS: cart unchanged in DB
```

### PREVENTION
Send SUPPORT_PHONE SMS when circuit breaker opens. Auto-close breaker when Groq recovers (AI-2f fix). Track how many customers were in mid-order when breaker triggered.

---

## ISSUE ID: AI-2e
**SEVERITY: Medium**
**TITLE: Dynamic content before menu in GPT-4o-mini system prompt defeats prompt caching — 2× cost spike**

### FAILURE SCENARIO
System prompt is assembled per-request with phone number, timestamp, or session ID before the menu content. OpenAI's cache never matches (unique prefix per call). Every request pays full uncached token price.

### EXACT ERROR OR SYMPTOM
OpenAI billing shows zero cached tokens. At 1,000 orders/day, 500-token menu prefix: ~₹25/day extra cost = ₹750/month unnecessary spend. No functional error — just silent cost increase.

### ROOT CAUSE
OpenAI prompt caching matches the first N tokens byte-for-byte. Any per-request dynamic value before the menu block creates a unique prefix, breaking cache hits for all subsequent tokens.

### PERMANENT FIX

```javascript
// n8n: Build GPT Prompt node
// Static system prompt — computed once, cached in workflow static data
if (!$workflow.staticData.systemPrompt || Date.now() - ($workflow.staticData.menuCacheTime||0) > 300000) {
  const menuItems = await fetchActiveMenuFromDB(); // fetch from Supabase once
  const menuLines = menuItems
    .filter(m => m.available)
    .map(m => `${m.item_code}: ${m.name} (₹${m.price})`)
    .join('\n');

  $workflow.staticData.systemPrompt = `You parse food orders for an Indian restaurant.
Return ONLY JSON: {"items":[{"item_code":string,"quantity":integer}],"parse_failed":boolean,"reason":string|null}
Rules:
- item_code must match codes in MENU exactly
- Never invent item_codes
- Unknown language or no match: {"items":[],"parse_failed":true,"reason":"unrecognized_language"}

=== MENU ===
${menuLines}`;
  // Nothing dynamic before this line — no phone, no timestamp, no session ID
  $workflow.staticData.menuCacheTime = Date.now();
}

// ALL dynamic content goes in the USER message only:
const userMsg = `Order: "${customerText}"\nLanguage: ${langCode}`;
// Phone number, session ID, request IDs: NEVER in system prompt

return [{ json: {
  model: 'gpt-4o-mini',
  response_format: { type: 'json_object' },
  messages: [
    { role: 'system', content: $workflow.staticData.systemPrompt },
    { role: 'user', content: userMsg }
  ]
}}];
```

Invalidate cache on menu change (menu_item UPDATE webhook → n8n):
```javascript
$workflow.staticData.systemPrompt = null;
$workflow.staticData.menuCacheTime = 0;
```

### VERIFICATION TEST
```bash
# Make 5 sequential requests from different phone numbers
# Check OpenAI usage API for cached_tokens:
curl "https://api.openai.com/v1/usage?date=$(date +%Y-%m-%d)" \
  -H "Authorization: Bearer $OPENAI_KEY" | jq '.data[].prompt_tokens_details'
# PASS: cached_tokens > 0 on requests 2-5
# FAIL: cached_tokens = 0 every time (prompt not cached)
```

### PREVENTION
Weekly audit of OpenAI billing dashboard. Alert if cache hit rate drops below 70% (indicates prompt structure regressed). CI test: assert phone number/timestamp not present in system prompt string.

---

## ISSUE ID: AI-2f
**SEVERITY: High**
**TITLE: Circuit breaker recovery ping validates HTTP 200 only — degraded Groq output reopens breaker, orders fail again immediately**

### FAILURE SCENARIO
Groq partial outage: HTTP 200 returned but model outputs garbled content. Recovery workflow pings Groq, gets 200, closes circuit breaker. Next real customer order hits Groq, gets garbage, fails. Breaker re-opens. Cycle repeats every 5 minutes indefinitely.

### EXACT ERROR OR SYMPTOM
Every 5 minutes: breaker closes (logged). 1-3 customer messages get bad/no responses. Breaker re-opens. Repeat. Customers experience sporadic failures. Developer only sees circuit breaker flapping in logs.

### ROOT CAUSE
Health check validates transport (HTTP 200) not model output quality. A degraded model can return HTTP 200 with semantically incorrect content indefinitely.

### PERMANENT FIX

```javascript
// n8n Schedule workflow: "Groq Quality Health Check" — runs every 5 min when breaker open

const VALIDATION_CALL = {
  model: 'llama-3-8b-8192',
  messages: [{
    role: 'user',
    content: 'Classify this intent. Reply with EXACTLY one word: ADD_ITEM|CONFIRM_ORDER|CANCEL_ORDER|VIEW_CART|OTHER\nMessage: "I want a masala dosa"'
  }],
  max_tokens: 15,
  temperature: 0
};

let resp, body;
try {
  resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(VALIDATION_CALL),
    signal: AbortSignal.timeout(8000)
  });
  body = await resp.json();
} catch(e) {
  return [{ json: { action: 'STAY_OPEN', reason: 'timeout_or_network', error: e.message } }];
}

if (!resp.ok) {
  return [{ json: { action: 'STAY_OPEN', reason: `http_${resp.status}` } }];
}

const output = (body.choices?.[0]?.message?.content || '').trim().toUpperCase().replace(/[^A-Z_]/g, '');
const VALID = ['ADD_ITEM','CONFIRM_ORDER','CANCEL_ORDER','VIEW_CART','OTHER'];

if (!VALID.includes(output) || output !== 'ADD_ITEM') {
  await supabase.from('audit_log').insert({
    action: 'groq_ping_fail',
    metadata: { output, expected: 'ADD_ITEM', http_status: resp.status }
  });
  return [{ json: { action: 'STAY_OPEN', reason: 'bad_output', output } }];
}

// Validated — close breaker
await supabase.from('settings').update({ value: 'false' }).eq('key', 'groq_circuit_breaker_open');
await supabase.from('settings').update({ value: 'ai' }).eq('key', 'bot_mode');
await supabase.from('settings').update({ value: '0' }).eq('key', 'groq_failure_count');

return [{ json: { action: 'BREAKER_CLOSED', validated_output: output } }];
```

### VERIFICATION TEST
```bash
# Simulate degraded Groq in n8n test mode (mock HTTP node to return garbage):
# {"choices":[{"message":{"content":"مرحبا بالعالم"}}]}
# Run health check workflow
# Expected: STAY_OPEN, reason=bad_output
psql $PGB_URL -c "SELECT value FROM settings WHERE key='groq_circuit_breaker_open';"
# PASS: value = 'true' (still open)

# Mock to return "ADD_ITEM"
# Expected: BREAKER_CLOSED
psql $PGB_URL -c "SELECT value FROM settings WHERE key='groq_circuit_breaker_open';"
# PASS: value = 'false'
```

### PREVENTION
Alert via Fast2SMS to SUPPORT_PHONE if circuit breaker has been open >15 minutes. Log all ping outcomes to `audit_log`. Alert if breaker opens and closes more than 3 times in 30 minutes (flapping indicator).

---

*End of Part 1 — Categories 1 & 2 complete (11 issues). Continuing in Part 2 with Categories 3 & 4.*
