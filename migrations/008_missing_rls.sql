-- ==============================================================================
-- Migration 008: Missing RLS Policies for Core Tables
-- ==============================================================================

-- 1. Enable RLS explicitly on target tables
ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;

-- 2. Clean up any existing loose policies to prevent conflict
DROP POLICY IF EXISTS "staff_select_menu_items" ON menu_items;
DROP POLICY IF EXISTS "manager_owner_insert_menu_items" ON menu_items;
DROP POLICY IF EXISTS "manager_owner_update_menu_items" ON menu_items;
DROP POLICY IF EXISTS "owner_delete_menu_items" ON menu_items;

DROP POLICY IF EXISTS "service_role_select_user_sessions" ON user_sessions;
DROP POLICY IF EXISTS "service_role_insert_user_sessions" ON user_sessions;
DROP POLICY IF EXISTS "service_role_update_user_sessions" ON user_sessions;
DROP POLICY IF EXISTS "service_role_delete_user_sessions" ON user_sessions;

-- ==============================================================================
-- menu_items POLICIES
-- ==============================================================================

-- SELECT: staff can read menu items belonging to their restaurant_id only
CREATE POLICY "staff_select_menu_items" ON menu_items
FOR SELECT TO authenticated
USING (restaurant_id = public.get_current_restaurant_id() OR restaurant_id = (SELECT restaurant_id FROM staff WHERE id = auth.uid()));

-- INSERT: manager and owner roles only, auto-sets restaurant_id
CREATE POLICY "manager_owner_insert_menu_items" ON menu_items
FOR INSERT TO authenticated
WITH CHECK (
    restaurant_id = public.get_current_restaurant_id() 
    AND EXISTS (
        SELECT 1 FROM staff WHERE id = auth.uid() AND role IN ('manager', 'owner')
    )
);

-- UPDATE: manager and owner roles only, same restaurant_id
CREATE POLICY "manager_owner_update_menu_items" ON menu_items
FOR UPDATE TO authenticated
USING (
    restaurant_id = public.get_current_restaurant_id() 
    AND EXISTS (
        SELECT 1 FROM staff WHERE id = auth.uid() AND role IN ('manager', 'owner')
    )
);

-- DELETE: owner role only, same restaurant_id
CREATE POLICY "owner_delete_menu_items" ON menu_items
FOR DELETE TO authenticated
USING (
    restaurant_id = public.get_current_restaurant_id() 
    AND EXISTS (
        SELECT 1 FROM staff WHERE id = auth.uid() AND role = 'owner'
    )
);

-- ==============================================================================
-- user_sessions POLICIES
-- ==============================================================================
-- n8n uses the service role key, frontend never queries this directly.

-- SELECT: service role only
CREATE POLICY "service_role_select_user_sessions" ON user_sessions
FOR SELECT TO service_role
USING (true);

-- INSERT: service role only
CREATE POLICY "service_role_insert_user_sessions" ON user_sessions
FOR INSERT TO service_role
WITH CHECK (true);

-- UPDATE: service role only
CREATE POLICY "service_role_update_user_sessions" ON user_sessions
FOR UPDATE TO service_role
USING (true);

-- DELETE: service role only
CREATE POLICY "service_role_delete_user_sessions" ON user_sessions
FOR DELETE TO service_role
USING (true);

