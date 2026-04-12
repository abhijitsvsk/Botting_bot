-- ===============================================================
-- Database Performance Improvements
-- Run these in your PostgreSQL Management tool (e.g. pgAdmin, psql, Supabase)
-- ===============================================================

-- 1. Index for checking active User Sessions quickly by phone number
CREATE INDEX IF NOT EXISTS idx_user_sessions_phone 
ON user_sessions (phone, last_seen DESC);

-- 2. Index for Order Verification quickly by phone, status, and creation time
-- Useful for fast cancellation checks and order updates
CREATE INDEX IF NOT EXISTS idx_orders_phone_status 
ON orders (phone, status, created_at DESC);

-- 3. Menu Items Fast Lookup
-- Speeds up AI text-to-code mapping
CREATE INDEX IF NOT EXISTS idx_menu_items_code 
ON menu_items (code);

-- Optional: Clean up dead sessions older than 24 hours to keep the table light
-- (Execute manually or put in a pg_cron job)
-- DELETE FROM user_sessions WHERE last_seen < NOW() - INTERVAL '24 hours';
