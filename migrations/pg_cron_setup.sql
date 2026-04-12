-- ==============================================================================
-- KDS-4a & INFRA-8a: pg_cron Setup Instructions
-- ==============================================================================
-- IMPORTANT NOTICES: 
-- 1. DO NOT run this via PgBouncer (Port 6543) or via standard ORM auto-migrations.
--    pg_cron relies on background workers which do not play well with transaction-mode pooling.
-- 2. RUN THIS DIRECTLY IN THE SUPABASE SQL EDITOR on the Dashboard, 
--    or connect directly to Postgres (Port 5432).
-- ==============================================================================

-- 1. Enable the pg_cron extension
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

-- 2. Pruning kds_pings
-- KDS health checks generate ~1,440 rows per device per day.
-- We must aggressively prune them to prevent table bloat.
-- This cron job runs every hour (minute 0) and deletes pings older than 1 hour.
SELECT cron.schedule(
    'prune-kds-pings',
    '0 * * * *',
    $$ DELETE FROM public.kds_pings WHERE created_at < NOW() - INTERVAL '1 hour'; $$
);

-- 3. Pruning message_logs (Rate limiting sliding window)
-- Message logs only need to persist for a few minutes for rate limiting checks to work.
-- We keep 1 day for minimal debugging, then aggressively prune.
SELECT cron.schedule(
    'prune-message-logs',
    '30 3 * * *', -- 3:30 AM every day
    $$ DELETE FROM public.message_logs WHERE created_at < NOW() - INTERVAL '1 day'; $$
);

-- 4. Billing Usage Metrics Aggregation (SaaS Foundation)
-- Runs daily at 11:50 PM to snapshot the order volume per restaurant
-- for invoice reconciliation inside usage_metrics table.
SELECT cron.schedule(
    'aggregate-daily-billing-metrics',
    '50 23 * * *',
    $$ 
    INSERT INTO public.usage_metrics (restaurant_id, metric_date, orders_count, whatsapp_messages_count, ai_calls_count)
    SELECT restaurant_id, CURRENT_DATE,
    COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE),
    0, 0
    FROM public.orders GROUP BY restaurant_id
    ON CONFLICT (restaurant_id, metric_date) DO UPDATE 
    SET orders_count = EXCLUDED.orders_count; 
    $$
);

-- ==============================================================================
-- Note: To unschedule a job later, use:
-- SELECT cron.unschedule('prune-kds-pings');
-- ==============================================================================
