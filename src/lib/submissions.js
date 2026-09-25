import { supabase } from './supabase.js';
import { callWorker } from './api.js';

// Items people bring to a thrift store, waiting for the store to decide.
//
// Read straight from Supabase (the team may read its own store's rows).
// Decided through the Worker, because approving or declining ends in a
// WhatsApp message to the seller from the store's own session, and that
// credential stays server side. See worker/routes/submissions.js.

const COLUMNS =
  'id, seller_name, seller_phone, title, asking_price, condition, images, status, ' +
  'decline_reason, product_id, decided_at, created_at';

export async function fetchSubmissions(tenantId, status = 'pending') {
  if (!tenantId) return [];
  const { data, error } = await supabase
    .from('submissions')
    .select(COLUMNS)
    .eq('tenant_id', tenantId)
    .eq('status', status)
    .order('created_at', { ascending: status === 'pending' })
    .limit(200);
  if (error) throw error;
  return data ?? [];
}

export async function fetchSubmissionCounts(tenantId) {
  const empty = { pending: 0, approved: 0, declined: 0 };
  if (!tenantId) return empty;

  const counts = await Promise.all(
    Object.keys(empty).map((status) =>
      supabase
        .from('submissions')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('status', status)
    )
  );
  for (const r of counts) if (r.error) throw r.error;

  return {
    pending: counts[0].count ?? 0,
    approved: counts[1].count ?? 0,
    declined: counts[2].count ?? 0,
  };
}

// { decision: 'approve', price } or { decision: 'decline', reason }.
export async function decideSubmission(tenantId, id, decision) {
  return callWorker('/api/submissions/decide', { body: { tenant: tenantId, id, ...decision } });
}

// The link a store shares to invite items: opens a chat with the store's own
// number with SELL typed, which is what starts the intake conversation.
export function sellLink(tenant) {
  const number = String(tenant?.whatsapp_number ?? '').replace(/\D/g, '');
  if (!number) return null;
  const text = `SELL — I'd like ${tenant.name ?? 'you'} to sell an item for me`;
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}
