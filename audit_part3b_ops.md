# Adversarial System Audit — Part 3b of 4
## Category 6: Operational Real-World Scenarios

---

## ISSUE ID: OPS-6a
**SEVERITY: High**
**TITLE: Friday rush 15 concurrent orders exhaust PgBouncer pool — subsequent connections timeout/error**

### FAILURE SCENARIO
Friday 8 PM, 15 customers send orders in 30 seconds. n8n runs 15 parallel executions. Each execution makes 3–5 DB calls (dedup check, session fetch, Groq, cart upsert, settings check). Each DB call acquires a PgBouncer connection from the pool. Supabase Free tier: 60 direct connections, PgBouncer pool default_pool_size = 15. Pro tier: 100 direct/60 PgBouncer.

### EXACT ERROR OR SYMPTOM
If using stored procedures (single call per cart op — good), each execution holds 1 connection for ~200ms per call. 15 executions × 5 calls × 200ms = connections cycle fast enough. But if any call takes >1s (Groq timeout causes n8n to retry DB), connections pile up. At pool_size=15, the 16th concurrent connection request waits in PgBouncer's queue. Default `server_connect_timeout` is 15s. If all 15 pool slots are occupied for >15s, new connections fail with `ERROR: no more connections allowed`.

On Supabase Free tier with default pool_size=15: 15 concurrent long-running stored procedures will saturate the pool. Customer 16 gets a timeout error. n8n logs show Postgres connection timeout. Customer receives no response.

### ROOT CAUSE
PgBouncer pool_size is too small for peak concurrent load when n8n concurrency limit (50) far exceeds available pool connections (15).

### PERMANENT FIX

**1. Right-size the pool:**
```
# Calculation for a restaurant doing peak 15 concurrent orders:
# Each order = ~5 DB calls × ~200ms avg = 1 second of total DB connection time
# 15 orders × 1s / 200ms per call = ~5 connections needed simultaneously
# Add 50% headroom = 8 connections needed
# Add KDS + Manager Portal (2–3 persistent connections) = 11
# Add pg_cron + realtime slots (3) = 14
# Recommended pool_size: 20 (on Supabase Pro = pool_size supported up to 60)

# Set in Supabase Dashboard → Database → Connection Pooling:
pool_size = 20
```

**2. Reduce n8n concurrency to match pool capacity:**
```bash
# .env for n8n
N8N_CONCURRENCY_PRODUCTION_LIMIT=20  # not 50 — match pool capacity
```

**3. Add connection timeout handling in n8n:**
```javascript
// n8n Code node: wrapper for all Postgres calls
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 500;

async function dbCallWithRetry(queryFn) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await queryFn();
    } catch (err) {
      const isPoolExhausted =
        err.message?.includes('no more connections') ||
        err.message?.includes('connection timeout') ||
        err.message?.includes('too many clients');

      if (isPoolExhausted && attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}
```

### VERIFICATION TEST
```bash
# Simulate 20 concurrent connections:
for i in $(seq 1 20); do
  psql $SUPABASE_PGBOUNCER_URL -c "SELECT pg_sleep(2);" &
done
wait
# PASS: all 20 complete without error (pool_size >= 20)
# FAIL: some return "no more connections allowed"
```

### PREVENTION
Monitor: `SHOW POOLS;` on PgBouncer admin console or Supabase dashboard — alert if `cl_waiting > 0` for more than 30 seconds.

---

## ISSUE ID: OPS-6b
**SEVERITY: Medium**
**TITLE: Replacement KDS iPad setup requires technical knowledge — chef cannot set up in 2 minutes unassisted**

### FAILURE SCENARIO
Primary KDS iPad falls in fryer. Chef grabs a spare iPad. Needs to: (1) open Safari, (2) navigate to KDS URL, (3) log in with kitchen credentials, (4) select station, (5) "Add to Home Screen" for PWA, (6) catch up on missed orders. Step 3 requires knowing the email/password for the kitchen account. Step 5 requires knowing the Safari share menu trick. Step 6 happens automatically (boot recovery from KDS-4c fix).

