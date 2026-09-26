import { db, SupabaseError } from './supabase.js';
import { paystack } from './transfers.js';
import { fetchTransaction } from './paystack.js';
import { formatNaira } from './bot.js';
import { chatId } from './waha.js';
import { say } from '../routes/waha.js';

// Giving a buyer their money back, through Paystack's refund API.
//
// Only while Vendwyze still holds the money. Once the buyer has confirmed the
// item and the payment has been released to the store, or the store has
// otherwise been paid for the sale, there is no refund: the buyer can open a
// dispute, and that is settled between them and the store. So a refund never
// takes money back from a store.
//
//   held in escrow                     refundable; escrow can no longer release it
//   no escrow, payout not yet sent     refundable; the payout is cancelled
//   released, or the store was paid    not refundable
//
// The buyer gets back what they paid less Paystack's processing fee, which
// Paystack keeps on a refund. Nobody else should carry the cost of a sale
// that didn't happen, so it is not the store's or the platform's to absorb.
// Vendwyze waives its commission on a refunded sale.
//
// The order of operations is what keeps this safe to run twice or alongside
// the escrow sweep:
//
//   1. insert the refund row: one per order, so a second attempt collides
//   2. flip the order to refunded, matching the exact state it was read in,
//      so escrow cannot release it in between
//   3. cancel the unsent payout, if there is one; if it went out in that
//      instant, put the order back and refuse
//   4. then ask Paystack. If Paystack refuses, the decision stands and the
//      refund is marked failed for a person to retry.

export class RefundError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

const REFUNDABLE = ['paid', 'escrow', 'processing'];
const MAX_REASON = 300;

const RELEASED =
  "The payment has already been released to the store, so it can't be refunded. The buyer can open a dispute instead.";

