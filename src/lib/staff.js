import { supabase } from './supabase.js';

// Who can sign in to this store. Business tier, owner only.
//
// Three fixed roles, matching the Team screen — owner has everything, manager
// has listings/orders/customers, staff has listings only. A fixed enum rather
// than a permission matrix, because that is what the product offers and an
// unused matrix is a thing you have to keep honest forever.
//
// The same three names appear in the staff_role enum and in has_tenant_role()
// in the policies, which is what actually enforces them. This file only draws
// the screen.

export const ROLES = [
  { id: 'owner', label: 'Owner', scope: 'Full access' },
  { id: 'manager', label: 'Manager', scope: 'Listings, orders, customers' },
  { id: 'staff', label: 'Staff', scope: 'Listings only' },
];

export function roleLabel(role) {
  return ROLES.find((r) => r.id === role)?.label ?? role;
}

export function roleScope(role) {
  return ROLES.find((r) => r.id === role)?.scope ?? '';
}

// tenant_members joined to the account behind each membership.
//
// Deliberately not reading auth.users: it is not in the exposed schema and it
// carries the password hash, the recovery tokens and every confirmation
// timestamp. What a colleague needs to see of a colleague is a name — which is
// why the display name lives in the membership's own row, once the Worker
// writes it there at invitation time.
export async function fetchStaff(tenantId) {
  if (!tenantId) return [];

  const { data, error } = await supabase
    .from('tenant_members')
    .select('user_id, role, created_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data ?? [];
}

// Changing somebody's role.
//
// The owner check is in the policy ("owners manage staff"), not here — this
// call simply fails for anybody else, which is the correct place for it to
// fail. The guard in the UI is there so a manager is not shown a control that
// will reject them.
export async function setRole(tenantId, userId, role) {
  const { data, error } = await supabase
    .from('tenant_members')
    .update({ role })
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .select('user_id, role')
    .single();

  if (error) throw error;
  return data;
}

export async function removeStaff(tenantId, userId) {
  const { error } = await supabase
    .from('tenant_members')
    .delete()
    .eq('tenant_id', tenantId)
    .eq('user_id', userId);

  if (error) throw error;
}

// A store with no owner is a store nobody can administer, and nothing in the
// database prevents the last owner deleting themselves — a policy can check
// who you are, not what would be left afterwards. Checked here, and worth
// repeating in the Worker before it ever exposes this over an API.
export function wouldOrphanStore(members, userId) {
  const owners = members.filter((m) => m.role === 'owner');
  return owners.length === 1 && owners[0].user_id === userId;
}
