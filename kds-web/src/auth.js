// kds-web/src/auth.js
// Supabase Auth helper — provides session management and role-based access.
// Roles: owner | manager | cashier | kitchen

import { supabase } from './supabase';

// Get the current user's role from the staff table
export async function getUserRole() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from('staff')
    .select('role')
    .eq('id', user.id)
    .single();

  if (error || !data) return null;
  return data.role; // 'owner' | 'manager' | 'cashier' | 'kitchen'
}

export async function signIn(email, password) {
  return supabase.auth.signInWithPassword({ email, password });
}

export async function signOut() {
  return supabase.auth.signOut();
}

export function onAuthChange(callback) {
  return supabase.auth.onAuthStateChange(callback);
}

// Role hierarchy: owner > manager > cashier = kitchen
const ROLE_LEVELS = { owner: 4, manager: 3, cashier: 2, kitchen: 1 };

export function hasPermission(userRole, requiredRole) {
  return (ROLE_LEVELS[userRole] || 0) >= (ROLE_LEVELS[requiredRole] || 0);
}

// Log an action to the audit_log table
export async function logAction(action, orderId = null, metadata = null) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  await supabase.from('audit_log').insert({
    staff_id: user.id,
    action,
    order_id: orderId,
    metadata
  });
}
