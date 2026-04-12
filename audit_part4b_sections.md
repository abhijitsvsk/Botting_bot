# Adversarial System Audit — Part 4b (Final)
## Sections A–D: Priority Matrix, Demo Risk, Missing Monitoring, Health Check

---

# SECTION A — PRIORITY MATRIX

Scoring: **Severity** (Critical=3, High=2, Medium=1) × **Probability** (Certain=3, Likely=2, Unlikely=1) × **Ease of Fix** inverted (Hard=1, Medium=2, Easy=3). Higher total = fix first.

| Rank | Issue ID | Title | Sev | Prob | Fix Ease | Score |
|------|----------|-------|-----|------|----------|-------|
| 1 | DB-1a | Cart race condition — lost items on rapid messages | High(2) | Certain(3) | Medium(2) | **12** |
| 2 | DB-1e | Failed INSERT + persisted idempotency key blocks retries | Crit(3) | Likely(2) | Medium(2) | **12** |
| 3 | WA-3a | Respond to Webhook after DB op — Meta retries/dupes | Crit(3) | Certain(3) | Easy(3) | **27** ★ |
| 4 | WA-3e | HMAC verification broken by JSON re-serialization | Crit(3) | Likely(2) | Medium(2) | **12** |
| 5 | SEC-5c | Kitchen RLS too permissive — financial field modification | Crit(3) | Likely(2) | Medium(2) | **12** |
| 6 | DB-1d | Session-scoped advisory lock silently broken on PgBouncer | Crit(3) | Unlikely(1) | Easy(3) | **9** |
| 7 | AI-2c | 86'd item passes DB cross-check into cart | High(2) | Certain(3) | Easy(3) | **18** ★ |
| 8 | OPS-6f | Distributed bot attack burns AI budget, blocks Groq | Crit(3) | Unlikely(1) | Medium(2) | **6** |
| 9 | AI-2b | "cancel" misclassified as CANCEL_ORDER | High(2) | Likely(2) | Medium(2) | **8** |
| 10 | DB-1b | Manager/customer status override race — silent loss | High(2) | Likely(2) | Medium(2) | **8** |
| 11 | DB-1c | EDIT ORDER vs START PREPARING race | High(2) | Likely(2) | Medium(2) | **8** |
| 12 | SEC-5d | Non-atomic manager status + notification | High(2) | Certain(3) | Medium(2) | **12** |
| 13 | AI-2f | Circuit breaker ping validates HTTP 200 only | High(2) | Likely(2) | Easy(3) | **12** |
| 14 | KDS-4c | Boot recovery 4-hour window misses old active orders | High(2) | Likely(2) | Easy(3) | **12** |
| 15 | KDS-4d | Safari clears localStorage — device UUID lost | High(2) | Likely(2) | Medium(2) | **8** |
| 16 | INFRA-8b | Vercel 10s timeout → 504 on manager actions | High(2) | Certain(3) | Easy(3) | **18** ★ |
| 17 | FIN-7d | Reports include cancelled orders in revenue | High(2) | Certain(3) | Easy(3) | **18** ★ |
| 18 | SEC-5b | KDS JWT expires, buttons return 401 silently | High(2) | Certain(3) | Medium(2) | **12** |
| 19 | SEC-5a | JWKS cache stale after key rotation | High(2) | Unlikely(1) | Easy(3) | **6** |
| 20 | SEC-5e | nanoid 6-char collision at 34K orders | Med(1) | Likely(2) | Easy(3) | **6** |
| 21 | AI-2a | Malayalam message → silence (empty items) | Med(1) | Likely(2) | Easy(3) | **6** |
| 22 | AI-2d | Circuit breaker opens mid-session, no cart notice | Med(1) | Likely(2) | Easy(3) | **6** |
| 23 | AI-2e | Dynamic system prompt defeats GPT cache | Med(1) | Likely(2) | Easy(3) | **6** |
| 24 | WA-3b | Expired button reply crashes workflow | Med(1) | Likely(2) | Easy(3) | **6** |
| 25 | WA-3c | Meta account rate limit misidentified as per-order fail | High(2) | Unlikely(1) | Medium(2) | **4** |
| 26 | WA-3d | Failed reply → customer gets silence, no resend | Med(1) | Likely(2) | Medium(2) | **4** |
| 27 | KDS-4a | kds_pings table unbounded growth | Med(1) | Certain(3) | Easy(3) | **9** |
| 28 | KDS-4b | Allergen ACK RLS policy incorrect | High(2) | Likely(2) | Medium(2) | **8** |
| 29 | KDS-4e | setInterval countdown pauses on iPad sleep | Med(1) | Certain(3) | Easy(3) | **9** |
| 30 | OPS-6a | PgBouncer pool exhaustion on Friday rush | High(2) | Likely(2) | Easy(3) | **12** |
| 31 | OPS-6b | Replacement iPad requires technical setup | Med(1) | Likely(2) | Medium(2) | **4** |
| 32 | OPS-6c | 86'd item in active carts — no proactive alert | High(2) | Certain(3) | Medium(2) | **12** |
| 33 | OPS-6d | Supabase outage duplicate risk | Crit(3) | Unlikely(1) | Hard(1) | **3** |
| 34 | OPS-6e | Image message crashes workflow | Med(1) | Likely(2) | Easy(3) | **6** |
| 35 | OPS-6g | Tax rate change — report already correct | Med(1) | Unlikely(1) | Easy(3) | **3** |
| 36 | OPS-6h | DPDP — phone logged before consent | High(2) | Certain(3) | Medium(2) | **12** |
| 37 | FIN-7a | Multiple amendment deltas not summed correctly | High(2) | Likely(2) | Medium(2) | **8** |
| 38 | FIN-7b | No cart JSONB schema validation | High(2) | Likely(2) | Medium(2) | **8** |
| 39 | FIN-7c | times_ordered non-atomic increment | Med(1) | Certain(3) | Easy(3) | **9** |
| 40 | INFRA-8a | pg_cron vs PgBouncer behavior divergence | Med(1) | Unlikely(1) | Easy(3) | **3** |
| 41 | INFRA-8c | n8n execution logs unbounded | Med(1) | Certain(3) | Easy(3) | **9** |