### EXACT ERROR OR SYMPTOM
Chef cannot log in because they don't know the kitchen email/password (it was saved in the old iPad's browser). Chef calls manager. Manager doesn't know it either (the developer set it up months ago). Service halts for 10+ minutes while someone finds credentials.

### PERMANENT FIX

**1. QR code-based setup (printed and laminated, taped to the kitchen wall):**

```javascript
// manager-portal/src/pages/KdsSetup.jsx
import { QRCodeSVG } from 'qrcode.react'  // npm install qrcode.react

export function KdsSetupQR() {
  // Generate a time-limited setup URL with embedded auth token
  const generateSetupUrl = async () => {
    // Create a short-lived magic link for kitchen role
    const { data, error } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: 'kitchen@restaurant.local',
      options: {
        redirectTo: `${window.location.origin}/kitchen?station=auto`,
      }
    })
    // This link expires in 24 hours by default
    return data?.properties?.action_link
  }

  const [url, setUrl] = useState('')

  useEffect(() => {
    generateSetupUrl().then(setUrl)
  }, [])

  return (
    <div className="kds-setup-card">
      <h2>KDS Quick Setup</h2>
      <p>Scan this QR code from a new iPad to set up the Kitchen Display.</p>
      {url && <QRCodeSVG value={url} size={256} />}
      <p className="small">This code expires in 24 hours. Generate a new one from Manager Portal.</p>
      <button onClick={() => window.print()}>Print for Kitchen Wall</button>
    </div>
  )
}
```

**2. PIN-based login for kitchen staff (no email/password needed):**

```sql
-- Add PIN column to staff profiles
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS kitchen_pin TEXT;

-- Or use a separate table:
CREATE TABLE IF NOT EXISTS staff_pins (
  pin         TEXT PRIMARY KEY,  -- 4-digit PIN
  role        TEXT NOT NULL,
  station     TEXT,
  created_by  UUID REFERENCES auth.users(id),
  active      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Insert kitchen PINs:
INSERT INTO staff_pins (pin, role, station) VALUES
('1234', 'kitchen', 'grill'),
('5678', 'kitchen', 'bar'),
('9012', 'kitchen', 'all');
```

```javascript
// kds-web/src/pages/PinLogin.jsx
function PinLogin() {
  const [pin, setPin] = useState('')

  const handlePinSubmit = async () => {
    const { data, error } = await supabase
      .from('staff_pins')
      .select('role, station')
      .eq('pin', pin)
      .eq('active', true)
      .single()

    if (error || !data) {
      toast.error('Invalid PIN')
      return
    }

    // Sign in with kitchen service account
    const { error: authError } = await supabase.auth.signInWithPassword({
      email: `kitchen-${data.station}@restaurant.local`,
      password: process.env.VITE_KITCHEN_SERVICE_PASSWORD,
    })

    if (!authError) {
      navigate(`/kitchen?station=${data.station}`)
    }
  }

  return (
    <div className="pin-login">
      <h1>Kitchen Display</h1>
      <p>Enter your station PIN:</p>
      <input type="password" inputMode="numeric" maxLength={4}
             value={pin} onChange={e => setPin(e.target.value)}
             autoFocus />
      <button onClick={handlePinSubmit}>Enter Kitchen</button>
    </div>
  )
}
```

**3. Auto Add-to-Home-Screen prompt:**
```javascript
// kds-web/src/components/InstallPrompt.jsx
function InstallPrompt() {
  const [showPrompt, setShowPrompt] = useState(false)

  useEffect(() => {
    // Detect if in standalone PWA mode
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone
    if (!isStandalone) {
      setShowPrompt(true)
    }
  }, [])

  if (!showPrompt) return null
  return (
    <div className="install-banner">
      📱 For best experience, tap <strong>Share → Add to Home Screen</strong>
      <button onClick={() => setShowPrompt(false)}>Dismiss</button>
    </div>
  )
}
```

### VERIFICATION TEST
```bash
# 1. Print the QR code from Manager Portal
# 2. Open Camera on a fresh iPad
# 3. Scan QR code
# 4. Safari opens, magic link auto-logs in
# 5. Station assignment screen shows
# 6. Chef picks station → KDS loads with all active orders
# Total time: < 2 minutes
# PASS: chef can do this with zero technical knowledge
```

