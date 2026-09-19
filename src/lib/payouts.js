import { supabase } from './supabase.js';

// Money out.
//
// Two numbers sit at the top of the Payouts screen and they mean different
// things, which is worth being precise about because a seller reads them as
// "what I have" and "what I am owed":
//
//   Available balance — orders that completed, minus commission, minus what
//                       has already been paid out. Money the platform owes
//                       them right now.
//   Pending escrow    — orders where the buyer has paid and the hold has not
//                       released. Real money, not theirs yet.
//
// Both are computed here rather than stored on the tenant, because a stored
// balance is a number that can drift from the rows that justify it, and the
// first time anyone notices is when a seller disputes a payout.

const PAYOUT_COLUMNS =
  'id, amount, commission, status, reference, failure_reason, paid_at, created_at';

export async function fetchPayouts(tenantId, { limit = 50 } = {}) {
  if (!tenantId) return [];

  const { data, error } = await supabase
    .from('payouts')
    .select(PAYOUT_COLUMNS)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}

export async function fetchBalance(tenantId) {
  const empty = { available: 0, pendingEscrow: 0, paidOut: 0, nextPayoutNote: null };
  if (!tenantId) return empty;

  // Three narrow reads rather than one join. Postgres would happily do this in
  // SQL, but that means a view or an RPC, and both would need their own
  // tenant check — this stays inside the policies already written.
  const [completed, held, paid] = await Promise.all([
    supabase
      .from('orders')
      .select('amount, commission')
      .eq('tenant_id', tenantId)
      .in('status', ['completed', 'paid'])
      .in('escrow_status', ['none', 'released']),
    supabase
      .from('orders')
      .select('amount')
      .eq('tenant_id', tenantId)
      .eq('escrow_status', 'held'),
    supabase
      .from('payouts')
      .select('amount')
      .eq('tenant_id', tenantId)
      .eq('status', 'paid'),
  ]);

  for (const r of [completed, held, paid]) if (r.error) throw r.error;

  const earned = sum(completed.data, (o) => Number(o.amount) - Number(o.commission));
  const pendingEscrow = sum(held.data, (o) => Number(o.amount));
  const paidOut = sum(paid.data, (p) => Number(p.amount));

  return {
    // Clamped at zero. A refund processed after a payout can put this
    // negative, and "₦-12,000 available" is a support ticket, not a balance.
    // The underlying rows still say what happened.
    available: Math.max(0, earned - paidOut),
    pendingEscrow,
    paidOut,
    nextPayoutNote: pendingEscrow > 0 ? 'After buyer confirmation' : null,
  };
}

// Which orders a given payout settled. The Payouts screen does not show this,
// but reconciling a dispute six weeks later means being able to say exactly
// which sale a transfer paid for — which is the whole reason payout_items is a
// table rather than a column.
export async function fetchPayoutItems(tenantId, payoutId) {
  if (!tenantId || !payoutId) return [];

  const { data, error } = await supabase
    .from('payout_items')
    .select('amount, order:orders(id, order_code, amount, created_at, product:products(title))')
    .eq('payout_id', payoutId);

  if (error) throw error;
  return data ?? [];
}

function sum(rows, pick) {
  return (rows ?? []).reduce((total, row) => total + (pick(row) || 0), 0);
}
