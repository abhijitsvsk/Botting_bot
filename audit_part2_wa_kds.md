# Adversarial System Audit — Part 2 of 4
## Categories 3 & 4: WhatsApp/Meta API Failures + Supabase Realtime & KDS

---

# CATEGORY 3: WHATSAPP & META API FAILURE MODES

---

## ISSUE ID: WA-3a
**SEVERITY: Critical**
**TITLE: n8n "Respond to Webhook" node fires after first DB operation — Meta retries on timeout, duplicate processing**

### FAILURE SCENARIO
The n8n workflow receives a Meta webhook. The "Respond to Webhook" node is positioned after the message deduplication DB check (a Postgres query). On a slow Supabase/PgBouncer day, that query takes 3+ seconds. If the first meaningful external call (Groq) also takes 8 seconds, n8n takes 11+ seconds total before responding 200 OK. Meta marks delivery failed and retries.

### EXACT ERROR OR SYMPTOM
Meta sends the same webhook twice. The second webhook arrives 10–30 seconds later. If the first execution is still running (advisory lock held), the second gets a lock timeout. If the first has committed, the message_id deduplication catches it — **if** it was written in time. If deduplication is not the first DB op, there's a race. Worst case: duplicate order created. Chef makes order twice. Customer charged or confused.

### ROOT CAUSE
The "Respond to Webhook" node in n8n must be the **absolute first node** after the webhook trigger — before any DB operation, any AI call, any external HTTP request. Many n8n workflow templates place it after HMAC verification or deduplication for code-flow clarity, but this is wrong.

### PERMANENT FIX

**n8n Workflow Node Ordering — must be exactly:**
```
1. [Webhook Trigger]
      ↓
2. [Respond to Webhook] ← HERE, immediately. Returns 200 OK immediately.
      ↓
3. [HMAC Verification] (Code node — pure CPU, no I/O)
      ↓
4. [Check message_id dedup] (Postgres node)
      ↓
5. [Rate limit check] (Postgres node)
      ↓
6. [Groq intent classification] (HTTP Request)
      ↓
7. [GPT-4o-mini parse] (HTTP Request)
      ↓
   ... rest of workflow
```

n8n "Respond to Webhook" node configuration:
```json
{
  "respondWith": "text",
  "responseBody": "OK",
  "options": {
    "responseCode": 200,
    "responseHeaders": {
      "entries": [
        { "name": "Content-Type", "value": "text/plain" }
      ]
    }
  }
}
```

HMAC verification runs AFTER the 200 is sent. If HMAC fails, the workflow exits silently — no reply to Meta (Meta already got its 200). This is correct: Meta doesn't care about HMAC results, it cares that the endpoint acknowledged the delivery.

**Critical**: Set the webhook node's "Response Mode" to `"Using Respond to Webhook Node"` so n8n doesn't auto-respond at the end.

### VERIFICATION TEST
```bash
# Measure end-to-end n8n response time under load:
time curl -X POST https://n8n.your-domain.com/webhook/whatsapp \
  -H "Content-Type: application/json" \
  -d '{"object":"whatsapp_business_account","entry":[...]}'
# PASS: curl returns in < 500ms (200 OK received before any DB op)
# FAIL: curl returns in > 3s (Respond to Webhook is not the first node)

# Verify in n8n execution log: check timestamp of "Respond to Webhook" node
# It must be within 100ms of the "Webhook" trigger node timestamp
```

### PREVENTION
Add a workflow-level assertion in CI: parse the n8n workflow JSON and verify that `respondToWebhook` node appears as the second node (index 1 after trigger). Alert if workflow is modified and this ordering changes.

---

## ISSUE ID: WA-3b
**SEVERITY: Medium**
**TITLE: Expired WhatsApp interactive button reply (24h+ after send) crashes n8n with unhandled payload structure**

### FAILURE SCENARIO
Customer receives checkout summary with 3 interactive buttons (Confirm / Edit / Clear) at 11:00 PM. Taps "Confirm" next morning at 9:00 AM (10 hours later — within 24h, so this one passes). But a customer who receives buttons at 11:59 PM and taps at 12:01 AM the next night (24h 2min) gets an expired button.

### EXACT ERROR OR SYMPTOM
Meta returns the button reply with `type: "interactive"` and `interactive.type: "button_reply"`, but in some cases Meta returns an error to the customer-side WhatsApp UI ("This message has expired") and **does not send** the button_reply webhook to n8n at all. In other cases (network delays, caching) Meta does forward the reply with the button ID. When n8n receives this payload, if the workflow does not handle the case where the associated session/order no longer exists (e.g. the order was auto-cancelled or the cart was cleared), it throws an unhandled exception: `TypeError: Cannot read property 'cart' of null` — because the session row is gone.