### PREVENTION
Include a laminated "KDS EMERGENCY SETUP" card in the kitchen emergency kit. Generate a new QR weekly via automated n8n schedule trigger.

---

## ISSUE ID: OPS-6c
**SEVERITY: High**
**TITLE: Three customers confirm orders with 86'd item — no proactive cart notification, all three get errors at checkout**

### FAILURE SCENARIO
Manager marks Truffle Burger `available=false` at 7 PM. Three customers already have it in their carts. They each tap "Confirm" between 7:02–7:04 PM. The checkout flow calls `create_order_idempotent` which uses the `upsert_cart_item` procedure (or re-validates items) — the 86'd item hits `ITEM_UNAVAILABLE` exception. All three get an error.

### EXACT ERROR OR SYMPTOM
If using the stored procedure from DB-1a (which checks `available=TRUE`): the order INSERT pre-validates and raises `ITEM_UNAVAILABLE: BURGER01`. n8n catches this and should send a message to the customer. But three simultaneous exceptions during rush hour = three unhappy customers who thought their order was ready.

The deeper issue: the customers were **never proactively told** that the item was 86'd while it sat in their cart. They found out only at checkout.

### PERMANENT FIX

**Proactive notification on 86 toggle — notify customers with affected carts:**

```sql
-- Trigger on menu_items.available change
CREATE OR REPLACE FUNCTION notify_carts_on_86()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  affected_session RECORD;
BEGIN
  -- Only fire when item becomes unavailable
  IF OLD.available = TRUE AND NEW.available = FALSE THEN
    -- Find all sessions with this item in cart
    FOR affected_session IN
      SELECT phone, cart
      FROM user_sessions
      WHERE cart @> jsonb_build_array(jsonb_build_object('item_code', NEW.item_code))
    LOOP
      -- Queue notification for each affected customer
      INSERT INTO notification_queue (order_id, event_type, payload)
      VALUES (
        0,  -- no order_id, this is a cart notification
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
      'item_name', NEW.name,
      'affected_count', (
        SELECT count(*) FROM user_sessions
        WHERE cart @> jsonb_build_array(jsonb_build_object('item_code', NEW.item_code))
      )
    )::TEXT);
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_menu_item_86_notify
AFTER UPDATE OF available ON menu_items
FOR EACH ROW EXECUTE FUNCTION notify_carts_on_86();
```

n8n workflow to process `item_86d_in_cart` notifications:
```javascript
// n8n processes notification_queue entries with event_type='item_86d_in_cart'
const payload = $input.first().json;
const phone = payload.phone;
const itemName = payload.item_name;

// Build alternatives message
let altMsg = '';
if (payload.similar_items?.length) {
  const { data: alts } = await supabase
    .from('menu_items')
    .select('item_code, name, price')
    .in('item_code', payload.similar_items)
    .eq('available', true);
  
  if (alts?.length) {
    altMsg = `\n\nSimilar items: ${alts.map(a => `${a.name} ₹${a.price}`).join(', ')}`;
  }
}

return [{ json: {
  action: 'SEND_MESSAGE',
  phone,
  message: `⚠️ *${itemName}* just became unavailable and is in your cart.\n\nIt will be removed when you confirm. You can add a replacement now.${altMsg}\n\nType VIEW CART to see your current items.`
}}];
```

**Also: Auto-remove 86'd items from cart at checkout time** (in the order creation procedure):
```sql
-- Inside create_order_idempotent, before INSERT:
-- Filter out unavailable items from the cart
WITH valid_items AS (
  SELECT elem
  FROM jsonb_array_elements(p_items) AS elem
  JOIN menu_items m ON m.item_code = elem ->> 'item_code'
  WHERE m.available = TRUE
)
SELECT jsonb_agg(elem) INTO p_items FROM valid_items;

IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
  RAISE EXCEPTION 'ALL_ITEMS_UNAVAILABLE: cart contains only 86d items';
END IF;

-- Recalculate subtotal with only available items
SELECT sum((elem ->> 'price')::NUMERIC * (elem ->> 'quantity')::INT)
INTO p_subtotal
FROM jsonb_array_elements(p_items) AS elem;

p_tax_amount := p_subtotal * p_tax_rate;
p_total := p_subtotal + p_tax_amount;
```

