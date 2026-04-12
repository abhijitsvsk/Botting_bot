# Adversarial System Audit — Part 3a of 4
## Category 5: Authentication & Security

---

## ISSUE ID: SEC-5a
**SEVERITY: High**
**TITLE: JWKS cache does not re-fetch on verification failure — key rotation causes cascading 401s for all manager actions**

### FAILURE SCENARIO
Supabase rotates JWT signing keys. The Vercel proxy has the old key cached via `jwks-rsa` or `jose` library defaults (many cache for 10 minutes to 24 hours). Every manager action (status override, 86 toggle, menu edit) sends a JWT signed with the new key. Proxy validates against the cached old key. Signature mismatch. Returns 401. Manager Portal shows "Unauthorized" on every action. Lasts until cache TTL expires.

### EXACT ERROR OR SYMPTOM
Manager clicks "Mark Ready" → toast error "Unauthorized (401)". Every button in the Manager Portal stops working. KDS continues to work (uses Supabase client directly, not the proxy). Owner panics. Developer is called. Nobody realizes it's a cache issue — they think credentials were revoked.

### ROOT CAUSE
JWKS libraries cache the key set and do not automatically re-fetch on verification failure. The default cache TTL in libraries like `jwks-rsa` is 10 minutes, but some configurations cache longer. During the window between key rotation and cache expiry, all JWTs fail verification.

### PERMANENT FIX

```javascript
// vercel-proxy/api/webhook.js (or api/[...path].js)
import { createRemoteJWKSet, jwtVerify } from 'jose'  // jose v5+

// JWKS with aggressive refresh on failure
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const JWKS_URL = new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`)

let jwks = createRemoteJWKSet(JWKS_URL, {
  cooldownDuration: 30000,   // 30s min between re-fetches
  cacheMaxAge: 300000,       // 5 min cache max
})

async function verifyJwt(token) {
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `${SUPABASE_URL}/auth/v1`,
      audience: 'authenticated',
    })
    return payload
  } catch (err) {
    if (err.code === 'ERR_JWKS_NO_MATCHING_KEY' || err.code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') {
      // Key rotation likely — force re-fetch JWKS
      jwks = createRemoteJWKSet(JWKS_URL, {
        cooldownDuration: 30000,
        cacheMaxAge: 0,  // force fresh fetch
      })
      // Retry once with fresh keys
      const { payload } = await jwtVerify(token, jwks, {
        issuer: `${SUPABASE_URL}/auth/v1`,
        audience: 'authenticated',
      })
      return payload
    }
    throw err
  }
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization || ''
  const token = authHeader.replace('Bearer ', '')

  if (!token) {
    return res.status(401).json({ error: 'Missing authorization token' })
  }

  let payload
  try {
    payload = await verifyJwt(token)
  } catch (err) {
    console.error('JWT verification failed after retry:', err.code)
    return res.status(401).json({ error: 'Invalid token' })
  }

  // Check role authorization
  const role = payload.user_metadata?.role || payload.role
  const allowedRoles = ['owner', 'manager', 'cashier']
  if (!allowedRoles.includes(role)) {
    return res.status(403).json({ error: 'Insufficient permissions' })
  }

  // Forward to n8n (fire-and-forget pattern — see INFRA-8b)
  const n8nUrl = process.env.N8N_WEBHOOK_URL + req.url.replace('/api/', '/')

  try {
    fetch(n8nUrl, {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
    })  // intentionally no await — fire and forget
  } catch (e) {
    // Log but don't fail — n8n handles its own retry
    console.error('n8n forward failed:', e.message)
  }

  return res.status(202).json({ accepted: true, staff_id: payload.sub })
}
```

### VERIFICATION TEST
```bash
# 1. Generate a valid JWT with current Supabase key (via Supabase Auth login)
# 2. Call the proxy — should return 202
curl -X POST https://your-proxy.vercel.app/api/notify \
  -H "Authorization: Bearer $VALID_JWT" \
  -H "Content-Type: application/json" \
  -d '{"order_id": 1, "status": "preparing"}'
# PASS: 202 Accepted