### ROOT CAUSE
The workflow fetches the session by phone number after receiving the button reply, then accesses `session.cart`. If the cart has been cleared (e.g. by nightly cleanup or the customer's own actions), and the code does `session.cart.length` without a null check, it throws.

### PERMANENT FIX

n8n Code node — "Parse Interactive Button Reply":
```javascript
const body = $input.first().json;
const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

if (!msg || msg.type !== 'interactive') {
  return [{ json: { action: 'IGNORE', reason: 'not_interactive' } }];
}

const btnId = msg.interactive?.button_reply?.id;
const btnTitle = msg.interactive?.button_reply?.title;

if (!btnId) {
  return [{ json: { action: 'IGNORE', reason: 'no_button_id' } }];
}

// Valid button IDs this system expects:
const VALID_BUTTONS = ['CONFIRM_ORDER', 'EDIT_ORDER', 'CLEAR_CART',
                       'REMOVE_LAST', 'CANCEL_ALL', 'KEEP_ALL'];

if (!VALID_BUTTONS.includes(btnId)) {
  // Unknown button ID — likely expired or from old workflow version
  return [{ json: {
    action: 'SEND_MESSAGE',
    phone: msg.from,
    message: 'Your previous order session has expired. Type MENU to start a new order or type your items.',
    reason: 'unknown_button_id'
  }}];
}

return [{ json: { button_id: btnId, phone: msg.from, action: 'PROCESS_BUTTON' } }];
```

Then in the session fetch + handler:
```javascript
const session = $('FetchSession').first().json || {};
const cart = session.cart || [];  // always default to []

if (btnId === 'CONFIRM_ORDER' && cart.length === 0) {
  return [{ json: {
    action: 'SEND_MESSAGE',
    message: 'Your cart is empty. This order session may have expired. Type MENU to start again.',
    phone
  }}];
}
```

### VERIFICATION TEST
```bash
# Send a webhook payload simulating an unknown/stale button ID:
curl -X POST https://n8n.your-domain.com/webhook/whatsapp \
  -H "Content-Type: application/json" \
  -d '{
    "entry": [{
      "changes": [{
        "value": {
          "messages": [{
            "type": "interactive",
            "from": "+919876543210",
            "interactive": {
              "type": "button_reply",
              "button_reply": { "id": "STALE_BUTTON_2023", "title": "Confirm" }
            }
          }]
        }
      }]
    }]
  }'
# PASS: n8n returns 200, sends "session expired" message to customer
# FAIL: n8n throws TypeError or returns 500
```

### PREVENTION
Log all `unknown_button_id` events. Alert if >5 per hour — indicates buttons are being sent but sessions expire before customers respond (UX issue or high cart abandonment).

---

## ISSUE ID: WA-3c
**SEVERITY: High**
**TITLE: Meta account-level rate limiting misidentified as per-customer delivery failure — wrong remediation taken**

### FAILURE SCENARIO
Restaurant runs an abandoned-cart re-engagement campaign, sending template messages to 1,200 unique customers in 1 hour. Meta flags the account for exceeding Tier 1 limits (1,000 unique customers/day). Outbound messaging is throttled at the Meta account level. All subsequent outbound messages fail with a specific Meta error code. n8n treats this as individual delivery failures and marks `delivery_failed=true` on individual orders. Manager is alerted for each order individually. The real fix (reduce send rate, wait for limit reset) is not obvious from the per-order alerts.

### EXACT ERROR OR SYMPTOM
Meta returns: `{"error":{"code":131056,"title":"Message Undeliverable","message":"Business account has reached its messaging limit for the day"}}` on outbound send attempts. n8n's error handler, if generic, marks the order's `delivery_failed=true` and may trigger the Fast2SMS fallback for EVERY affected order, which is also wrong (the customer is reachable on WhatsApp, they're just rate-limited).

### ROOT CAUSE
Error code 131056 (and related codes 130429, 131049, 131026) are account-level rate limits, not per-customer delivery failures. The error handling must distinguish these error categories.

### PERMANENT FIX

n8n Code node — "Classify WhatsApp Send Error":
```javascript
const error = $input.first().json.error || {};
const code = error.code;

// Meta WhatsApp error code taxonomy:
const ACCOUNT_RATE_LIMIT_CODES = [130429, 131049, 131056]; // account-level throttle
const RECIPIENT_UNAVAILABLE_CODES = [131026, 131051];       // number unreachable / opted out
const SESSION_EXPIRED_CODES = [131047];                     // 24h window closed
const TEMPLATE_ERROR_CODES = [132000, 132001, 132005];      // template issues
const SYSTEM_ERROR_CODES = [131000, 131008, 131009];        // transient Meta infra errors

let category, action;

if (ACCOUNT_RATE_LIMIT_CODES.includes(code)) {
  category = 'ACCOUNT_RATE_LIMIT';
  action = 'PAUSE_ALL_OUTBOUND'; // Stop ALL sends, alert ops, do NOT use SMS fallback
} else if (RECIPIENT_UNAVAILABLE_CODES.includes(code)) {
  category = 'RECIPIENT_UNAVAILABLE';
  action = 'USE_SMS_FALLBACK';
} else if (SESSION_EXPIRED_CODES.includes(code)) {
  category = 'SESSION_EXPIRED';
  action = 'SEND_TEMPLATE'; // Switch to template message
} else if (SYSTEM_ERROR_CODES.includes(code)) {
  category = 'META_SYSTEM_ERROR';
  action = 'RETRY_WITH_BACKOFF';
} else {
  category = 'UNKNOWN';
  action = 'LOG_AND_ALERT';
}

return [{ json: { category, action, error_code: code, error_message: error.message } }];
```

For `ACCOUNT_RATE_LIMIT` — dedicated handler:
```javascript
if (action === 'PAUSE_ALL_OUTBOUND') {
  // Update settings to pause outbound
  await supabase.from('settings')
    .upsert({ key: 'whatsapp_outbound_paused', value: 'true' });
  await supabase.from('settings')
    .upsert({ key: 'whatsapp_pause_reason', value: `rate_limited_code_${code}` });
  await supabase.from('settings')
    .upsert({ key: 'whatsapp_pause_until', value: new Date(Date.now() + 3600000).toISOString() });

  // Alert ops via Fast2SMS (not WhatsApp, which is broken)
  await fetch(`https://www.fast2sms.com/dev/bulkV2?authorization=${process.env.FAST2SMS_KEY}&message=META+ACCOUNT+RATE+LIMITED.+Outbound+paused.+Check+Meta+Business+Manager.&numbers=${process.env.SUPPORT_PHONE}`);

  return [{ json: { action: 'PAUSED', notify_sent: true } }];
}
```

### VERIFICATION TEST
```bash
# Mock Meta send endpoint to return error code 131056
# Send any outbound message from n8n
# Expected:
# 1. settings.whatsapp_outbound_paused = 'true'
# 2. SUPPORT_PHONE receives SMS alert
# 3. Individual orders do NOT get delivery_failed=true
# 4. SMS fallback is NOT triggered

psql $PGB_URL -c "SELECT value FROM settings WHERE key='whatsapp_outbound_paused';"
# PASS: 'true'
```

### PREVENTION
Daily check: `SELECT count(DISTINCT phone) FROM message_logs WHERE direction='outbound' AND created_at > NOW() - INTERVAL '24 hours'` — alert if approaching 800 (80% of Tier 1 limit) so campaign sends can be throttled proactively.

---

## ISSUE ID: WA-3d
**SEVERITY: Medium**
**TITLE: WhatsApp reply fails after successful DB write — window extends but customer gets no response, next message treated as fresh**

### FAILURE SCENARIO
Customer sends "What's on the menu?". n8n processes message, updates `last_inbound_at`, prepares a menu reply. The Supabase write succeeds but the WhatsApp Send HTTP request fails (Meta API timeout). `last_inbound_at` is now updated. Customer never got a response. Ten minutes later customer sends "Hello?" — the bot treats this as a fresh message in an active session and responds without re-sending the menu.

### EXACT ERROR OR SYMPTOM
Customer: "Hello?" gets a generic response like "Hi! What would you like to order?" — completely unhelpful since they asked for the menu and never got it. No error in logs — the outbound send failure is logged as `delivery_failed` in `message_logs` but there's no mechanism to re-send failed responses.

### ROOT CAUSE
The session state (last_inbound_at) advances on inbound message receipt, not on successful outbound reply. Failed outbound replies leave the customer in an inconsistent state with no recovery path.

### PERMANENT FIX

1. Log every outbound attempt with status:
```sql
-- message_logs already has delivery_status — ensure it's set correctly
-- On WhatsApp send failure, write:
INSERT INTO message_logs (message_id, phone, direction, channel, delivery_status, created_at)
VALUES (gen_random_uuid()::text, $phone, 'outbound', 'whatsapp', 'failed', NOW());
```

2. Track the pending reply in user_sessions:
```sql
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS pending_reply JSONB DEFAULT NULL;
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS pending_reply_at TIMESTAMPTZ DEFAULT NULL;
```

3. n8n — before sending WhatsApp reply, save it:
```javascript
// Save pending reply to user_sessions
await supabase.from('user_sessions')
  .update({
    pending_reply: { type: 'text', message: replyText },
    pending_reply_at: new Date().toISOString()
  })
  .eq('phone', phone);

// Attempt send
try {
  await sendWhatsAppMessage(phone, replyText);
  // Clear pending reply on success
  await supabase.from('user_sessions')
    .update({ pending_reply: null, pending_reply_at: null })
    .eq('phone', phone);
} catch(err) {
  // pending_reply persists — will be re-sent on next inbound
  throw err;
}
```

4. On every inbound message, check for pending reply:
```javascript
// n8n Code node: "Check Pending Reply" — runs early in workflow
const session = $('FetchSession').first().json;

if (session.pending_reply && session.pending_reply_at) {
  const ageMs = Date.now() - new Date(session.pending_reply_at).getTime();
  // If pending reply is < 1 hour old, re-send it first
  if (ageMs < 3600000) {
    return [{ json: {
      action: 'RESEND_PENDING',
      pending_reply: session.pending_reply,
      phone: session.phone,
      then_continue: true  // process current message after re-sending
    }}];
  } else {
    // Too old — clear it
    await supabase.from('user_sessions')
      .update({ pending_reply: null, pending_reply_at: null })
      .eq('phone', session.phone);
  }
}
```

### VERIFICATION TEST
```bash
# 1. Mock WhatsApp send to fail (disable internet or mock with error response)
# 2. Send inbound message "What's on your menu?"
# 3. Verify pending_reply is set in user_sessions:
psql $PGB_URL -c "SELECT pending_reply, pending_reply_at FROM user_sessions WHERE phone='+91TEST';"
# PASS: pending_reply contains menu text

# 4. Re-enable WhatsApp send
# 5. Send inbound message "Hello?"
# Expected: customer receives the menu reply THEN a response to "Hello?"
# PASS: pending_reply cleared to NULL after successful resend
```

### PREVENTION
Alert if `pending_reply_at < NOW() - INTERVAL '2 hours'` on any session — indicates a customer has been waiting 2+ hours for a response that was never sent.

---

## ISSUE ID: WA-3e
**SEVERITY: Critical**
**TITLE: n8n parses webhook JSON before HMAC verification — body re-serialization changes key order, breaking all legitimate HMAC checks**

### FAILURE SCENARIO
n8n's webhook node parses the JSON body automatically. The HMAC verification Code node accesses `$input.first().json` — this is the parsed-then-re-serialized body. Meta computes HMAC on the raw bytes of the original request. JSON re-serialization may change key ordering, add/remove whitespace, or change number representations. Result: HMAC verification fails for every legitimate Meta webhook. Either the system rejects all valid webhooks (system is down) or the HMAC check is disabled/bypassed (security hole).

### EXACT ERROR OR SYMPTOM
If HMAC enforced: every legitimate Meta webhook returns 403. System stops receiving orders entirely. If HMAC check disabled as a "fix": any attacker can forge webhooks with arbitrary payloads. Fake orders, fake cancellations, arbitrary cart manipulation.

### ROOT CAUSE
HMAC-SHA256 is computed over raw bytes. JSON parsing + re-serialization is not byte-preserving. `{"b":1,"a":2}` vs `{"a":2,"b":1}` produce different HMAC values. Node.js `JSON.stringify(JSON.parse(rawBody))` is not guaranteed to preserve key order (though V8 happens to, this is not spec-guaranteed and depends on the JSON library used by n8n internally).

### PERMANENT FIX

n8n Webhook node must be configured to pass the raw body. In n8n's HTTP webhook node settings:

**Option A — n8n webhook "Raw Body" setting:**
In the webhook node, enable **"Raw Body"** option. This stores the raw request body as a string in `$input.first().binary.data` (base64) or `$input.first().json.rawBody` depending on n8n version.

**Verify which field holds raw body:**
```javascript
// Debug Code node — run this to find where raw body is:
const item = $input.first();
console.log('json keys:', Object.keys(item.json));
console.log('binary keys:', Object.keys(item.binary || {}));
console.log('rawBody:', item.json.rawBody);
// Or in newer n8n: item.json.body (string)
```

**HMAC Verification Code node — using raw body:**
```javascript
const crypto = require('crypto');

// Get raw body — try multiple locations depending on n8n version
const rawBody =
  $input.first().json.rawBody ||          // n8n >= 0.211
  $input.first().json.body ||             // some versions
  Buffer.from($input.first().binary?.data?.data || '', 'base64').toString('utf8');

if (!rawBody) {
  throw new Error('HMAC_ERROR: Cannot access raw request body. Enable "Raw Body" in webhook node settings.');
}

const signature = $input.first().json.headers?.['x-hub-signature-256'] || '';
const expectedSig = 'sha256=' + crypto
  .createHmac('sha256', process.env.WHATSAPP_APP_SECRET)
  .update(rawBody, 'utf8')
  .digest('hex');

if (!crypto.timingSafeEqual(
  Buffer.from(signature),
  Buffer.from(expectedSig)
)) {
  // Log but don't leak expected value
  console.error('HMAC mismatch. Received:', signature.substring(0, 20) + '...');
  throw new Error('HMAC_VERIFICATION_FAILED');
}

// HMAC valid — pass through parsed body for downstream nodes
return [{ json: JSON.parse(rawBody) }];
```

**n8n Webhook Node Configuration:**
```json
{
  "httpMethod": "POST",
  "path": "whatsapp",
  "responseMode": "responseNode",
  "options": {
    "rawBody": true
  }
}
```

### VERIFICATION TEST
```bash
# Generate a known HMAC
SECRET="test_app_secret"
BODY='{"entry":[{"changes":[{"value":{"messages":[{"id":"wamid.test","type":"text","text":{"body":"hello"},"from":"+919876543210"}]}}]}]}'
SIG="sha256=$(echo -n "$BODY" | openssl dgmac -sha256 -hmac "$SECRET" | awk '{print $2}')"

# Send to webhook with correct HMAC
curl -X POST https://n8n.your-domain.com/webhook/whatsapp \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: $SIG" \
  -d "$BODY"
# PASS: n8n processes normally (200 OK, workflow continues)

# Send with wrong HMAC
curl -X POST https://n8n.your-domain.com/webhook/whatsapp \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: sha256=wrongsignature" \
  -d "$BODY"
# PASS: workflow throws HMAC_VERIFICATION_FAILED, no order processing
```

### PREVENTION
Add a daily automated test that sends a webhook with a known-good HMAC to a test endpoint and verifies processing. Alert if HMAC failures exceed 0 on legitimate Meta IP addresses (Meta publishes their IP ranges).

---

# CATEGORY 4: SUPABASE REALTIME & KDS FAILURES

---

## ISSUE ID: KDS-4a
**SEVERITY: Medium**
**TITLE: kds_pings table grows unbounded — 43,200 rows/month degrades INSERT and Realtime publication performance**

### FAILURE SCENARIO
The application-level realtime health check inserts one row into `kds_pings` every 60 seconds. After 30 days: 43,200 rows. After 1 year: 525,600 rows. The table has no cleanup job.

### EXACT ERROR OR SYMPTOM
After 3 months: `INSERT INTO kds_pings` starts taking 50–200ms instead of <1ms due to index bloat and table bloat. Supabase Realtime publication latency for kds_pings events increases (Realtime's WAL reader has to process more writes). Dashboard may start timing out on `SELECT count(*) FROM kds_pings`. Health check response time becomes a false positive for actual realtime health.

### ROOT CAUSE
No TTL or cleanup mechanism on the kds_pings table. Rows accumulate indefinitely.

### PERMANENT FIX

```sql
-- 1. Add index to make cleanup efficient (if not already present)
CREATE INDEX IF NOT EXISTS idx_kds_pings_created_at ON kds_pings(created_at);

-- 2. pg_cron cleanup job — runs every 10 minutes, deletes rows older than 1 hour
SELECT cron.schedule(
  'cleanup-kds-pings',
  '*/10 * * * *',
  $$DELETE FROM kds_pings WHERE created_at < NOW() - INTERVAL '1 hour'$$
);

-- 3. Alternatively, if pg_cron is not available, use a PostgreSQL table with a TTL trigger:
CREATE OR REPLACE FUNCTION cleanup_old_kds_pings()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- On every INSERT, delete rows older than 2 hours (amortized cleanup)
  IF (SELECT count(*) FROM kds_pings) > 200 THEN
    DELETE FROM kds_pings WHERE created_at < NOW() - INTERVAL '2 hours';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_kds_pings_cleanup
AFTER INSERT ON kds_pings
FOR EACH ROW EXECUTE FUNCTION cleanup_old_kds_pings();

-- 4. Immediate cleanup of existing bloat:
DELETE FROM kds_pings WHERE created_at < NOW() - INTERVAL '2 hours';
VACUUM ANALYZE kds_pings;
```

### VERIFICATION TEST
```bash
# Check current table size
psql $PGB_URL -c "SELECT count(*), pg_size_pretty(pg_total_relation_size('kds_pings')) FROM kds_pings;"

# Insert 200 test rows with old timestamps
psql $PGB_URL -c "
INSERT INTO kds_pings (device_id, created_at)
SELECT 'test-device', NOW() - (i || ' minutes')::INTERVAL
FROM generate_series(1, 200) AS i;"

# Wait 1 pg_cron cycle (or trigger INSERT to fire cleanup trigger)
psql $PGB_URL -c "INSERT INTO kds_pings (device_id) VALUES ('trigger-cleanup');"

# Verify old rows removed:
psql $PGB_URL -c "SELECT count(*) FROM kds_pings WHERE created_at < NOW() - INTERVAL '2 hours';"
# PASS: count = 0
```

### PREVENTION
Weekly alert: `SELECT count(*) FROM kds_pings -- alert if > 10000`. Means cleanup job has failed.

---

## ISSUE ID: KDS-4b
**SEVERITY: High**
**TITLE: Allergen acknowledgment RLS policy too permissive or missing — bar station chef can ACK orders for grill station, or cannot ACK at all**

### FAILURE SCENARIO
Two KDS devices open: grill station and bar station. An allergen order arrives. Both show the ACK button. Chef at grill station taps it. The ACK must be recorded with `allergen_ack_device = grill_device_uuid`. Bar station should immediately update to show "acknowledged." 

Two failure modes: (a) kitchen role lacks UPDATE permission on allergen columns → ACK silently fails, (b) permissive policy allows any kitchen user to ACK any order regardless of station assignment.

### EXACT ERROR OR SYMPTOM
Mode (a): Chef taps ACK button. React makes Supabase `.update()` call. Returns `0 rows updated` because RLS denies it. No error shown on KDS UI (if the React component doesn't check count). Both stations still show unacknowledged. Allergen order delivered without formal ACK. Legal liability.

Mode (b): Bar-station chef ACKs a grill-station allergen order. `allergen_ack_device` records the bar station UUID. Audit log is misleading — bar station chef allegedly ACK'd an order they never saw.

### ROOT CAUSE
Standard RLS for kitchen role covers SELECT and status UPDATE but may not explicitly include the allergen columns. Without a specific policy, PostgREST UPDATE returns 0 rows (RLS blocks the write silently).

### PERMANENT FIX

```sql
-- Restrictive RLS: kitchen users can only UPDATE status and allergen_ack fields
-- They CANNOT update financial fields, phone, items, etc.

-- First: ensure RLS is enabled
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

-- Drop any existing overly-broad kitchen policies
DROP POLICY IF EXISTS kitchen_update_policy ON orders;

-- Restrictive status transition policy (kitchen can only move forward in lifecycle)
CREATE POLICY kitchen_status_update ON orders
FOR UPDATE
TO authenticated
USING (
  auth.jwt() ->> 'role' = 'kitchen'
  AND status IN ('order_received', 'preparing', 'ready_for_pickup')
)
WITH CHECK (
  auth.jwt() ->> 'role' = 'kitchen'
  AND status IN ('preparing', 'ready_for_pickup', 'completed')
  -- Cannot set back to order_received, cannot cancel
);

-- Separate policy for allergen ACK (kitchen can update allergen fields on any active order)
CREATE POLICY kitchen_allergen_ack ON orders
FOR UPDATE
TO authenticated
USING (
  auth.jwt() ->> 'role' = 'kitchen'
  AND allergen_alert = TRUE
  AND allergen_ack_at IS NULL  -- can only ACK once
)
WITH CHECK (
  auth.jwt() ->> 'role' = 'kitchen'
  AND allergen_ack_at IS NOT NULL  -- new value must set the timestamp
);

-- Kitchen SELECT: see all active orders
CREATE POLICY kitchen_select ON orders
FOR SELECT
TO authenticated
USING (
  auth.jwt() ->> 'role' IN ('kitchen', 'manager', 'owner')
  AND status NOT IN ('cancelled')
);
```

KDS React allergen ACK call:
```javascript
// kds-web/src/components/OrderTicket.jsx
const handleAllergenAck = async (orderId) => {
  const deviceUuid = localStorage.getItem('kds_device_uuid') || await getOrCreateDeviceUuid()

  const { data, error, count } = await supabase
    .from('orders')
    .update({
      allergen_ack_at: new Date().toISOString(),
      allergen_ack_device: deviceUuid
    })
    .eq('order_id', orderId)
    .eq('allergen_ack_at', null)  // prevent double-ACK
    .select('order_id, allergen_ack_device')

  if (error) {
    console.error('Allergen ACK failed:', error)
    toast.error('Failed to acknowledge allergen — try again')
    return
  }
  if (!data || data.length === 0) {
    toast.warning('Already acknowledged by another station')
  }
}
```

Realtime propagation: Supabase Realtime will broadcast the UPDATE event to ALL subscribed clients (both KDS devices) automatically since they're on the same channel. Bar station's React state updates via the realtime listener:
```javascript
// Both KDS devices subscribe to the same channel
const channel = supabase.channel('orders_realtime')
  .on('postgres_changes', {
    event: 'UPDATE', schema: 'public', table: 'orders'
  }, (payload) => {
    // Both devices receive this — update local state
    setOrders(prev => prev.map(o =>
      o.order_id === payload.new.order_id ? payload.new : o
    ))
  })
  .subscribe()
```

### VERIFICATION TEST
```bash
# Test as kitchen role user:
# 1. Login with kitchen role JWT
# 2. Attempt to update allergen_ack_at on an allergen order
curl -X PATCH https://your-project.supabase.co/rest/v1/orders?order_id=eq.1 \
  -H "Authorization: Bearer $KITCHEN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"allergen_ack_at":"2024-01-15T20:00:00Z","allergen_ack_device":"test-uuid"}'
# PASS: 200 with 1 row updated

# 3. Try to update phone number (should be blocked):
curl -X PATCH https://your-project.supabase.co/rest/v1/orders?order_id=eq.1 \
  -H "Authorization: Bearer $KITCHEN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"phone":"+910000000000"}'
# PASS: 0 rows updated (RLS blocks — no WITH CHECK allows this)
```

### PREVENTION
Daily query: `SELECT count(*) FROM orders WHERE allergen_alert=TRUE AND allergen_ack_at IS NULL AND status='completed'` — unacknowledged allergen orders that were still delivered. Alert immediately on any result > 0.

---

## ISSUE ID: KDS-4c
**SEVERITY: High**
**TITLE: KDS boot recovery query uses 4-hour fixed window — misses active late-night orders on post-midnight reboot**

### FAILURE SCENARIO
Restaurant operates Friday night. Orders come in at 11:30 PM. KDS reboots at 1:00 AM (power flicker). Boot recovery query: `WHERE confirmed_at > NOW() - INTERVAL '4 hours'` — this recovers orders back to 9 PM. But the 11:30 PM orders are only 1.5 hours ago — so they're included. However: if `AMENDMENT_WINDOW_MINS=30` and the restaurant closes at 1 AM, orders from 12:40 AM that are `ready_for_pickup` but not yet `completed` are within the window. But the 4-hour fixed window actually works for 1 AM... the real failure is when the restaurant closes at midnight and reopens at 7 AM, and the KDS reboots at 7:01 AM — it only looks back 4 hours (to 3 AM) and misses any orders from the night before that were never marked `completed` (e.g., table never paid, order stuck in `ready_for_pickup`).

### EXACT ERROR OR SYMPTOM
Chef reboots KDS at 7:01 AM. Orders from 11:30 PM the night before that are stuck in `preparing` or `ready_for_pickup` do not appear. They are invisible. Manager doesn't know they exist unless they check the Manager Portal.

### ROOT CAUSE
Fixed time window (`NOW() - INTERVAL '4 hours'`) is the wrong filter. The correct filter is: **any order in a non-terminal status**, regardless of age. Terminal statuses are `completed` and `cancelled`.

### PERMANENT FIX

```javascript
// kds-web/src/hooks/useOrderRecovery.js
export async function fetchActiveOrdersOnBoot() {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .in('status', ['order_received', 'preparing', 'ready_for_pickup'])
    // No time filter — all non-terminal orders, regardless of age
    .order('confirmed_at', { ascending: true })

  if (error) throw error

  // Secondary: also fetch orders from last 2 hours that are 'completed'
  // (they may still be cooling/on the pass)
  const { data: recentCompleted } = await supabase
    .from('orders')
    .select('*')
    .eq('status', 'completed')
    .gte('confirmed_at', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
    .order('confirmed_at', { ascending: true })

  return [...(data || []), ...(recentCompleted || [])]
}
```

Also query the DB for this on KDS boot splash screen:
```javascript
// Show "X orders recovered" on boot
const recovered = await fetchActiveOrdersOnBoot()
if (recovered.length > 0) {
  showBootRecoveryModal({
    count: recovered.length,
    oldestOrder: recovered[0],  // show timestamp so chef knows how old
    message: `${recovered.length} active orders loaded. Oldest: ${formatAge(recovered[0].confirmed_at)}`
  })
}
```

### VERIFICATION TEST
```bash
# Create an order with confirmed_at = 8 hours ago, status = 'preparing'
psql $PGB_URL -c "
INSERT INTO orders (display_id, phone, table_number, items, status, subtotal, tax_rate, tax_amount, total, idempotency_key, confirmed_at)
VALUES ('OLD001', '+91TEST', 'T1', '[]', 'preparing', 100, 0.05, 5, 105, 'TEST-OLD-001', NOW() - INTERVAL '8 hours');"

# Simulate KDS boot — call the recovery function
# Expected: OLD001 appears in recovered orders list
# FAIL (old behavior): 4-hour window query returns 0 rows for 8-hour-old order
# PASS (new behavior): status-based query returns OLD001 regardless of age
```

### PREVENTION
Alert: `SELECT count(*) FROM orders WHERE status NOT IN ('completed','cancelled') AND confirmed_at < NOW() - INTERVAL '6 hours'` — stuck orders older than 6 hours. Alert immediately.

---

## ISSUE ID: KDS-4d
**SEVERITY: High**
**TITLE: Safari on iPad clears localStorage after 7 days of inactivity — device_uuid lost, allergen_ack_device becomes null after weekly closure**

### FAILURE SCENARIO
Restaurant closes for a week (holiday). KDS iPads are not used. Safari's Intelligent Tracking Prevention clears localStorage for PWAs with no user interaction for 7 days. When the restaurant reopens, every KDS device loads with no `device_uuid` in localStorage. A new UUID is generated. The old `kds_devices` registration is orphaned. `allergen_ack_device` in the audit log now records a new UUID that has no corresponding `kds_devices.station` entry — the audit log is legally incomplete.

### EXACT ERROR OR SYMPTOM
Allergen orders processed after reopening have `allergen_ack_device = new-random-uuid`. The `kds_devices` table has no row for that UUID, so station attribution is impossible. Regulatory audit cannot prove which station confirmed the allergen order. Legal liability in food safety compliance.

### ROOT CAUSE
Safari's 7-day localStorage purge is documented ITP behavior for PWAs. localStorage is the wrong persistence layer for legally required identifiers.

### PERMANENT FIX

Use IndexedDB (not cleared by ITP on the same timeline) + a server-side device registration that can be recovered by logging in again with the same credentials.

```javascript
// kds-web/src/lib/deviceIdentity.js
import { openDB } from 'idb'  // npm install idb

const DB_NAME = 'kds_device_identity'
const DB_VERSION = 1

async function getOrCreateDeviceDb() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      db.createObjectStore('identity')
    }
  })
}