### VERIFICATION TEST
```bash
# 1. Add BURGER01 to 3 test users' carts
# 2. Mark BURGER01 unavailable:
psql $PGB_URL -c "UPDATE menu_items SET available=FALSE WHERE item_code='BURGER01';"
# 3. Check notification_queue:
psql $PGB_URL -c "SELECT * FROM notification_queue WHERE event_type='item_86d_in_cart';"
# PASS: 3 rows, one per affected phone number
```

### PREVENTION
Dashboard metric: "Customers with 86'd items in cart" — real-time count displayed in Manager Portal.

---

## ISSUE ID: OPS-6d
**SEVERITY: Critical**
**TITLE: 8-minute Supabase outage — n8n errors cascade, KDS goes stale, potential duplicate orders on recovery**

### FAILURE SCENARIO
Supabase regional outage from 8:00 PM to 8:08 PM. All PostgreSQL connections fail. Realtime WebSocket disconnects. All KDS and Manager Portal API calls return errors.

### EXACT ERROR OR SYMPTOM
- **Customers**: Send WhatsApp messages. n8n receives them (n8n is up, Meta webhook works). n8n tries to read `message_logs` for dedup → DB connection error. n8n's error handler either (a) silently drops the message, or (b) responds with a generic error to the customer.
- **KDS**: Realtime subscription drops. Screen shows last known state. "Connection lost" banner should appear (if implemented). Chef cannot bump orders.
- **Manager Portal**: All actions fail with network error toasts.
- **Recovery at 8:08 PM**: Supabase comes back. n8n processes any queued/retried Meta webhooks. Messages that arrived during outage may be processed out of order. If Meta retried messages during the outage, and dedup failed because `message_logs` was down, the same message may be processed twice — creating duplicate cart entries or duplicate orders.

### PERMANENT FIX

**1. n8n: In-memory dedup cache as fallback when DB is down:**
```javascript
// n8n Code node: "Dedup with Fallback"
// Use staticData as an in-memory dedup cache when DB is unavailable
if (!$workflow.staticData.dedupCache) {
  $workflow.staticData.dedupCache = {};
  $workflow.staticData.dedupCacheCleanupAt = Date.now();
}

const messageId = $input.first().json.message_id;

// Clean cache every 30 minutes
if (Date.now() - $workflow.staticData.dedupCacheCleanupAt > 1800000) {
  const cutoff = Date.now() - 3600000;
  for (const [k, v] of Object.entries($workflow.staticData.dedupCache)) {
    if (v < cutoff) delete $workflow.staticData.dedupCache[k];
  }
  $workflow.staticData.dedupCacheCleanupAt = Date.now();
}

// Check in-memory first (fast, always available)
if ($workflow.staticData.dedupCache[messageId]) {
  return []; // Already processed — skip
}

// Try DB dedup
let dbAvailable = true;
try {
  const result = await dbQuery('SELECT 1 FROM message_logs WHERE message_id = $1', [messageId]);
  if (result.length > 0) {
    $workflow.staticData.dedupCache[messageId] = Date.now();
    return []; // Already in DB — skip
  }
} catch (dbErr) {
  dbAvailable = false;
  console.error('DB unavailable for dedup:', dbErr.message);
}

// Mark as seen in memory
$workflow.staticData.dedupCache[messageId] = Date.now();

if (!dbAvailable) {
  // DB is down — queue the message for later processing
  // Send a "we're experiencing issues" message to customer
  return [{ json: {
    action: 'SEND_MESSAGE',
    phone: $input.first().json.phone,
    message: '⏳ We are experiencing a brief technical issue. Your message has been received and will be processed shortly. Please wait 2-3 minutes.',
    db_down: true
  }}];
}

// DB available — continue normal flow
return [{ json: { ...($input.first().json), deduplicated: true } }];
```

