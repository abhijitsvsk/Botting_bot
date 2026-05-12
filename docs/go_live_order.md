# Go Live Runbook

## STEP 0 — Deploy Cloudflare Proxy (Required for India)

> **Do this before anything else.** Without this, your system will go down the next time Indian ISPs block Supabase.

Follow **`cloudflare-worker/README.md`** completely from Step 1 to Step 10.

Verify the proxy is working:
```bash
curl https://api.yourdomain.com/rest/v1/
```
Expected: any JSON response. A timeout means the proxy is not deployed yet.

Then in Vercel:
1. Go to Settings → Environment Variables
2. Add `VITE_SUPABASE_PROXY_URL` = `https://api.yourdomain.com`
3. Redeploy

Test KDS WebSocket through proxy:
- Open Kitchen page on a Jio/Airtel device
- Open DevTools → Network → WS filter
- Confirm connection is to `api.yourdomain.com`, not `*.supabase.co`

**Only proceed to Step 1 after this is confirmed working.**

---

## Database Deployment

- **Exact command to run each migration**
  ```bash
  psql -U postgres -h aws-0-ap-south-1.pooler.supabase.com -p 6543 -d postgres -f migrations/001_initial.sql
  # Repeat sequentially for 002 through 008.
  ```
- **How to verify each migration succeeded**
  Check the Supabase Dashboard "Table editor" to verify tables are populated, and "Authentication" → "Policies" to confirm RLS policies exist.
- **What to check in Supabase dashboard after each step**
  Review "Database" → "Triggers" to confirm all function triggers are active.

## N8N Production Setup

- **How to import PRODUCTION.json into n8n**
  1. Open n8n Dashboard.
  2. Create New Workflow → Import from File.
  3. Upload `restaurant_bot_PRODUCTION_READY.json`.
- **How to configure n8n webhook URL in Meta developer console**
  1. Navigate to Meta for Developers → App → WhatsApp → Configuration.
  2. Edit Webhook URL to point to your live n8n webhook node URL.
  3. Verify token matches environment `WEBHOOK_VERIFY_TOKEN`.

## App Deployment & Initialization

- **How to deploy kds-web to Vercel with correct env vars**
  Link your GitHub repo to Vercel and set `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_SUPABASE_PROXY_URL`, and `VITE_SENTRY_DSN`.
- **How to register the first KDS device**
  Load `/kitchen` directly; the app binds the device UUID to `kds_devices` automatically.
- **How to create the first restaurant row in the DB**
  Use the self-serve frontend at `/onboarding`.
- **How to create the first staff account**
  Handled automatically during the Onboarding flow when creating the Owner account.

## Pre-Flight Testing

- **The smoke test sequence before going live**
  Execute `docs/pre_demo_checklist.md` completely, including items 15 and 16 (proxy verification).

## Emergency Rollback

- **Emergency rollback procedure if anything fails**
  Use `migrations/rollback_*.sql` starting from the highest number and working downwards sequentially.

---

## EMERGENCY — If Supabase Gets Blocked Again

Your system is protected **IF the Cloudflare proxy is deployed and Vercel has `VITE_SUPABASE_PROXY_URL` set.**

To verify your protection is active when a block occurs:

**Step 1:** Check that `VITE_SUPABASE_PROXY_URL` is set in Vercel → Settings → Environment Variables.

**Step 2:** Check your Cloudflare dashboard → Workers & Pages → `supabase-proxy` → confirm it shows as **Active**.

**Step 3:** On a Jio or Airtel device, open a browser and go to `https://api.yourdomain.com/rest/v1/` directly.
- If you get a JSON response: your system is **fully protected**. The block does not affect you.
- If you get a timeout or error: the Cloudflare Worker has an issue.

**If Step 3 fails:**
1. Go to Cloudflare dashboard → Workers & Pages → `supabase-proxy` → **Logs**
2. Look for error messages in the real-time log stream
3. Common cause: `SUPABASE_REAL_URL` secret expired or was deleted — re-run `wrangler secret put SUPABASE_REAL_URL`
4. Redeploy: `cd cloudflare-worker && wrangler deploy`