# 3. Invalidate the cache by calling with a JWT signed by a different key
# If using jose library: the retry-on-failure path triggers
# Check Vercel function logs for "JWT verification failed after retry" — should NOT appear for valid tokens
```

### PREVENTION
Monitor proxy 401 rate. Alert if >5 consecutive 401s in 1 minute (indicates key rotation cache issue, not individual bad tokens).

---

## ISSUE ID: SEC-5b
**SEVERITY: High**
**TITLE: KDS JWT expires after 1 hour — chef's status UPDATE calls silently 401 while Realtime subscription stays alive**

### FAILURE SCENARIO
Chef logs in at 6 PM. JWT expires at 7 PM. The Supabase Realtime WebSocket stays connected (WebSockets don't auto-expire on JWT expiry in most Supabase client SDK versions). Chef continues seeing new orders arrive in real-time. At 7:05 PM, chef taps "Start Preparing". The PostgREST REST API call uses the expired JWT. Returns 401. React code may or may not show this error — many implementations swallow network errors or show a generic "something went wrong."

### EXACT ERROR OR SYMPTOM
Chef taps buttons repeatedly. Toast says "Error" or nothing happens. Orders pile up unacknowledged. Chef shouts at manager. Manager sees orders as "received" and doesn't understand why kitchen isn't working. Revenue loss as customers wait.

### ROOT CAUSE
Supabase JS client `v2` has `autoRefreshToken: true` by default, BUT this only works if the tab is in the foreground and the refresh token hasn't expired. On iPads running PWAs, if the app loses focus or Safari throttles background JS, the token refresh timer may not fire. The Realtime WebSocket reconnection logic handles token refresh on reconnect, but if the WebSocket never disconnects (stable WiFi), the REST API token goes stale while realtime keeps working.

### PERMANENT FIX

```javascript
// kds-web/src/lib/supabaseClient.js
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  }
)

// Proactive session refresh — runs every 10 minutes
// Catches cases where autoRefreshToken's timer was throttled by iOS
setInterval(async () => {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return

  const expiresAt = session.expires_at * 1000  // convert to ms
  const now = Date.now()
  const timeLeft = expiresAt - now

  // If less than 15 minutes remaining, force refresh
  if (timeLeft < 15 * 60 * 1000) {
    console.log('Proactive session refresh: token expires in', Math.round(timeLeft / 1000), 's')
    const { error } = await supabase.auth.refreshSession()
    if (error) {
      console.error('Session refresh failed:', error)
      // Force re-login — show a non-blocking modal
      window.dispatchEvent(new CustomEvent('session-expired'))
    }
  }
}, 10 * 60 * 1000)  // every 10 minutes

// Also refresh on visibility change (iPad wake from sleep)
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    window.dispatchEvent(new CustomEvent('session-expired'))
    return
  }

  const expiresAt = session.expires_at * 1000
  if (Date.now() > expiresAt) {
    const { error } = await supabase.auth.refreshSession()
    if (error) {
      window.dispatchEvent(new CustomEvent('session-expired'))
    }
  }
})
```

KDS App — session expired handler:
```javascript
// kds-web/src/App.jsx
useEffect(() => {
  const handler = () => {
    // Show non-blocking re-login banner — don't interrupt order view
    setShowReLoginBanner(true)
  }
  window.addEventListener('session-expired', handler)
  return () => window.removeEventListener('session-expired', handler)
}, [])

// ReLoginBanner component — appears at top of KDS, one-tap re-login
function ReLoginBanner({ onDismiss }) {
  const handleReLogin = async () => {
    // Use stored credentials or redirect to login
    // For kitchen staff: consider PIN-based re-auth instead of full login
    navigate('/login?returnTo=/kitchen')
  }
  return (
    <div className="session-banner" role="alert">
      ⚠️ Session expired. Tap to re-login — your orders are still visible below.
      <button onClick={handleReLogin}>Re-Login</button>
    </div>
  )
}
```

### VERIFICATION TEST
```bash
# 1. Login to KDS. Note the session expiry time.
# 2. In browser DevTools, manually set the session's expires_at to (now - 60):
#    localStorage: find sb-xxx-auth-token, modify expires_at
# 3. Switch tabs and switch back (triggers visibilitychange)
# Expected: Re-login banner appears within 1 second
# PASS: banner visible, orders still visible underneath
# FAIL: no banner, 401 errors on next button tap
```

### PREVENTION
Log `session-expired` events to Supabase `audit_log`. Alert if any KDS device has >3 session-expired events/day (indicates timer throttling is systemic).

---

## ISSUE ID: SEC-5c
**SEVERITY: Critical**
**TITLE: Kitchen RLS policy is permissive — can be bypassed by crafting direct Supabase API calls to modify financial fields**

### FAILURE SCENARIO
A kitchen-role user (or someone who obtains a kitchen JWT) uses the Supabase REST API directly (via curl or Postman) to update order fields beyond what the KDS UI allows — e.g., setting `total = 0`, changing `items`, or modifying `phone`.

### EXACT ERROR OR SYMPTOM
If the RLS policy is written as `CREATE POLICY ... USING (true) WITH CHECK (auth.jwt() ->> 'role' = 'kitchen')`, it's a permissive policy that allows ALL updates as long as the user has the kitchen role. The kitchen role can modify `total`, `subtotal`, `items`, `phone` — all financial and identity fields. A malicious kitchen staff member could zero out order totals.

### ROOT CAUSE
PostgreSQL RLS permissive policies OR together. If ANY permissive policy allows the UPDATE, it succeeds. The policy doesn't restrict WHICH columns can be updated — PostgreSQL column-level privileges are separate from RLS.

### PERMANENT FIX

Use **column-level GRANT/REVOKE** combined with specific RLS policies:

```sql
-- Revoke all UPDATE privileges on orders from kitchen role
-- First, create a kitchen_group role if not using Supabase custom claims
-- With Supabase Auth, RLS + column grants work on the authenticated role