**2. KDS: Offline resilience banner + local state preservation:**
```javascript
// kds-web/src/hooks/useRealtimeConnection.js
const [isConnected, setIsConnected] = useState(true)
const [reconnectAttempt, setReconnectAttempt] = useState(0)

useEffect(() => {
  const channel = supabase.channel('orders')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, handler)
    .subscribe((status) => {
      setIsConnected(status === 'SUBSCRIBED')
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        setIsConnected(false)
        // Exponential backoff reconnect
        setTimeout(() => {
          channel.subscribe()
          setReconnectAttempt(prev => prev + 1)
        }, Math.min(2000 * Math.pow(2, reconnectAttempt), 30000))
      }
    })

  return () => supabase.removeChannel(channel)
}, [])

// On reconnect: full state refresh
useEffect(() => {
  if (isConnected && reconnectAttempt > 0) {
    fetchActiveOrdersOnBoot().then(setOrders)  // Full refresh from DB
  }
}, [isConnected])
```

### VERIFICATION TEST
```bash
# 1. Simulate Supabase outage: block port 6543 in n8n's network
# 2. Send 3 WhatsApp messages during "outage"
# 3. Each should receive the "experiencing issues" message
# 4. Unblock port 6543
# 5. Send the same 3 messages again (Meta retry)
# Expected: dedup cache catches duplicates — no double processing
# Verify: each message processed exactly once in message_logs
psql $PGB_URL -c "SELECT message_id, count(*) FROM message_logs WHERE phone='+91TEST' GROUP BY message_id HAVING count(*) > 1;"
# PASS: 0 rows (no duplicates)
```

### PREVENTION
Uptime monitor on Supabase health endpoint. PagerDuty alert if Supabase is unreachable for >60 seconds. Display connection status in all frontend apps.

---

## ISSUE ID: OPS-6e
**SEVERITY: Medium**
**TITLE: Customer sends image message — n8n workflow crashes on undefined text body access**

### FAILURE SCENARIO
Customer sends a photo of a menu (or a screenshot) with "I want all of this" as a caption. Meta delivers webhook with `message.type = 'image'` and `message.image.id = 'xxx'`, `message.image.caption = 'I want all of this'`. n8n workflow accesses `message.text.body` which doesn't exist for image messages.

### EXACT ERROR OR SYMPTOM
`TypeError: Cannot read property 'body' of undefined` at the text extraction node. Workflow crashes. 200 OK already sent to Meta (good — no retry). But no response is sent to customer. Customer thinks they've been ignored.

### PERMANENT FIX

```javascript
// n8n Code node: "Extract Message Content" — handles all message types
const msg = $input.first().json.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

if (!msg) {
  return [{ json: { action: 'IGNORE', reason: 'no_message_in_payload' } }];
}

const SUPPORTED_TYPES = ['text', 'interactive'];
const MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker'];

let messageText = '';
let messageType = msg.type;

switch (msg.type) {
  case 'text':
    messageText = msg.text?.body || '';
    break;

  case 'interactive':
    // Button reply or list reply
    messageText = msg.interactive?.button_reply?.id
      || msg.interactive?.list_reply?.id
      || '';
    break;

  case 'image':
  case 'video':
  case 'document':
    // Extract caption if present, otherwise flag as unsupported input
    messageText = msg[msg.type]?.caption || '';
    if (!messageText) {
      return [{ json: {
        action: 'SEND_MESSAGE',
        phone: msg.from,
        message: '📷 I can only process text orders. Please type your order or use item codes.\n\nType MENU to see available items.',
        media_type: msg.type
      }}];
    }
    // Has caption — process the caption text as the order
    break;

  case 'audio':
    return [{ json: {
      action: 'SEND_MESSAGE',
      phone: msg.from,
      message: '🎤 Voice messages are not supported yet. Please type your order.\n\nType MENU to see available items.'
    }}];

  case 'sticker':
  case 'reaction':
  case 'location':
  case 'contacts':
    return [{ json: {
      action: 'SEND_MESSAGE',
      phone: msg.from,
      message: 'I can only process text orders. Type your order or use item codes.\n\nType MENU for our menu.'
    }}];

  default:
    return [{ json: {
      action: 'LOG_UNKNOWN',
      phone: msg.from,
      type: msg.type,
      message: 'Unknown message type received'
    }}];
}

if (!messageText.trim()) {
  return [{ json: {
    action: 'SEND_MESSAGE',
    phone: msg.from,
    message: 'I received your message but couldn\'t find any text. Please type your order.'
  }}];
}

return [{ json: {
  phone: msg.from,
  message: messageText.trim(),
  original_type: messageType,
  action: 'PROCESS'
}}];
```

