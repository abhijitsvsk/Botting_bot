# Cloudflare Worker: Supabase ISP Block Bypass

## Why This Exists

In February 2026, the Indian government blocked `*.supabase.co` under Section 69A of the IT Act. Jio, Airtel, and ACT Fibernet used DNS poisoning and deep packet inspection to cut off all connections to Supabase.

This broke our Kitchen Display System (KDS), Manager portal, and all React apps. n8n was unaffected because it runs on a server outside India.

**The fix:** This Cloudflare Worker sits on your own domain (e.g. `api.yourdomain.com`) and quietly forwards all traffic to Supabase. Indian ISPs only see traffic going to your domain — which they cannot block without breaking every website in India.

---

## Prerequisites

- A domain name that you own (can be bought through Cloudflare for ~₹1,000/year)
- A free Cloudflare account
- Node.js installed on your computer

---

## Setup Steps

### Step 1 — Create a Cloudflare Account

Go to [cloudflare.com](https://cloudflare.com) and sign up for a free account.

**Expected:** You receive a verification email. Click the link and log in.

**If it fails:** Check your spam folder. Use a Gmail address if the verification email doesn't arrive.

---

### Step 2 — Add Your Domain to Cloudflare

1. In the Cloudflare dashboard, click **"Add a site"**
2. Enter your domain name (e.g. `yourdomain.com`)
3. Select the **Free plan**
4. Cloudflare will scan your existing DNS records
5. Click **Continue**
6. Cloudflare gives you two nameserver addresses (e.g. `aisha.ns.cloudflare.com`)
7. Log in to wherever you bought the domain and update the nameservers to the Cloudflare ones
8. Wait 5–30 minutes for the nameservers to propagate

**Expected:** The Cloudflare dashboard shows a green "Active" badge next to your domain.

**If it fails:** DNS propagation can take up to 48 hours in rare cases. Check [dnschecker.org](https://dnschecker.org) to see if your nameservers have updated.

> **No domain yet?** You can buy one directly through Cloudflare: Dashboard → **Registrar** → **Register Domains**. Cloudflare charges at-cost with no markup.

---

### Step 3 — Install Wrangler CLI

Open a terminal on your computer and run:

```bash
npm install -g wrangler
```

**Expected output:**
```
added 1 package, changed 1 package, and audited 327 packages in 3s
```

**If it fails:** Make sure Node.js is installed. Run `node --version` — you need v18 or higher. Download from [nodejs.org](https://nodejs.org) if needed.

---

### Step 4 — Log In to Cloudflare via Wrangler

```bash
wrangler login
```

**Expected:** A browser window opens asking you to authorise Wrangler. Click **Allow**.

**Expected terminal output after authorising:**
```
Successfully logged in.
```

**If it fails:** Try `wrangler login --browser` to force browser opening. If that fails, go to cloudflare.com → My Profile → API Tokens → Create Token → use the "Edit Cloudflare Workers" template, then run `wrangler login --api-key YOUR_TOKEN`.

---

### Step 5 — Set Your Supabase URL as a Secret

Navigate into this folder first:

```bash
cd cloudflare-worker
```

Then run:

```bash
wrangler secret put SUPABASE_REAL_URL
```

**Expected:** The terminal prompts you:
```
Enter a secret value:
```

Paste your full Supabase project URL (from your Supabase dashboard → Settings → API):
```
https://abcdefghijklmnop.supabase.co
```

Press Enter.

**Expected output:**
```
✅ Success! Uploaded secret SUPABASE_REAL_URL
```

**If it fails:** Make sure you ran `wrangler login` first in Step 4. Your URL must start with `https://` and end with `.supabase.co`.

---

### Step 6 — Set Your Domain Route in wrangler.toml

Open `cloudflare-worker/wrangler.toml` in your code editor.

Find the commented-out routes section at the bottom and uncomment it. Replace the placeholder with your subdomain:

```toml
[[routes]]
pattern = "api.yourdomain.com/*"
zone_name = "yourdomain.com"
```

For example, if your domain is `biryanibot.in`:
```toml
[[routes]]
pattern = "api.biryanibot.in/*"
zone_name = "biryanibot.in"
```

Save the file.

---

### Step 7 — Deploy the Worker

From inside the `cloudflare-worker/` folder:

```bash
wrangler deploy
```

**Expected output:**
```
 ⛅ wrangler 3.x.x
-------------------
Total Upload: 3.45 KiB / gzip: 1.12 KiB
Uploaded supabase-proxy (1.23 sec)
Published supabase-proxy (0.45 sec)
  https://supabase-proxy.YOUR-ACCOUNT.workers.dev
  api.yourdomain.com/*
Current Deployment ID: abc123def456
```

**If it fails:** Check that `wrangler.toml` has valid TOML syntax and the routes section is properly uncommented.

---

### Step 8 — Add the Subdomain DNS Record in Cloudflare

1. Go to Cloudflare dashboard → your domain → **DNS**
2. Click **Add record**
3. Type: `CNAME`
4. Name: `api`
5. Target: `supabase-proxy.YOUR-ACCOUNT.workers.dev` (use the URL from Step 7 output)
6. Proxy status: **Proxied** (orange cloud icon — this is essential)
7. Click Save

**Expected:** The record appears in your DNS list with an orange cloud.

---

### Step 9 — Test the Proxy

Open a terminal and run:

```bash
curl https://api.yourdomain.com/rest/v1/
```

**Expected output** (some JSON, even an error JSON is fine):
```json
{"message":"Not Found","hint":"..."}
```

Any JSON response means the proxy is working. If you see a timeout or "DNS_PROBE_FINISHED_NXDOMAIN", the DNS record hasn't propagated yet — wait 5 minutes and try again.

You can also test on a Jio mobile hotspot to confirm it works through Indian ISPs.

---

### Step 10 — Update Your App Environment Variables

In your Vercel project dashboard:
1. Go to **Settings → Environment Variables**
2. Add: `VITE_SUPABASE_PROXY_URL` = `https://api.yourdomain.com`
3. Click **Save**
4. Go to **Deployments** → click the three dots on the latest deployment → **Redeploy**

In your local `.env` file:
```
VITE_SUPABASE_PROXY_URL=https://api.yourdomain.com
```

---

## Security Hardening (Do This After Step 9 Works)

Once everything is working and you've confirmed the proxy works, lock down the CORS policy so only your app can use this proxy:

```bash
wrangler secret put ALLOWED_ORIGIN
```

When prompted, paste your exact Vercel URL:
```
https://your-restaurant-kds.vercel.app
```

Then redeploy:
```bash
wrangler deploy
```

This means other websites cannot use your proxy as a free Supabase relay.

---

## Verifying WebSocket (KDS Kitchen Orders)

The Kitchen Display System uses WebSockets for live order updates. To confirm it's working through the proxy:

1. Open your KDS on a Jio or Airtel network
2. Press F12 to open DevTools
3. Click the **Network** tab
4. In the filter bar, type `WS` to show WebSocket connections only
5. You should see a connection to `api.yourdomain.com` — **not** to `*.supabase.co`

If you see a connection to `*.supabase.co` directly, `VITE_SUPABASE_PROXY_URL` is not set in Vercel. Repeat Step 10.

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| `curl` returns connection timeout | DNS not propagated yet | Wait 10 minutes, try again |
| `curl` returns "Worker threw exception" | `SUPABASE_REAL_URL` secret not set | Re-run Step 5 |
| KDS still connects to `*.supabase.co` | `VITE_SUPABASE_PROXY_URL` not set in Vercel | Re-do Step 10 and redeploy |
| WebSocket fails but HTTP works | Worker route missing | Check Step 8 DNS record has orange cloud |
| CORS errors in browser console | ALLOWED_ORIGIN mismatch | Run `wrangler secret put ALLOWED_ORIGIN` with exact Vercel URL |