**★ Recommended fix order (top 10):**
1. WA-3a — Respond to Webhook ordering (5 min fix, prevents all Meta retries)
2. AI-2c — Add `available=TRUE` to cross-check query (1 line fix)
3. FIN-7d — Fix Reports WHERE clauses (10 min fix)
4. INFRA-8b — Fire-and-forget proxy (30 min fix)
5. DB-1a — Cart upsert stored procedure (prevents most common data loss)
6. DB-1e — Idempotent order creation procedure
7. SEC-5d — Notification queue pattern
8. SEC-5c — Kitchen column restriction trigger
9. OPS-6c — 86'd item proactive notification
10. OPS-6h — DPDP-compliant dedup

---

# SECTION B — THE DEMO RISK REPORT

**Issues most likely to surface during a 2-hour live demo with a restaurant owner watching:**

| Issue | Why It Surfaces in Demo | Impact on Demo |
|-------|------------------------|----------------|
| **AI-2c** (86'd item in cart) | Owner will definitely toggle an item off to show the 86 feature. Customer simulation will order that item. If it enters the cart, the demo fails visibly. | **Demo-killer** |
| **KDS-4e** (countdown pauses on iPad sleep) | Demo will involve setting iPad down while explaining something. When picked up, stale tickets visible. Owner asks "why is that still there?" | Embarrassing |
| **FIN-7d** (revenue includes cancelled) | Owner will cancel a test order and check Reports. If revenue doesn't decrease, owner loses trust in financial accuracy. | **Trust-killer** |
| **AI-2b** ("cancel" misclassification) | If the owner types "cancel" during demo to test, entire cart disappears. "Wait, I didn't mean that!" | Panic moment |
| **OPS-6e** (image message crash) | Owner sends a photo from WhatsApp. No response. "Is it broken?" | Demo-stopper |
| **SEC-5b** (JWT expiry during demo) | If demo runs >1 hour, KDS JWT expires mid-demo. Buttons stop working. | Confusing failure |
| **INFRA-8b** (Vercel 504 on manager action) | Manager portal action during a slow moment → error toast. Owner: "This doesn't work." | Confidence loss |
| **DB-1a** (cart race on rapid messages) | Owner sends two quick messages. One item lost. "I ordered two things but only see one." | Core trust issue |

**Must-fix before any demo (in order):**
1. AI-2c — 86'd item bypass (1 line SQL fix)
2. OPS-6e — Image/media message handler (30 min)
3. FIN-7d — Reports WHERE clause (10 min)
4. AI-2b — Cancel disambiguation (30 min)
5. KDS-4e — Wall-clock countdown (20 min)
6. INFRA-8b — Fire-and-forget proxy (30 min)

---

# SECTION C — MISSING MONITORING

Failures that are **currently invisible** — no error log, no alert, no user-visible indication:

| # | Silent Failure | What Goes Wrong | Monitoring Query/Alert |
|---|---------------|-----------------|----------------------|
| 1 | Cart item silently lost (DB-1a) | Customer's cart has fewer items than they ordered. No log. | `SELECT phone, jsonb_array_length(cart) as items FROM user_sessions WHERE last_inbound_at > NOW()-INTERVAL '1 hour'` — cross-reference with message_logs count for PARSE_ORDER intents |
| 2 | 86'd item silently enters cart (AI-2c) | Order placed with unavailable item. No error until chef discovers. | `SELECT o.order_id, elem->>'item_code' AS item FROM orders o, jsonb_array_elements(o.items) elem JOIN menu_items m ON m.item_code=(elem->>'item_code') WHERE m.available=FALSE AND o.status NOT IN ('cancelled')` |
| 3 | Empty AI parse → customer silence (AI-2a) | Customer gets no response. No error logged. | `SELECT phone, count(*) AS msgs FROM message_logs WHERE direction='inbound' AND created_at > NOW()-INTERVAL '30 minutes' GROUP BY phone HAVING count(*) > 3 AND phone NOT IN (SELECT phone FROM message_logs WHERE direction='outbound' AND created_at > NOW()-INTERVAL '30 minutes')` — phones with 3+ inbound but 0 outbound |
| 4 | Idempotency key orphaned (DB-1e) | Key in user_sessions but no order in orders table. Customer never gets order. | `SELECT us.phone, us.idempotency_key FROM user_sessions us WHERE us.idempotency_key IS NOT NULL AND us.idempotency_expires_at > NOW() AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.idempotency_key = us.idempotency_key)` |
| 5 | Revenue overstated (FIN-7d) | Cancelled orders included in Reports total. Owner makes wrong business decisions. | Compare `SUM(total)` vs `SUM(total) FILTER (WHERE status!='cancelled')` — alert if different |
| 6 | times_ordered drift (FIN-7c) | Menu popularity data silently inaccurate. | Reconciliation query from FIN-7c prevention section |
| 7 | Prompt cache miss (AI-2e) | OpenAI costs silently 2× higher. No functional error. | Weekly OpenAI usage API check for cached_tokens percentage |
| 8 | Circuit breaker flapping (AI-2f) | Opens and closes every 5 minutes. 3 customers fail per cycle. | `SELECT count(*) FROM audit_log WHERE action IN ('groq_ping_fail','groq_ping_bad_output') AND created_at > NOW()-INTERVAL '1 hour'` > 6 = flapping |
| 9 | Allergen ACK from unknown device (KDS-4d) | allergen_ack_device not in kds_devices. Audit trail broken. | `SELECT o.order_id, o.allergen_ack_device FROM orders o WHERE o.allergen_ack_at IS NOT NULL AND o.allergen_ack_device NOT IN (SELECT device_uuid FROM kds_devices)` |
| 10 | DPDP violation (OPS-6h) | Phone logged to message_logs before consent. Invisible unless audited. | `SELECT ml.phone FROM message_logs ml JOIN user_sessions us ON ml.phone=us.phone WHERE ml.created_at < COALESCE(us.consent_given_at, '2099-01-01')` |
| 11 | Failed WhatsApp replies (WA-3d) | Customer gets no response but session appears active. | `SELECT phone FROM message_logs WHERE direction='outbound' AND delivery_status='failed' AND created_at > NOW()-INTERVAL '2 hours'` |
| 12 | kds_pings bloat (KDS-4a) | Table grows, realtime latency degrades. No visible error. | `SELECT count(*), pg_size_pretty(pg_total_relation_size('kds_pings')) FROM kds_pings` — alert if count > 5000 |

---

# SECTION D — THE FIVE MINUTE HEALTH CHECK

Run this every morning. All checks return a single result set.

```sql
-- =============================================================
-- DAILY SYSTEM HEALTH CHECK — Run via psql or Supabase SQL Editor
-- Expected: All rows show status = 'PASS'
-- Any 'FAIL' row requires immediate investigation
-- =============================================================

WITH checks AS (

  -- 1. Stuck orders (non-terminal, older than 2 hours)
  SELECT
    'Stuck Orders' AS check_name,
    CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL: ' || count(*) || ' stuck orders' END AS status,
    count(*) AS detail_count
  FROM orders
  WHERE status NOT IN ('completed', 'cancelled')
    AND confirmed_at < NOW() - INTERVAL '2 hours'

  UNION ALL

  -- 2. Unacknowledged delivery failures
  SELECT
    'Delivery Failures',
    CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL: ' || count(*) || ' unacked delivery failures' END,
    count(*)
  FROM orders
  WHERE delivery_failed = TRUE
    AND status NOT IN ('cancelled')
    AND confirmed_at > NOW() - INTERVAL '24 hours'

  UNION ALL

  -- 3. Consent flow integrity (message_logs before consent)
  SELECT
    'DPDP Consent Flow',
    CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL: ' || count(*) || ' pre-consent logs' END,
    count(*)
  FROM message_logs ml
  JOIN user_sessions us ON ml.phone = us.phone
  WHERE ml.created_at < COALESCE(us.consent_given_at, '2099-01-01'::TIMESTAMPTZ)
    AND ml.created_at > NOW() - INTERVAL '24 hours'

  UNION ALL

  -- 4. Rate limiter table bloat (message_logs)
  SELECT
    'Rate Limiter Bloat',
    CASE WHEN count(*) < 100000 THEN 'PASS'
         ELSE 'FAIL: ' || count(*) || ' rows in message_logs (>100K)' END,
    count(*)
  FROM message_logs
  WHERE created_at > NOW() - INTERVAL '24 hours'

  UNION ALL

  -- 5. KDS heartbeat recent
  SELECT
    'KDS Heartbeat',
    CASE WHEN max(created_at) > NOW() - INTERVAL '5 minutes' THEN 'PASS'
         WHEN max(created_at) IS NULL THEN 'WARN: No KDS pings ever'
         ELSE 'FAIL: Last KDS ping was ' ||
              EXTRACT(MINUTES FROM NOW() - max(created_at))::INT || ' minutes ago' END,
    0
  FROM kds_pings

  UNION ALL

  -- 6. Groq circuit breaker status
  SELECT
    'Groq Circuit Breaker',
    CASE WHEN value = 'false' OR value IS NULL THEN 'PASS'
         ELSE 'FAIL: Circuit breaker OPEN since ' || value END,
    0
  FROM settings
  WHERE key = 'groq_circuit_breaker_open'

  UNION ALL

  -- 7. Unacknowledged allergen orders
  SELECT
    'Allergen ACK',
    CASE WHEN count(*) = 0 THEN 'PASS'
         ELSE 'FAIL: ' || count(*) || ' allergen orders unacknowledged' END,
    count(*)
  FROM orders
  WHERE allergen_alert = TRUE
    AND allergen_ack_at IS NULL
    AND status NOT IN ('cancelled')
    AND confirmed_at > NOW() - INTERVAL '12 hours'

  UNION ALL

  -- 8. Orphaned idempotency keys (key in session but no matching order)
  SELECT
    'Orphaned Idempotency Keys',
    CASE WHEN count(*) = 0 THEN 'PASS'
         ELSE 'FAIL: ' || count(*) || ' orphaned keys' END,
    count(*)
  FROM user_sessions us
  WHERE us.idempotency_key IS NOT NULL
    AND us.idempotency_expires_at > NOW()
    AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.idempotency_key = us.idempotency_key)

  UNION ALL

  -- 9. kds_pings table size
  SELECT
    'KDS Pings Table Size',
    CASE WHEN count(*) < 5000 THEN 'PASS'
         ELSE 'WARN: ' || count(*) || ' rows — cleanup job may have failed' END,
    count(*)
  FROM kds_pings

  UNION ALL

  -- 10. Financial integrity — cancelled orders in revenue
  SELECT
    'Revenue Excludes Cancelled',
    CASE WHEN
      (SELECT COALESCE(SUM(total),0) FROM orders WHERE confirmed_at > NOW()-INTERVAL '24 hours')
      =
      (SELECT COALESCE(SUM(total),0) FROM orders WHERE confirmed_at > NOW()-INTERVAL '24 hours' AND status != 'cancelled')
    THEN 'PASS (no cancellations today)'
    ELSE 'INFO: ' ||
      (SELECT count(*) FROM orders WHERE status='cancelled' AND confirmed_at > NOW()-INTERVAL '24 hours')
      || ' cancelled orders — verify Reports page excludes them'
    END,
    0

  UNION ALL

  -- 11. Cart schema validation (sample check)
  SELECT
    'Cart Schema Validity',
    CASE WHEN count(*) = 0 THEN 'PASS'
         ELSE 'FAIL: ' || count(*) || ' sessions with invalid cart schema' END,
    count(*)
  FROM user_sessions
  WHERE cart IS NOT NULL
    AND cart != '[]'::JSONB
    AND NOT validate_cart_schema(cart)

  UNION ALL

  -- 12. Display ID uniqueness
  SELECT
    'Display ID Uniqueness',
    CASE WHEN count(*) = 0 THEN 'PASS'
         ELSE 'FAIL: ' || count(*) || ' duplicate display_ids!' END,
    count(*)
  FROM (
    SELECT display_id FROM orders GROUP BY display_id HAVING count(*) > 1
  ) dupes

  UNION ALL

  -- 13. Notification queue backlog
  SELECT
    'Notification Queue',
    CASE WHEN count(*) = 0 THEN 'PASS'
         ELSE 'WARN: ' || count(*) || ' pending notifications older than 5 min' END,
    count(*)
  FROM notification_queue
  WHERE status = 'pending'
    AND created_at < NOW() - INTERVAL '5 minutes'
)

SELECT check_name, status, detail_count
FROM checks
ORDER BY
  CASE WHEN status LIKE 'FAIL%' THEN 0
       WHEN status LIKE 'WARN%' THEN 1
       ELSE 2 END,
  check_name;
```

**Expected output (healthy system):**
```
      check_name          |  status  | detail_count
--------------------------+----------+--------------
 Allergen ACK             | PASS     |            0
 Cart Schema Validity     | PASS     |            0
 Consent Flow             | PASS     |            0
 Delivery Failures        | PASS     |            0
 Display ID Uniqueness    | PASS     |            0
 Groq Circuit Breaker     | PASS     |            0
 KDS Heartbeat            | PASS     |            0
 KDS Pings Table Size     | PASS     |          142
 Notification Queue       | PASS     |            0
 Orphaned Idempotency     | PASS     |            0
 Rate Limiter Bloat       | PASS     |        12847
 Revenue Excludes Cancel  | PASS     |            0
 Stuck Orders             | PASS     |            0
```

---

# BONUS FINDINGS

## BONUS-1: No database backup verification
**SEVERITY: High**
Supabase provides automatic daily backups on Pro plan, but there is no verification that backups are restorable. A corrupted backup discovered during a disaster recovery is useless.

**Fix:** Monthly backup restore test to a staging project. Schedule a pg_cron job that runs `SELECT count(*) FROM orders` and logs the result to a health check table — if this query fails, the database itself may be corrupted.

## BONUS-2: No WhatsApp message delivery receipts are tracked
**SEVERITY: Medium**
Meta sends delivery status webhooks (`sent`, `delivered`, `read`). These are likely hitting the webhook but may not be parsed or stored. Without tracking delivery receipts, you can't distinguish between "message sent but not delivered" (customer's phone off) and "message not sent" (API error).

**Fix:** Add a webhook handler for `statuses` entries in the Meta webhook payload. Update `message_logs.delivery_status` based on these receipts.

## BONUS-3: No graceful shutdown for n8n during deploy
**SEVERITY: Medium**
When n8n is restarted (deploy, update), in-flight executions are killed. A customer whose order was mid-processing gets no response. There's no drain mechanism.

**Fix:** Use `N8N_GRACEFUL_SHUTDOWN_TIMEOUT=30` environment variable. n8n will wait up to 30 seconds for in-flight executions to complete before shutting down.

---

*End of full adversarial audit. Total issues: 41 (38 primary + 3 bonus). All files:*
- `audit_part1_db_ai.md` — Categories 1–2 (11 issues)
- `audit_part2_wa_kds.md` — Categories 3–4 (10 issues)
- `audit_part3a_security.md` — Category 5 (5 issues)
- `audit_part3b_ops.md` — Category 6 (8 issues)
- `audit_part4a_finance_infra.md` — Categories 7–8 (7 issues)
- `audit_part4b_sections.md` — Sections A–D + 3 bonus issues (this file)