export async function getOrCreateDeviceUuid(supabase, stationAssignment) {
  const db = await getOrCreateDeviceDb()

  // Try IndexedDB first (survives Safari ITP longer than localStorage)
  let deviceUuid = await db.get('identity', 'device_uuid')

  if (!deviceUuid) {
    // Not in IndexedDB — check if this device has a server-side registration
    // linked to the current user's auth (logged-in kitchen user → station)
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      const { data: existing } = await supabase
        .from('kds_devices')
        .select('device_uuid')
        .eq('registered_user_id', user.id)
        .eq('station', stationAssignment)
        .single()

      if (existing) {
        deviceUuid = existing.device_uuid
      }
    }
  }

  if (!deviceUuid) {
    // Truly new device — create and register
    deviceUuid = crypto.randomUUID()
    const { data: { user } } = await supabase.auth.getUser()

    await supabase.from('kds_devices').upsert({
      device_uuid: deviceUuid,
      station: stationAssignment,
      registered_user_id: user?.id,
      last_seen_at: new Date().toISOString()
    })
  }

  // Write to both IndexedDB AND localStorage (belt-and-suspenders)
  await db.put('identity', deviceUuid, 'device_uuid')
  localStorage.setItem('kds_device_uuid', deviceUuid)

  return deviceUuid
}
```

DB schema update:
```sql
ALTER TABLE kds_devices ADD COLUMN IF NOT EXISTS registered_user_id UUID REFERENCES auth.users(id);
CREATE INDEX IF NOT EXISTS idx_kds_devices_user_station ON kds_devices(registered_user_id, station);
```

On KDS boot, always call `getOrCreateDeviceUuid()` and update `last_seen_at`:
```javascript
// kds-web/src/App.jsx — in useEffect on mount
const deviceUuid = await getOrCreateDeviceUuid(supabase, selectedStation)
await supabase.from('kds_devices').update({ last_seen_at: new Date().toISOString() })
  .eq('device_uuid', deviceUuid)
