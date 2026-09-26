import { supabase } from './supabase.js';
import { callWorker } from './api.js';

// Orders, and the escrow state machine that sits underneath them.

const ORDER_COLUMNS =
  'id, order_code, amount, commission, quantity, status, escrow_status, ' +
  'source_channel, payment_ref, paid_at, shipped_at, confirm_deadline, ' +
  'confirmed_at, completed_at, created_at';

// Joined in for the table rows: the thumbnail and title, and who bought it.
const WITH_RELATIONS =
  ORDER_COLUMNS +
  ', product:products(id, public_code, title, images, condition)' +
  ', buyer:buyers(id, name, phone)';

// The filter chips on the Orders screen. 'paid' sits under Processing rather
// than getting a chip of its own — from the seller's side, money taken and
// item not yet sent is one situation, and two chips for it would only make
// them click twice to see the same work.
const FILTERS = {
  all: null,
  awaiting_payment: ['awaiting_payment'],
  processing: ['processing', 'paid'],
  escrow: ['escrow'],
  completed: ['completed'],
};

export async function fetchOrders(tenantId, { filter = 'all', limit = 100 } = {}) {
  if (!tenantId) return [];

  let q = supabase
    .from('orders')
    .select(WITH_RELATIONS)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(limit);

  const statuses = FILTERS[filter];
  if (statuses) q = q.in('status', statuses);

  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

export async function fetchOrder(tenantId, id) {
  if (!tenantId || !id) return null;

  const { data, error } = await supabase
    .from('orders')
    .select(WITH_RELATIONS)
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

// The vertical timeline on the order detail screen.
//
// Derived from the timestamps on the row rather than stored as its own table:
// the order already knows when it was paid, shipped, confirmed and completed,
// and a separate event log would be a second source of truth that can disagree
// with the first.
//
// Returns every step always, each marked done / current / pending, because the
// design shows the whole path greyed ahead of where the order has got to — a
// buyer and a seller both want to see what happens next, not only what has
// happened.
export function escrowTimeline(order) {
  if (!order) return [];

  const steps = [
    { id: 'paid', label: 'Buyer payment', at: order.paid_at },
    {
      id: 'received',
      label: 'Payment received',
      // Starter has no hold at all, so the money is the seller's the moment it
      // clears and this step is the end of the line rather than the start of
      // an escrow.
      at: order.escrow_status === 'none' ? order.paid_at : order.paid_at,
    },
    { id: 'shipped', label: 'Seller ships', at: order.shipped_at },
    { id: 'confirmed', label: 'Buyer confirms', at: order.confirmed_at },
    { id: 'released', label: 'Funds released', at: order.completed_at },
  ];

  // Starter never holds funds, so "buyer confirms" and "funds released" are
  // not steps it is waiting on — showing them pending forever would suggest
  // something is stuck when nothing is.
  const visible =
    order.escrow_status === 'none'
      ? steps.filter((s) => s.id !== 'confirmed' && s.id !== 'released')
      : steps;

  const firstPending = visible.findIndex((s) => !s.at);

  return visible.map((step, i) => ({
    ...step,
    state: step.at ? 'done' : i === firstPending ? 'current' : 'pending',
  }));
}

// What the order detail header says next to the status pill.
//
// The deadline is the part a seller actually needs: escrow that releases
// automatically is the difference between waiting and being stuck, and a buyer
// who never replies must not freeze the money forever.
export function escrowSummary(order) {
  if (!order || order.escrow_status === 'none') return null;

  if (order.escrow_status === 'released')
    return { tone: 'done', text: 'Funds released to you' };

  if (order.escrow_status === 'refunded')
    return { tone: 'warn', text: 'Refunded to the buyer' };

  if (order.confirmed_at)
    return { tone: 'done', text: 'Buyer confirmed — releasing' };

  if (order.confirm_deadline) {
    const days = Math.ceil(
      (new Date(order.confirm_deadline) - Date.now()) / 86_400_000
    );
    return days > 0
      ? { tone: 'wait', text: `Auto-releases in ${days} day${days === 1 ? '' : 's'}` }
      : { tone: 'wait', text: 'Releasing now' };
  }

  return { tone: 'wait', text: 'Awaiting buyer confirmation' };
}

// Recent orders for the Overview screen. Deliberately not fetchOrders with a
// limit: the overview table shows fewer columns and no buyer phone, so there
// is no reason to ship one.
export async function fetchRecentOrders(tenantId, limit = 5) {
  if (!tenantId) return [];

  const { data, error } = await supabase
    .from('orders')
    .select(
      'id, order_code, amount, status, created_at, ' +
        'product:products(title, images), buyer:buyers(name, phone)'
    )
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}

// Marking an order shipped is the one write a seller makes on it. Everything
// else — taking payment, holding it, releasing it — belongs to the Worker
// under the service key, which is why there is no client policy for those.
//
// This will 403 until the Worker exposes it: orders has no client UPDATE
// policy by design. Kept here so the call site is written once, in the place
// the rest of the order code lives.
export async function markShipped(tenantId, id) {
  const { data, error } = await supabase
    .from('orders')
    .update({ shipped_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .select(ORDER_COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

// ── refunds ──────────────────────────────────────────────────────────────────
//
// The buyer's money back to their card, through the Worker (it talks to
// Paystack). Owners and managers only; the refunds table is readable by the
// same people.

export async function fetchRefund(tenantId, orderId) {
  if (!tenantId || !orderId) return null;
  const { data, error } = await supabase
    .from('refunds')
    .select('id, amount, status, reason, store_debt, failure_reason, created_at, processed_at')
    .eq('tenant_id', tenantId)
    .eq('order_id', orderId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// What refunding would do: { refundable, amount, store_debt } or
// { refundable: false, reason }.
export const previewRefund = (tenantId, orderId) =>
  callWorker('/api/orders/refund', { body: { tenant: tenantId, order: orderId, preview: true } });

export const refundOrder = (tenantId, orderId, { reason, relist }) =>
  callWorker('/api/orders/refund', { body: { tenant: tenantId, order: orderId, reason, relist } });