### VERIFICATION TEST
```bash
# Send webhook with image message (no caption):
curl -X POST https://n8n.your-domain.com/webhook/whatsapp \
  -H "Content-Type: application/json" \
  -d '{"entry":[{"changes":[{"value":{"messages":[{"type":"image","from":"+919876543210","image":{"id":"123","mime_type":"image/jpeg"}}]}}]}]}'
# PASS: customer receives "I can only process text orders" message
# n8n does NOT crash

# Send webhook with image + caption:
# ... "image":{"id":"123","caption":"I want 2 dosas"}
# PASS: "I want 2 dosas" is processed as the order text
```

### PREVENTION
Log `media_type` for all non-text messages. If >10% of messages are images, consider adding image-to-text OCR feature or GPT-4o vision API integration.

---

## ISSUE ID: OPS-6f
**SEVERITY: Critical**
**TITLE: Distributed bot attack — 100 VoIP numbers × 10 msg/min bypass per-phone rate limiter, burn AI API budget**

### FAILURE SCENARIO
Competitor scripts 500 messages/min from 100 different phone numbers. Per-phone rate limiter allows 10/min each → 1,000 messages/minute hit AI APIs.

### EXACT ERROR OR SYMPTOM
**Cost calculation:**
- Groq (free tier): $0 but has rate limits (30 req/min on free, 1000 on paid). 1000 req/min exceeds Groq's own rate limit → all customer messages fail while the attack runs.
- GPT-4o-mini: ~$0.15/1M input tokens, ~$0.60/1M output tokens. Average order: ~600 input tokens (system prompt + user msg), ~100 output tokens. Per request: $0.15×600/1M + $0.60×100/1M = $0.000149. At 1000 req/min × 60 min = 60,000 requests/hour = $8.94/hour = **₹749/hour**.
- 24-hour attack: ₹17,976. Not catastrophic in dollar terms, but Groq rate limit exhaustion blocks ALL legitimate customers.

### PERMANENT FIX

```sql
-- Global rate limiter — counts total AI calls across ALL phones
CREATE TABLE IF NOT EXISTS global_rate_limits (
  window_key    TEXT PRIMARY KEY,  -- 'ai_calls:YYYY-MM-DD-HH-MM' (per-minute bucket)
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

-- Cleanup old windows
SELECT cron.schedule('cleanup-global-rate-limits', '*/5 * * * *',
  $$DELETE FROM global_rate_limits WHERE created_at < NOW() - INTERVAL '10 minutes'$$);
```

n8n — before any AI call:
```javascript
// Node: "Global Rate Limit Check"
const { data } = await supabase.rpc('check_global_rate_limit', {
  p_limit_key: 'ai_calls',
  p_max_per_minute: 100  // max 100 AI calls/minute globally
});

if (!data) {
  // Global limit exceeded — respond with a cached/static message
  return [{ json: {
    action: 'SEND_MESSAGE',
    phone: $input.first().json.phone,
    message: '⏳ We are experiencing high demand. Please try again in a minute.\n\nYou can order directly using codes: Type MENU for the list.',
    rate_limited: true
  }}];
}
```

Also add **new-phone throttle** — limit new unseen phone numbers per hour:
```javascript
// n8n: "New Phone Throttle"
const phone = $input.first().json.phone;
const { data: session } = await supabase
  .from('user_sessions')
  .select('phone, created_at')
  .eq('phone', phone)
  .single();

if (!session) {
  // New phone — check new phone rate
  const { data: allowed } = await supabase.rpc('check_global_rate_limit', {
    p_limit_key: 'new_phones',
    p_max_per_minute: 10  // max 10 new phone numbers per minute
  });

  if (!allowed) {
    return [{ json: { action: 'IGNORE', reason: 'new_phone_flood' } }];
  }
}
```

### VERIFICATION TEST
```bash
# Simulate 150 requests in 1 minute:
for i in $(seq 1 150); do
  psql $PGB_URL -c "SELECT check_global_rate_limit('test_ai', 100);" &
done
wait
# First 100 return TRUE, remaining 50 return FALSE
# PASS: global rate limit enforced
```