```

### VERIFICATION TEST
```bash
# 1. Register KDS device normally — note the device_uuid
# 2. Clear IndexedDB and localStorage (simulate Safari ITP):
#    In Chrome DevTools: Application → Storage → Clear site data
# 3. Log in to KDS with the same kitchen user credentials
# 4. Expected: same device_uuid recovered from kds_devices table
psql $PGB_URL -c "SELECT device_uuid, station FROM kds_devices WHERE registered_user_id='$USER_ID';"
# PASS: same UUID as before the clear
```

### PREVENTION
Nightly check: `SELECT * FROM orders WHERE allergen_ack_at IS NOT NULL AND allergen_ack_device NOT IN (SELECT device_uuid FROM kds_devices)` — any allergen ACK from an unregistered device. Alert immediately.

---

## ISSUE ID: KDS-4e
**SEVERITY: Medium**
**TITLE: setInterval countdown on "ready" ticket pauses while iPad sleeps — stale ticket persists after chef wakes device**

### FAILURE SCENARIO
KDS moves a ticket to "ready_for_pickup." A 30-second countdown starts before the ticket auto-dismisses. Chef sets down the iPad (iOS throttles/pauses JavaScript intervals for backgrounded PWAs). iPad sleeps after 30 seconds. Chef picks it up 2 minutes later. The ticket should have disappeared 90 seconds ago but is still showing — the interval resumed from where it paused.

### EXACT ERROR OR SYMPTOM
Stale "ready" tickets accumulate on the KDS screen. Chef thinks orders are still pending. Plates sit under heat lamps longer than necessary. Food quality degrades. During busy periods, the KDS becomes cluttered with ghost tickets.

### ROOT CAUSE
`setInterval` increments a counter each tick. When iOS throttles/pauses intervals in background, ticks are missed. On wake, the counter resumes from its paused value. If 30 ticks were expected but only 10 ran before sleep, the countdown shows "20 seconds remaining" when it should show "already expired."

### PERMANENT FIX
Use `Date.now()` wall-clock comparisons instead of tick counting:

```javascript
// kds-web/src/components/ReadyTicketCountdown.jsx
import { useState, useEffect, useRef } from 'react'

