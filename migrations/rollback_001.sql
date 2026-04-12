-- Rollback initial schema
DROP TRIGGER IF EXISTS auto_gdpr_deletion ON orders;
DROP FUNCTION IF EXISTS check_pending_deletion;

DROP TRIGGER IF EXISTS sessions_updated_at ON user_sessions;
DROP TRIGGER IF EXISTS orders_updated_at ON orders;
DROP FUNCTION IF EXISTS update_updated_at;

DROP INDEX IF EXISTS idx_kds_pings_created;
DROP INDEX IF EXISTS idx_user_sessions_updated;
DROP INDEX IF EXISTS idx_audit_log_order_id;
DROP INDEX IF EXISTS idx_message_logs_message_id;
DROP INDEX IF EXISTS idx_message_logs_phone_created;
DROP INDEX IF EXISTS idx_orders_display_id;
DROP INDEX IF EXISTS idx_orders_created_at;
DROP INDEX IF EXISTS idx_orders_status;
DROP INDEX IF EXISTS idx_orders_phone;

DROP TABLE IF EXISTS sessions_archive CASCADE;
DROP TABLE IF EXISTS settings CASCADE;
DROP TABLE IF EXISTS kds_devices CASCADE;
DROP TABLE IF EXISTS kds_pings CASCADE;
DROP TABLE IF EXISTS promotions CASCADE;
DROP TABLE IF EXISTS cash_transactions CASCADE;
DROP TABLE IF EXISTS refunds CASCADE;
DROP TABLE IF EXISTS complaints CASCADE;
DROP TABLE IF EXISTS message_logs CASCADE;
DROP TABLE IF EXISTS audit_log CASCADE;
DROP TABLE IF EXISTS order_amendments CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS user_sessions CASCADE;
DROP TABLE IF EXISTS menu_items CASCADE;
DROP TABLE IF EXISTS staff CASCADE;

DROP TYPE IF EXISTS order_status;