### PREVENTION
Alert on `global_rate_limits` where count > 80% of limit. Also alert if >20 unique new phone numbers appear in a 5-minute window (attack indicator). Consider Meta-level protection: report spam numbers to Meta API.

---

## ISSUE ID: OPS-6g
**SEVERITY: Medium**
**TITLE: Tax rate change mid-month — Reports page already handles this correctly via stored tax_rate per order**

### FAILURE SCENARIO
GST rate changes from 5% to 8%. Owner updates TAX_RATE env var and restarts n8n. Historical orders have `tax_rate=0.05` stored on each order row. New orders have `tax_rate=0.08`. Reports page sums `tax_amount`.

### EXACT ERROR OR SYMPTOM
Because `tax_rate` and `tax_amount` are stored per-order at creation time, the monthly `SUM(tax_amount)` is **already correct** — it sums the actual tax charged per order, regardless of when the rate changed. Each order is self-documenting.

The issue is: the Reports page may also display "Current Tax Rate: 5%" as a label, which after the change shows 8%, misleading the owner into thinking all orders were at 8%. Also, if the Reports page recalculates tax from `subtotal * current_rate` instead of using stored `tax_amount`, the numbers will be wrong.

### PERMANENT FIX

```sql
-- Correct daily tax report query — uses STORED per-order values, not current rate
SELECT
  DATE(confirmed_at AT TIME ZONE 'Asia/Kolkata') AS order_date,
  tax_rate,
  COUNT(*) AS order_count,
  SUM(subtotal) AS gross_revenue,
  SUM(tax_amount) AS tax_collected,
  SUM(total) AS net_revenue
FROM orders
WHERE status NOT IN ('cancelled')
  AND confirmed_at >= $1  -- report start date
  AND confirmed_at < $2   -- report end date
GROUP BY DATE(confirmed_at AT TIME ZONE 'Asia/Kolkata'), tax_rate
ORDER BY order_date, tax_rate;
-- Groups by tax_rate so the owner can see exactly how many orders
-- were at 5% vs 8% during the transition period
```

React Reports component:
```javascript
// kds-web/src/pages/Reports.jsx — NEVER recalculate tax from current env rate
// Always use the stored tax_amount from each order

const { data: taxReport } = await supabase
  .from('orders')
  .select('confirmed_at, subtotal, tax_rate, tax_amount, total, status')
  .neq('status', 'cancelled')
  .gte('confirmed_at', startDate)
  .lte('confirmed_at', endDate)

// Group and display per tax_rate bracket
const brackets = {}
taxReport.forEach(order => {
  const rate = order.tax_rate
  if (!brackets[rate]) brackets[rate] = { count: 0, subtotal: 0, tax: 0, total: 0 }
  brackets[rate].count++
  brackets[rate].subtotal += order.subtotal
  brackets[rate].tax += order.tax_amount
  brackets[rate].total += order.total
})
```

### VERIFICATION TEST
```bash
# Insert orders at different tax rates:
psql $PGB_URL -c "
INSERT INTO orders (display_id,phone,table_number,items,status,subtotal,tax_rate,tax_amount,total,idempotency_key,confirmed_at)
VALUES
('TX01','+91T','T1','[]','completed',100,0.05,5,105,'TAX01',NOW()-INTERVAL '2 days'),
('TX02','+91T','T1','[]','completed',100,0.08,8,108,'TAX02',NOW()-INTERVAL '1 day');
"
# Run tax report query
# PASS: shows two rows — one at 5%, one at 8%, with correct amounts
# FAIL: shows single row with averaged/wrong rate
```

### PREVENTION
Add a CHECK constraint: `ALTER TABLE orders ADD CONSTRAINT valid_tax CHECK (tax_amount = ROUND(subtotal * tax_rate, 2))` — ensures tax_amount always matches stored rate × subtotal.

---

## ISSUE ID: OPS-6h
**SEVERITY: High**
**TITLE: Message dedup logs phone number to message_logs before consent check — potential DPDP Act 2023 violation**

