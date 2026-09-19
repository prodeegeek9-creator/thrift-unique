import { supabase } from './supabase.js';

// Disputes. Growth flags them and platform staff work them; Business gets the
// structured workflow. Both write the same rows — what differs is who may move
// one along, which is a Worker decision rather than a schema one.

const COLUMNS =
  'id, reason, status, opened_by, resolution, resolved_at, created_at, ' +
  'order:orders(id, order_code, amount, status, product:products(title, images), buyer:buyers(name, phone))';

export async function fetchDisputes(tenantId) {
  if (!tenantId) return [];

  const { data, error } = await supabase
    .from('disputes')
    .select(COLUMNS)
    .eq('tenant_id', tenantId)
    // Open first, then newest. A resolved dispute is history; an open one is
    // somebody waiting, and the screen leads with a count of exactly those.
    .order('status', { ascending: true })
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data ?? [];
}

export async function fetchOpenDisputeCount(tenantId) {
  if (!tenantId) return 0;

  const { count, error } = await supabase
    .from('disputes')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .in('status', ['open', 'under_review']);

  if (error) throw error;
  return count ?? 0;
}

// A seller raising a dispute on their own order — a buyer who never paid, or a
// delivery that went wrong at their end.
//
// Insert only. There is deliberately no update here: a tenant resolving a
// dispute that was raised against them would be marking their own homework,
// so resolution belongs to the platform console and the policies say so.
export async function raiseDispute(tenantId, { orderId, reason }) {
  const { data, error } = await supabase
    .from('disputes')
    .insert({
      tenant_id: tenantId,
      order_id: orderId,
      reason,
      opened_by: 'seller',
    })
    .select('id, reason, status, created_at')
    .single();

  if (error) throw error;
  return data;
}