export function ReadyTicketCountdown({ readyAt, durationMs = 30000, onExpire }) {
  const [remaining, setRemaining] = useState(durationMs)
  const expireTime = useRef(new Date(readyAt).getTime() + durationMs)
  const intervalRef = useRef(null)

  useEffect(() => {
    const check = () => {
      const now = Date.now()
      const left = expireTime.current - now

      if (left <= 0) {
        clearInterval(intervalRef.current)
        onExpire()  // Remove ticket from DOM
        return
      }
      setRemaining(left)
    }

    check()  // Immediate check on mount (catches already-expired tickets on wake)
    intervalRef.current = setInterval(check, 1000)

    // Also check on page visibility change (wake from sleep)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        check()  // Immediately evaluate on wake
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      clearInterval(intervalRef.current)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [readyAt])

  const seconds = Math.ceil(remaining / 1000)
  return (
    <div className="countdown" aria-label={`Ticket expires in ${seconds} seconds`}>
      {seconds}s
    </div>
  )
}
```

On KDS app-level wake detection:
```javascript
// kds-web/src/App.jsx
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    // Re-evaluate all ready tickets against wall clock
    const now = Date.now()
    setOrders(prev => prev.filter(order => {
      if (order.status !== 'ready_for_pickup') return true
      const readyTime = new Date(order.updated_at).getTime()
      const ageMs = now - readyTime
      return ageMs < 30000  // Remove if already past 30s dismiss window
    }))
  }
})
```

### VERIFICATION TEST
```bash
# 1. Set an order to ready_for_pickup with updated_at = 45 seconds ago
psql $PGB_URL -c "UPDATE orders SET status='ready_for_pickup', updated_at=NOW()-INTERVAL '45 seconds' WHERE order_id=1;"

# 2. Open KDS in browser, navigate away (simulates background)
# 3. Wait 10 seconds, navigate back
# 4. Expected: ticket is already expired/hidden (45s > 30s dismiss window)
# FAIL (old behavior): countdown shows ~20s remaining (interval-based)
# PASS (new behavior): ticket immediately gone on visibility change
```

### PREVENTION
Add a KDS integration test that: (1) creates a ready_for_pickup order with >30s age, (2) mounts the KDS component, (3) fires a `visibilitychange` event, (4) asserts the ticket is not in the DOM.

---

*End of Part 2 — Categories 3 & 4 (10 more issues). Continuing in Part 3 with Categories 5–6.*
