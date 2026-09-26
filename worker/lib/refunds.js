import { db, SupabaseError } from './supabase.js';
import { paystack } from './transfers.js';
import { adjustDebt } from './debt.js';
import { formatNaira } from './bot.js';
import { chatId } from './waha.js';
import { say } from '../routes/waha.js';

// Giving a buyer their money back, through Paystack's refund API.
//
// Full refunds only: every order is one item. The buyer gets back exactly
// what they paid; the platform waives its commission and absorbs Paystack's
// fee. What the store gives up depends on where the money is:
//
//   held in escrow, or the store's payout not yet sent
//       the payout is cancelled (or never made); the store owes nothing
//   already paid to the store, or on its way
//       the store owes back what it received for the sale, and that is
//       withheld from its next payouts (lib/debt.js, lib/orders.js)
//
// The order of operations is what keeps this safe to run twice or alongside
// the escrow sweep:
//
//   1. insert the refund row: one per order, so a second attempt collides
//   2. flip the order to refunded, matching the exact state it was read in,
//      so escrow cannot release it in between
//   3. only then look at the payout, which is now final for this order
//   4. then ask Paystack. If Paystack refuses, the decision stands and the
//      refund is marked failed for a person to retry: the order does not go
//      back on the store's books.

export class RefundError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

const REFUNDABLE = ['paid', 'escrow', 'completed', 'processing'];
const MAX_REASON = 300;

// What refunding this order would do, without doing it. For the confirmation
// in the dashboard: "₦12,000 back to the buyer; ₦11,040 comes out of your
// next payouts".
export async function refundPreview(cfg, order) {
  const blocked = await whyNot(cfg, order);
  if (blocked) return { refundable: false, reason: blocked };
  const { payout, item } = await payoutFor(cfg, order);
  const paidOut = payout && ['sending', 'paid'].includes(payout.status);
  return {
    refundable: true,
    amount: Number(order.amount),
    store_debt: paidOut ? Number(item?.amount ?? 0) : 0,
  };
}

// refundOrder(cfg, order, { reason, via, by, relist, tenant })
//   via     'store' | 'operator' | 'dispute'
//   relist  put the item back on sale (only if nobody else has bought it)
//
// Returns the refund row. Throws RefundError with a message fit to show.
export async function refundOrder(cfg, order, { reason = null, via, by = null, relist = false, tenant = null } = {}) {
  const blocked = await whyNot(cfg, order);
  if (blocked) throw new RefundError(blocked);

  const note = reason ? String(reason).trim().replace(/\s+/g, ' ').slice(0, MAX_REASON) || null : null;

  // 1. Claim the order.
  let refund;
  try {
    refund = await db(cfg).insert('refunds', {
      tenant_id: order.tenant_id,
      order_id: order.id,
      amount: Number(order.amount),
      reason: note,
      status: 'pending',
      store_debt: 0,
      requested_by: by,
      requested_via: via,
    });
  } catch (err) {
    if (err instanceof SupabaseError && err.status === 409) throw new RefundError('This order is already being refunded.');
    throw err;
  }
  if (!refund) throw new RefundError('This order is already being refunded.');

  // 2. The order, exactly as it was read. Escrow's release and the store's
  // own screens change it only from these states, so either we move it or
  // they did first and this refund steps back out.
  const held = order.escrow_status === 'held';
  const moved = await db(cfg).update(
    'orders',
    `id=eq.${order.id}&tenant_id=eq.${order.tenant_id}&status=eq.${order.status}&escrow_status=eq.${order.escrow_status}`,
    { status: 'refunded', ...(held ? { escrow_status: 'refunded' } : {}) }
  );
  if (!moved.length) {
    await db(cfg).del('refunds', `id=eq.${refund.id}`).catch(() => {});
    throw new RefundError('This order just changed. Refresh and try again.');
  }

  // 3. The store's side. Nothing can create a payout for this order now.
  const storeDebt = await settleStoreSide(cfg, order);
  if (storeDebt > 0) {
    await db(cfg).update('refunds', `id=eq.${refund.id}`, { store_debt: storeDebt }, { returning: false });
    await adjustDebt(cfg, order.tenant_id, storeDebt);
  }
  refund = { ...refund, store_debt: storeDebt };

  if (relist) await relistIfFree(cfg, order);

  // 4. The money.
  refund = await sendRefund(cfg, refund, order);

  await tellPeople(cfg, order, refund, tenant).catch((err) =>
    console.error('refund notices failed:', order.order_code, err?.message ?? err)
  );

  return refund;
}

