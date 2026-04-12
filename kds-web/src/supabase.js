import { createClient } from '@supabase/supabase-js';

// Replace with your actual Supabase Project URL and Anon Key
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://your-project.supabase.co';
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'your-anon-key';

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

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