### FAILURE SCENARIO
A regulatory auditor asks: "Show me that no personal data was processed before consent was given." The dedup step inserts `(message_id, phone, direction, channel)` into `message_logs` as the first DB operation. The consent check happens after dedup. The `phone` column is personal data. Logging it before consent = processing personal data without consent.

### EXACT ERROR OR SYMPTOM
Under DPDP Act 2023 Section 6: "No person shall process the personal data of a Data Principal unless the Data Principal has given her consent." Phone number = personal data. `message_logs` INSERT with `phone` = processing. If this INSERT happens before `consent_given_at` is checked, it's a violation. Fine up to ₹250 crore for significant offences.

### ROOT CAUSE
The dedup check is designed for technical correctness (prevent duplicate processing) but violates the data protection sequence requirement: consent must be verified before any personal data processing.

### PERMANENT FIX

**Two-phase dedup: hash-only pre-consent, full logging post-consent:**

```sql
-- New table: anonymous dedup using hashed message_id only (no personal data)
CREATE TABLE IF NOT EXISTS message_dedup (
  message_id_hash  TEXT PRIMARY KEY,  -- SHA-256 of message_id, NOT the raw ID
  seen_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Cleanup old entries (messages older than 1 hour can't be retried)
SELECT cron.schedule('cleanup-message-dedup', '*/15 * * * *',
  $$DELETE FROM message_dedup WHERE seen_at < NOW() - INTERVAL '2 hours'$$);
```

n8n flow — dedup before consent, logging after:
```javascript
// Step 1: Anonymous dedup (no personal data stored)
const crypto = require('crypto');
const messageId = $input.first().json.message_id;
const hashedId = crypto.createHash('sha256').update(messageId).digest('hex');

try {
  await dbQuery(
    'INSERT INTO message_dedup (message_id_hash) VALUES ($1) ON CONFLICT DO NOTHING RETURNING message_id_hash',
    [hashedId]
  );
  // If INSERT returned no rows: duplicate — skip
  if (result.rowCount === 0) {
    return []; // Already processed
  }
} catch(e) {
  // DB error — fall through (in-memory dedup will catch it)
}

// Step 2: Check consent (BEFORE logging phone number)
const phone = $input.first().json.phone;
const { data: session } = await supabase
  .from('user_sessions')
  .select('consent_given_at')
  .eq('phone', phone)
  .single();

if (session && !session.consent_given_at) {
  // No consent yet — send consent request, but do NOT log phone to message_logs
  return [{ json: {
    action: 'REQUEST_CONSENT',
    phone,
    message: 'Welcome! Before we proceed, please reply YES to consent to our data processing policy: [link]'
    // Note: WhatsApp itself has Meta's consent — this is for our processing
  }}];
}

// Step 3: Consent exists — NOW safe to log to message_logs with phone
await dbQuery(
  'INSERT INTO message_logs (message_id, phone, direction, channel, delivery_status, created_at) VALUES ($1, $2, $3, $4, $5, NOW())',
  [messageId, phone, 'inbound', 'whatsapp', 'received']
);
```

### VERIFICATION TEST
```bash
# 1. Send message from a phone with no consent:
# Expected: message_dedup has the hash, but message_logs does NOT have the phone
psql $PGB_URL -c "SELECT * FROM message_logs WHERE phone='+91NEWCUSTOMER';"
# PASS: 0 rows (no personal data logged before consent)
psql $PGB_URL -c "SELECT * FROM message_dedup;"
# PASS: 1 row with hash only

# 2. Customer replies YES to consent
# 3. Send another message
# Expected: message_logs NOW has the phone + message_id
psql $PGB_URL -c "SELECT * FROM message_logs WHERE phone='+91NEWCUSTOMER';"
# PASS: 1 row with phone logged after consent
```

### PREVENTION
Monthly audit query: `SELECT ml.phone, us.consent_given_at FROM message_logs ml JOIN user_sessions us ON ml.phone = us.phone WHERE ml.created_at < us.consent_given_at ORDER BY ml.created_at` — finds any message_logs entries created before consent. Must return 0 rows.

---

*End of Part 3b — Category 6 complete (8 issues). Part 4 covers Categories 7–8 + Sections A–D.*