// A refund Paystack refused or never received, tried again from the console.
export async function retryRefund(cfg, refundId) {
  const refund = await db(cfg).one('refunds', `id=eq.${refundId}&select=*`);
  if (!refund) throw new RefundError('No such refund', 404);
  if (refund.status !== 'failed') throw new RefundError('Only a failed refund can be retried.');
  const order = await db(cfg).one('orders', `id=eq.${refund.order_id}&select=id,tenant_id,order_code,payment_ref,amount`);
  return sendRefund(cfg, refund, order);
}

// Paystack's refund.* webhooks, matched by the transaction's reference.
export async function settleRefundEvent(cfg, event) {
  const data = event?.data ?? {};
  const reference = data.transaction_reference ?? data.transaction?.reference ?? null;
  if (!reference) return { ignored: 'no reference' };

  const order = await db(cfg).one(
    'orders',
    `payment_ref=eq.${encodeURIComponent(reference)}&select=id,order_code`
  );
  if (!order) return { ignored: 'no such order' };
  const refund = await db(cfg).one('refunds', `order_id=eq.${order.id}&select=*`);
  if (!refund) return { ignored: 'no refund for order' };

  const kind = String(event.event).replace(/^refund\./, '');
  if (kind === 'processed') {
    const rows = await db(cfg).update(
      'refunds',
      `id=eq.${refund.id}&status=neq.processed`,
      { status: 'processed', processed_at: new Date().toISOString(), failure_reason: null }
    );
    return { refund: refund.id, status: 'processed', changed: rows.length > 0 };
  }
  if (kind === 'failed') {
    await db(cfg).update(
      'refunds',
      `id=eq.${refund.id}&status=neq.processed`,
      { status: 'failed', failure_reason: String(data.reason ?? data.message ?? 'Paystack could not complete the refund').slice(0, 200) },
      { returning: false }
    );
    return { refund: refund.id, status: 'failed' };
  }
  if (kind === 'processing' || kind === 'pending') {
    await db(cfg).update(
      'refunds',
      `id=eq.${refund.id}&status=in.(pending,processing)`,
      { status: kind },
      { returning: false }
    );
    return { refund: refund.id, status: kind };
  }
  return { ignored: event.event };
}

// ── inside ──────────────────────────────────────────────────────────────────

async function whyNot(cfg, order) {
  if (!order) return 'No such order.';
  if (!order.payment_ref || !order.paid_at) return "This order hasn't been paid, so there's nothing to refund.";
  if (order.status === 'refunded') return 'This order has already been refunded.';
  if (!REFUNDABLE.includes(order.status)) return "This order can't be refunded.";
  if (!(Number(order.amount) > 0)) return 'Nothing was paid for this order.';
  return null;
}

async function payoutFor(cfg, order) {
  const item = await db(cfg).one('payout_items', `order_id=eq.${order.id}&select=payout_id,amount`);
  if (!item) return { payout: null, item: null };
  const payout = await db(cfg).one(
    'payouts',
    `id=eq.${item.payout_id}&tenant_id=eq.${order.tenant_id}&select=id,status,amount,withheld`
  );
  return { payout, item };
}

// Cancels the payout if the money hasn't left; otherwise returns what the
// store received for the sale, which it now owes back.
async function settleStoreSide(cfg, order) {
  const { payout, item } = await payoutFor(cfg, order);
  if (!payout || payout.status === 'cancelled') return 0;

  if (['pending', 'failed'].includes(payout.status)) {
    const cancelled = await db(cfg).update(
      'payouts',
      `id=eq.${payout.id}&status=in.(pending,failed)`,
      { status: 'cancelled', failure_reason: `Refunded to the buyer (${order.order_code})` }
    );
    if (cancelled.length) {
      // Part of this payout had gone toward an older debt. The payout never
      // happened, so neither did that repayment.
      if (Number(payout.withheld) > 0) await adjustDebt(cfg, order.tenant_id, Number(payout.withheld));
      return 0;
    }
    // Picked up by the sweep a moment ago: it is on its way to the store.
  }

  return Number(item?.amount ?? 0);
}

