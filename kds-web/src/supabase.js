import { createClient } from '@supabase/supabase-js';

// ── ISP Block Bypass: Proxy URL takes priority over direct Supabase URL ──────
// VITE_SUPABASE_PROXY_URL = your Cloudflare Worker domain (e.g. api.yourdomain.com)
// This hides *.supabase.co from Indian ISP DNS/DPI blocks.
// Falls back to direct Supabase URL for local development where no proxy is needed.
const supabaseProxyUrl = import.meta.env.VITE_SUPABASE_PROXY_URL;
const supabaseDirectUrl = import.meta.env.VITE_SUPABASE_URL || 'https://your-project.supabase.co';
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'your-anon-key';

// The active URL used to initialize the client
const supabaseUrl = supabaseProxyUrl || supabaseDirectUrl;

// ── Supabase JS v2 (@supabase/supabase-js ^2.x) automatically derives the
// WebSocket (Realtime) URL from the base URL you pass to createClient().
// When supabaseUrl = 'https://api.yourdomain.com', the Realtime client
// automatically connects to 'wss://api.yourdomain.com/realtime/v1'.
// NO extra realtime configuration is required for proxying to work. ──────────
export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// ── Startup Connectivity Check ────────────────────────────────────────────────
// Runs once on app load. Silently confirms the proxy (or direct) connection works.
// Logs a warning if the proxy is unreachable so developers know immediately.
// Does NOT block app startup — this runs in the background.
export async function checkConnectivity() {
  if (!supabaseProxyUrl) {
    // No proxy configured — running in direct mode (local dev or proxy not set up)
    return;
  }

  try {
    // A lightweight HEAD request to the proxy's REST endpoint.
    // We don't need a valid response body — any response means the proxy is alive.
    const res = await fetch(`${supabaseProxyUrl}/rest/v1/`, {
      method: 'HEAD',
      headers: { 'apikey': supabaseKey },
      signal: AbortSignal.timeout(5000), // 5 second timeout
    });

    if (res.ok || res.status === 404) {
      // 404 is fine — it means the proxy reached Supabase and got a real response
      return; // Proxy working — no console noise
    }
  } catch (_proxyErr) {
    // Proxy failed — try the direct URL as a diagnostic check
    console.warn('[Supabase] Proxy unreachable, falling back to direct connection');

    try {
      await fetch(`${supabaseDirectUrl}/rest/v1/`, {
        method: 'HEAD',
        headers: { 'apikey': supabaseKey },
        signal: AbortSignal.timeout(5000),
      });
      // Direct works but proxy doesn't — proxy misconfiguration
      console.warn(
        '[Supabase] Direct URL reachable but proxy is not. ' +
        'Check VITE_SUPABASE_PROXY_URL and Cloudflare Worker deployment. ' +
        'See cloudflare-worker/README.md for setup instructions.'
      );
    } catch (_directErr) {
      // Neither works — real connectivity problem
      console.error('[Supabase] Supabase unreachable — check internet connection');
    }
  }
}

// Run connectivity check once at module load time (non-blocking)
checkConnectivity();

// ── FIX SEC-5b: Proactive session refresh ──────────────────────────────────
// Catches cases where autoRefreshToken's timer was throttled by iOS Safari
setInterval(async () => {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return;

  const expiresAt = session.expires_at * 1000; // convert to ms
  const now = Date.now();
  const timeLeft = expiresAt - now;

  // If less than 15 minutes remaining, force refresh
  if (timeLeft < 15 * 60 * 1000) {
    console.log('Proactive session refresh: token expires in', Math.round(timeLeft / 1000), 's');
    const { error } = await supabase.auth.refreshSession();
    if (error) {
      console.error('Session refresh failed:', error);
      window.dispatchEvent(new CustomEvent('session-expired'));
    }
  }
}, 10 * 60 * 1000); // every 10 minutes

// ── FIX SEC-5b: Also refresh on visibility change (iPad wake from sleep) ───
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.dispatchEvent(new CustomEvent('session-expired'));
    return;
  }

  const expiresAt = session.expires_at * 1000;
  // FIX SEC-5b: Refresh proactively before expiry (less than 15 mins left)
  // rather than waiting for it to be fully expired.
  if (Date.now() > expiresAt - 15 * 60 * 1000) {
    const { error } = await supabase.auth.refreshSession();
    if (error) {
      window.dispatchEvent(new CustomEvent('session-expired'));
    }
  }
});