// What refunding this order would do, without doing it: what the buyer paid,
// Paystack's fee, and what goes back. The fee is read from Paystack; if that
// fails the preview still answers, and the refund reads it again when it runs.
export async function refundPreview(cfg, order) {
  const blocked = await whyNot(cfg, order);
  if (blocked) return { refundable: false, reason: blocked };
  const split = await feeSplit(cfg, order);
  return {
    refundable: true,
    paid: Number(order.amount),
    fee: split?.fee ?? null,
    amount: split?.amount ?? null,
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

  // 1. Claim the order. The amount is settled once Paystack's fee is known.
  let refund;
  try {
    refund = await db(cfg).insert('refunds', {
      tenant_id: order.tenant_id,
      order_id: order.id,
      paid: Number(order.amount),
      amount: Number(order.amount),
      fee: 0,
      reason: note,
      status: 'pending',
      requested_by: by,
      requested_via: via,
    });
  } catch (err) {
    if (err instanceof SupabaseError && err.status === 409) throw new RefundError('This order is already being refunded.');
    throw err;
  }
  if (!refund) throw new RefundError('This order is already being refunded.');

  // 2. The order, exactly as it was read. Escrow's release changes it only
  // from 'held', so either we move it or the release did first and this
  // refund steps back out.
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

  // 3. Without escrow the store's payout was made at payment. It can only be
  // stopped if it hasn't been sent.
  if (!held && !(await cancelUnsentPayout(cfg, order))) {
    await db(cfg)
      .update(
        'orders',
        `id=eq.${order.id}&status=eq.refunded`,
        { status: order.status, escrow_status: order.escrow_status },
        { returning: false }
      )
      .catch(() => {});
    await db(cfg).del('refunds', `id=eq.${refund.id}`).catch(() => {});
    throw new RefundError("The store's payout for this order has just gone out, so it can't be refunded. The buyer can open a dispute instead.");
  }

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
  if (order.escrow_status === 'released' || order.status === 'completed') return RELEASED;
  if (!REFUNDABLE.includes(order.status)) return "This order can't be refunded.";
  if (!(Number(order.amount) > 0)) return 'Nothing was paid for this order.';
  if (order.escrow_status === 'held') return null;

  const payout = await payoutFor(cfg, order);
  if (payout && ['sending', 'paid'].includes(payout.status)) {
    return "The store has already been paid for this order, so it can't be refunded. The buyer can open a dispute instead.";
  }
  return null;
}

async function payoutFor(cfg, order) {
  const item = await db(cfg).one('payout_items', `order_id=eq.${order.id}&select=payout_id`);
  if (!item) return null;
  return db(cfg).one('payouts', `id=eq.${item.payout_id}&tenant_id=eq.${order.tenant_id}&select=id,status`);
}

// True when nothing went to the store: no payout, one already cancelled, or
// one stopped here before it was sent.
async function cancelUnsentPayout(cfg, order) {
  const payout = await payoutFor(cfg, order);
  if (!payout || payout.status === 'cancelled') return true;
  const cancelled = await db(cfg).update(
    'payouts',
    `id=eq.${payout.id}&status=in.(pending,failed)`,
    { status: 'cancelled', failure_reason: `Refunded to the buyer (${order.order_code})` }
  );
  return cancelled.length > 0;
}

// What the buyer paid, Paystack's fee on it, and what that leaves to refund,
// in naira. null when Paystack can't be asked.
async function feeSplit(cfg, order) {
  if (!cfg.paystackKey || !order.payment_ref) return null;
  const tx = await fetchTransaction(cfg.paystackKey, order.payment_ref).catch(() => null);
  if (!tx || !(Number(tx.amount) > 0)) return null;
  const paidKobo = Number(tx.amount);
  const feeKobo = Math.max(0, Math.min(paidKobo, Number(tx.fees) || 0));
  return {
    paidKobo,
    feeKobo,
    refundKobo: paidKobo - feeKobo,
    paid: paidKobo / 100,
    fee: feeKobo / 100,
    amount: (paidKobo - feeKobo) / 100,
  };
}

async function relistIfFree(cfg, order) {
  if (!order.product_id) return;
  const others = await db(cfg).select(
    'orders',
    `product_id=eq.${order.product_id}&id=neq.${order.id}&status=in.(${[...REFUNDABLE, 'completed'].join(',')})&select=id&limit=1`
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

  const split = await feeSplit(cfg, order);
  if (!split) return markFailed(cfg, refund, "Couldn't read the payment from Paystack to work out its fee");
  if (split.refundKobo <= 0) return markFailed(cfg, refund, "Paystack's fee is the whole payment; nothing to refund");

  const amounts = { paid: split.paid, fee: split.fee, amount: split.amount };
  try {
    const data = await paystack(cfg, '/refund', {
      method: 'POST',
      body: {
        transaction: order.payment_ref,
        amount: split.refundKobo,
        currency: 'NGN',
        merchant_note: `Refund for order ${order.order_code}${refund.reason ? `: ${refund.reason}` : ''}`.slice(0, 250),
        ...(refund.reason ? { customer_note: refund.reason.slice(0, 250) } : {}),
      },
    });
    const status = ['processing', 'processed'].includes(data?.status) ? data.status : 'pending';
    const patch = {
      ...amounts,
      status,
      paystack_refund_id: data?.id != null ? String(data.id) : null,
      failure_reason: null,
      ...(status === 'processed' ? { processed_at: new Date().toISOString() } : {}),
    };
    await db(cfg).update('refunds', `id=eq.${refund.id}`, patch, { returning: false });
    return { ...refund, ...patch };
  } catch (err) {
    console.error('refund failed:', order.order_code, err?.message ?? err);
    return markFailed(cfg, { ...refund, ...amounts }, String(err?.message ?? 'Paystack refused the refund'), amounts);
  }
}

async function markFailed(cfg, refund, reason, extra = {}) {
  const patch = { ...extra, status: 'failed', failure_reason: reason.slice(0, 200) };
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
    await say(
      cfg,
      tenant,
      to,
      refundedBuyerMessage({ store: tenant.name, title, code: order.order_code, paid: refund.paid, fee: refund.fee, amount: refund.amount, reason: refund.reason }),
      own
    );
  }

  const owner = chatId(tenant.whatsapp_number);
  if (owner && refund.requested_via !== 'store') {
    await say(cfg, tenant, owner, refundedOwnerMessage({ title, code: order.order_code, paid: refund.paid, reason: refund.reason }));
  }
}

export function refundedBuyerMessage({ store, title, code, paid, fee, amount, reason }) {
  return (
    `↩️ Your payment for *${title}* from ${store} (order ${code}) is being refunded: ${formatNaira(amount)} back to the card or account you paid with.` +
    (Number(fee) > 0
      ? `\n\nYou paid ${formatNaira(paid)}. Paystack keeps its ${formatNaira(fee)} processing fee on a refund, so that part can't be returned.`
      : '') +
    (reason ? `\n\nReason: ${reason}` : '') +
    '\n\nBanks usually take 3 to 10 working days to show it.'
  );
}

export function refundedOwnerMessage({ title, code, paid, reason }) {
  return (
    `↩️ Order ${code} (*${title}*, ${formatNaira(paid)}) has been refunded to the buyer.` +
    (reason ? `\n\nReason: ${reason}` : '') +
    "\n\nYou hadn't been paid for it yet, so nothing comes out of your payouts."
  );
}