async function relistIfFree(cfg, order) {
  if (!order.product_id) return;
  const others = await db(cfg).select(
    'orders',
    `product_id=eq.${order.product_id}&id=neq.${order.id}&status=in.(${REFUNDABLE.join(',')})&select=id&limit=1`
  );
  if (others.length) return;
  await db(cfg).update(
    'products',
    `id=eq.${order.product_id}&tenant_id=eq.${order.tenant_id}&status=eq.sold`,
    { status: 'active', sold_at: null, quantity_available: 1 },
    { returning: false }
  );
}

async function sendRefund(cfg, refund, order) {
  if (!cfg.paystackKey) return markFailed(cfg, refund, 'Paystack is not set up on the platform yet');
  try {
    const data = await paystack(cfg, '/refund', {
      method: 'POST',
      body: {
        transaction: order.payment_ref,
        currency: 'NGN',
        merchant_note: `Refund for order ${order.order_code}${refund.reason ? `: ${refund.reason}` : ''}`.slice(0, 250),
        ...(refund.reason ? { customer_note: refund.reason.slice(0, 250) } : {}),
      },
    });
    const status = ['processing', 'processed'].includes(data?.status) ? data.status : 'pending';
    const patch = {
      status,
      paystack_refund_id: data?.id != null ? String(data.id) : null,
      failure_reason: null,
      ...(status === 'processed' ? { processed_at: new Date().toISOString() } : {}),
    };
    await db(cfg).update('refunds', `id=eq.${refund.id}`, patch, { returning: false });
    return { ...refund, ...patch };
  } catch (err) {
    console.error('refund failed:', order.order_code, err?.message ?? err);
    return markFailed(cfg, refund, String(err?.message ?? 'Paystack refused the refund'));
  }
}

async function markFailed(cfg, refund, reason) {
  const patch = { status: 'failed', failure_reason: reason.slice(0, 200) };
  await db(cfg).update('refunds', `id=eq.${refund.id}`, patch, { returning: false });
  return { ...refund, ...patch };
}

// The buyer, from the store's number when it is linked (as for the receipt),
// and the owner on the platform number unless they asked for it themselves.
async function tellPeople(cfg, order, refund, knownTenant) {
  const [tenant, buyer, product] = await Promise.all([
    knownTenant ?? db(cfg).one('tenants', `id=eq.${order.tenant_id}&select=id,name,whatsapp_number,waha_session,waha_status`),
    db(cfg).one('buyers', `id=eq.${order.buyer_id}&select=name,phone`),
    db(cfg).one('products', `id=eq.${order.product_id}&select=title`),
  ]);
  if (!tenant) return;

  const title = product?.title ?? 'your item';
  const to = chatId(buyer?.phone);
  if (to && refund.status !== 'failed') {
    const own = tenant.waha_session && tenant.waha_status === 'WORKING' ? { session: tenant.waha_session } : {};
    await say(cfg, tenant, to, refundedBuyerMessage({ store: tenant.name, title, amount: refund.amount, code: order.order_code, reason: refund.reason }), own);
  }

  const owner = chatId(tenant.whatsapp_number);
  if (owner && refund.requested_via !== 'store') {
    await say(cfg, tenant, owner, refundedOwnerMessage({ title, amount: refund.amount, code: order.order_code, debt: refund.store_debt, reason: refund.reason }));
  }
}

export function refundedBuyerMessage({ store, title, amount, code, reason }) {
  return (
    `↩️ Your payment of ${formatNaira(amount)} for *${title}* from ${store} (order ${code}) is being refunded to the card or account you paid with.` +
    (reason ? `\n\nReason: ${reason}` : '') +
    '\n\nBanks usually take 3 to 10 working days to show it.'
  );
}

export function refundedOwnerMessage({ title, amount, code, debt, reason }) {
  return (
    `↩️ Order ${code} (*${title}*) has been refunded to the buyer: ${formatNaira(amount)}.` +
    (reason ? `\n\nReason: ${reason}` : '') +
    (debt > 0
      ? `\n\nYou had already been paid ${formatNaira(debt)} for it, so that will come out of your next payouts.`
      : '\n\nYou had not been paid for it yet, so nothing comes out of your payouts.')
  );
}
