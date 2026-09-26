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
  'decline_reason, product_id, decided_at, created_at, ' +
  'sold_at, owed_amount, consignor_paid_at, consignor_paid_note';

// The tabs on "Items to review", each a slice of the same table:
//
//   pending    waiting for the store to decide
//   listed     approved and on sale
//   topay      sold: the store owes the consignor their asking price
//   paid       sold, and the store has paid them
//   declined   turned down
export const SUBMISSION_TABS = ['pending', 'listed', 'topay', 'paid', 'declined'];

function forTab(query, tab) {
  switch (tab) {
    case 'listed':
      return query.eq('status', 'approved').is('sold_at', null);
    case 'topay':
      return query.not('sold_at', 'is', null).is('consignor_paid_at', null);
    case 'paid':
      return query.not('consignor_paid_at', 'is', null);
    case 'declined':
      return query.eq('status', 'declined');
    default:
      return query.eq('status', 'pending');
  }
}

export async function fetchSubmissions(tenantId, tab = 'pending') {
  if (!tenantId) return [];
  const newestFirst = tab !== 'pending' && tab !== 'topay';
  const order = tab === 'topay' ? 'sold_at' : tab === 'paid' ? 'consignor_paid_at' : 'created_at';
  const { data, error } = await forTab(
    supabase.from('submissions').select(COLUMNS).eq('tenant_id', tenantId),
    tab
  )
    .order(order, { ascending: !newestFirst })
    .limit(200);
  if (error) throw error;
  return data ?? [];
}

// Counts for every tab, and what the store owes in total.
export async function fetchSubmissionCounts(tenantId) {
  const empty = { pending: 0, listed: 0, topay: 0, paid: 0, declined: 0, owed: 0 };
  if (!tenantId) return empty;

  const [counts, owed] = await Promise.all([
    Promise.all(
      SUBMISSION_TABS.map((tab) =>
        forTab(
          supabase.from('submissions').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
          tab
        )
      )
    ),
    forTab(supabase.from('submissions').select('owed_amount, asking_price').eq('tenant_id', tenantId), 'topay').limit(1000),
  ]);
  for (const r of [...counts, owed]) if (r.error) throw r.error;

  const out = Object.fromEntries(SUBMISSION_TABS.map((tab, i) => [tab, counts[i].count ?? 0]));
  out.owed = (owed.data ?? []).reduce((n, r) => n + Number(r.owed_amount ?? r.asking_price ?? 0), 0);
  return out;
}

// The store paid a consignor. Recorded through the Worker, which tells the
// consignor on WhatsApp.
export async function markConsignorPaid(tenantId, id, note) {
  return callWorker('/api/submissions/paid', { body: { tenant: tenantId, id, note } });
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
