# Pre-Demo Verification Checklist

1. Verify restaurants table has correct phone_number_id
2. Verify subscription_status = 'trial', trial_ends_at future
3. Run the 5-minute health check SQL
4. Send a test message from a real phone and verify it appears in message_logs within 5 seconds
5. Verify KDS device is registered in kds_devices
6. Send a test order and verify it appears on KDS within 3 seconds
7. Verify the allergen acknowledgment gate blocks START PREPARING
8. Verify manager can override status via Manager portal
9. Verify Reports page loads without errors
10. Confirm GROQ circuit breaker is closed (groq_circuit_breaker_open = 'false' in settings)
11. Confirm kitchen_status = 'open' in settings
12. Test the complete checkout flow end to end
13. Verify the 200 OK is returned to Meta within 1 second
14. Check Supabase connection count is under limit
15. Verify Cloudflare Worker is responding
    Run in terminal: curl https://api.yourdomain.com/rest/v1/
    Expected: Any JSON response (even an error JSON is fine — it means the proxy reached Supabase)
    Not expected: Connection timeout, ERR_NAME_NOT_RESOLVED, or "DNS error"
    If it fails: Check cloudflare-worker/README.md Step 8 and confirm the DNS record has the orange cloud icon
16. Verify KDS Realtime works through proxy (not direct Supabase)
    Open Kitchen page in browser on a Jio or Airtel device
    Open DevTools (F12) → Network tab → filter by "WS"
    Confirm WebSocket connection goes to api.yourdomain.com — NOT to *.supabase.co directly
    If you see *.supabase.co: VITE_SUPABASE_PROXY_URL is missing from Vercel env vars — add it and redeploy