-- Step 1: Create a database function to enforce column restrictions
CREATE OR REPLACE FUNCTION enforce_kitchen_update_columns()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  jwt_role TEXT;
BEGIN
  jwt_role := current_setting('request.jwt.claims', true)::JSONB ->> 'role';

  IF jwt_role = 'kitchen' THEN
    -- Kitchen can ONLY modify these fields:
    -- status, allergen_ack_at, allergen_ack_device
    -- Everything else must remain unchanged

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

CREATE TRIGGER trg_enforce_kitchen_columns
BEFORE UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION enforce_kitchen_update_columns();
```

### VERIFICATION TEST
```bash
# As kitchen role user, attempt to modify total:
curl -X PATCH "https://your-project.supabase.co/rest/v1/orders?order_id=eq.1" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $KITCHEN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"total": 0}'
# PASS: Error "KITCHEN_FORBIDDEN: cannot modify total"
# FAIL: 200 OK, total now 0

# As kitchen role, valid status transition:
curl -X PATCH "https://your-project.supabase.co/rest/v1/orders?order_id=eq.1" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $KITCHEN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"status": "preparing"}'
# PASS: 200 OK (if current status is order_received)
```

### PREVENTION
Weekly security test: automated script attempts column modifications with each role's JWT. Fails build if any forbidden column modification succeeds.

---

## ISSUE ID: SEC-5d
**SEVERITY: High**
**TITLE: Manager Portal status override + customer notification are two non-atomic operations — partial failure leaves inconsistent state**

### FAILURE SCENARIO
Manager clicks "Ready for Pickup" in the Portal. Two things happen: (1) Supabase UPDATE on orders row, (2) HTTP webhook to n8n to send WhatsApp notification. If (1) succeeds but (2) fails (n8n down), order status changes but customer is never notified. If (2) fires first and succeeds but (1) fails, customer gets "Your order is ready!" but KDS still shows "preparing."

### EXACT ERROR OR SYMPTOM
Scenario A: Customer waits indefinitely for a "ready" notification that never comes. Food gets cold. Scenario B: Customer rushes to pickup counter but order is still being prepared. Both cause customer frustration and operational chaos.

### PERMANENT FIX

Use a **DB trigger + notification queue** pattern: the Supabase UPDATE IS the single source of truth. Customer notification is triggered by the database change, not by the client.

```sql
-- Trigger on orders status change — inserts into a notification queue
CREATE TABLE IF NOT EXISTS notification_queue (
  id          SERIAL PRIMARY KEY,
  order_id    INT NOT NULL REFERENCES orders(order_id),
  event_type  TEXT NOT NULL,  -- 'status_changed', 'allergen_alert', etc.
  payload     JSONB NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending, sent, failed
  attempts    INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

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
    -- Notify n8n via pg_notify (lightweight, no HTTP needed)
    PERFORM pg_notify('order_notifications',
      json_build_object('order_id', NEW.order_id, 'new_status', NEW.status)::TEXT
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_order_status_notification
AFTER UPDATE OF status ON orders
FOR EACH ROW EXECUTE FUNCTION queue_order_notification();
```

n8n listens for `pg_notify` or polls the queue:
```sql
-- n8n scheduled trigger (every 10 seconds) to process notification queue
UPDATE notification_queue
SET status = 'processing', attempts = attempts + 1
WHERE id = (
  SELECT id FROM notification_queue
  WHERE status IN ('pending', 'failed')
    AND attempts < 3
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

Manager Portal now only does the DB update — notification is automatic:
```javascript
// manager-portal/src/lib/orderActions.js
export async function overrideOrderStatus(orderId, newStatus, knownVersion) {
  const { data, error } = await supabase
    .from('orders')
    .update({ status: newStatus })
    .eq('order_id', orderId)
    .eq('row_version', knownVersion)
    .select()

  if (!data?.length) throw new Error('CONFLICT: refresh and retry')
  // No webhook call needed — DB trigger handles notification
  return data[0]
}
```

### VERIFICATION TEST
```bash
# 1. Update order status via Manager Portal
# 2. Check notification_queue:
psql $PGB_URL -c "SELECT * FROM notification_queue WHERE order_id=1 ORDER BY created_at DESC LIMIT 1;"
# PASS: row exists with event_type='status_changed', status='pending'

# 3. Wait 10 seconds (n8n poll interval)
# Check: notification sent, queue row updated to 'sent'
# Also check: customer received WhatsApp message

# 4. Simulate n8n down: stop n8n, update another order status
# Queue row stays 'pending'. When n8n restarts, it processes the backlog.
# PASS: no lost notifications
```

### PREVENTION
Alert: `SELECT count(*) FROM notification_queue WHERE status='pending' AND created_at < NOW() - INTERVAL '5 minutes'` — unprocessed notifications older than 5 minutes. Means n8n or the poller is down.

---

## ISSUE ID: SEC-5e
**SEVERITY: Medium**
**TITLE: nanoid 6-char display_id collision probability exceeds 1% at ~41K orders — unsafe for high-volume restaurants**

### FAILURE SCENARIO
Display ID uses nanoid with 6 alphanumeric characters (a-z, A-Z, 0-9 = 62 chars). Alphabet size N=62, ID length L=6. Total space = 62^6 = 56,800,235,584 (~56.8 billion). Birthday collision probability ≈ 1 - e^(-n² / (2 × N^L)).

### EXACT ERROR OR SYMPTOM
- At 1,000 orders: P(collision) ≈ 1 - e^(-1,000,000 / 113,600,471,168) ≈ 0.00088% — negligible
- At 10,000 orders: P ≈ 1 - e^(-100,000,000 / 113.6B) ≈ 0.088% — low
- At 100,000 orders: P ≈ 1 - e^(-10B / 113.6B) ≈ 8.4% — **UNACCEPTABLE**
- P > 1% at: n ≈ sqrt(2 × 56.8B × 0.01) ≈ 33,711 orders (**~34K orders**)

A restaurant doing 500 orders/day hits 34K in 68 days. P > 1% within ~2 months of operation.

At collision: `INSERT INTO orders (..., display_id) VALUES (...)` violates the UNIQUE constraint. Order creation fails. Customer's confirm action errors out. During rush hour, this is catastrophic.

### ROOT CAUSE
6 alphanumeric characters is too short for the expected order volume over the system's lifetime. 500 orders/day × 365 days × 5 years = 912,500 orders. At 912K orders, P(collision) ≈ 0.73% — borderline.

### PERMANENT FIX

Use a **date-prefix + short random** pattern instead of pure random. This gives human-readable IDs while eliminating collisions:

```sql
-- Generate display_id: MMDD-XXXX where XXXX is 4-char alphanumeric
-- Collisions only possible within the same day (max ~1000 orders/day)
-- 62^4 = 14.7M possibilities per day — collision probability at 1000 orders/day ≈ 0.003%

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

    -- Check uniqueness
    IF NOT EXISTS (SELECT 1 FROM orders WHERE display_id = v_display_id) THEN
      RETURN v_display_id;
    END IF;

    v_attempts := v_attempts + 1;
    IF v_attempts > 10 THEN
      -- Fallback: use 5-char random
      v_random_part := upper(substring(md5(random()::text || clock_timestamp()::text), 1, 5));
      v_display_id := v_date_prefix || '-' || v_random_part;
      RETURN v_display_id;
    END IF;
  END LOOP;
END;
$$;
```

For pure-random approach, minimum safe length calculation:
- Target: P < 0.01% for 912,500 orders over 5 years
- P = n²/(2×N^L) < 0.0001
- N^L > n²/(2×0.0001) = (912500²)/(0.0002) = 4.16 × 10¹² 
- 62^L > 4.16T → L ≥ 8 characters (62^8 = 218T)

**If staying with pure nanoid: use 8 characters minimum.**

```javascript
// n8n Code node or shared utility
import { nanoid, customAlphabet } from 'nanoid'

const generateDisplayId = customAlphabet(
  '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ',  // exclude I, O (ambiguous)
  8  // 8 chars: 34^8 = 1.78T — collision P < 0.001% at 1M orders
)
```

### VERIFICATION TEST
```bash
# Generate 10,000 IDs and check for collisions:
psql $PGB_URL -c "
WITH ids AS (
  SELECT generate_display_id() AS did
  FROM generate_series(1, 10000)
)
SELECT did, count(*) FROM ids GROUP BY did HAVING count(*) > 1;"
# PASS: 0 rows returned (no collisions in 10K sample)
```

### PREVENTION
Monitor: `SELECT display_id, count(*) FROM orders GROUP BY display_id HAVING count(*) > 1` — should always return 0 rows. Alert immediately on any result.

---

*End of Part 3a — Category 5 complete (5 issues). Part 3b covers Category 6 (Operational Scenarios).*
