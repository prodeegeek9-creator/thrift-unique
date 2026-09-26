import { db } from './supabase.js';
import { fetchTransaction } from './paystack.js';
import { byPaymentRef } from './orders.js';
import { settle } from '../routes/checkout.js';
import { settleCart, isCartRef } from './cartCheckout.js';

// One buyer at a time for each item (migration 0032).
//
// A thrift item is usually the only one, and it can be bought from its page,
// from a payment link or in a WhatsApp cart. Every one of those routes takes
// a hold here before it opens a Paystack page, so a second buyer is told a
// payment is in progress instead of being let pay for the same thing.
//
// Taking a hold is one conditional UPDATE, so of two buyers pressing Pay at
// the same moment exactly one gets it: Postgres re-checks the WHERE of the
// second once the first commits, and it no longer matches.
//
// A hold is never cleared by a timer. Paystack says nothing when a buyer
// closes its page, so a hold simply lapses, and the next buyer to press Pay
// asks Paystack whether the last one paid after all before taking it over.
// A payment that lands after its hold was taken over is still a payment: the
// order stays awaiting payment, and settle() finds the item gone.

export const HOLD_MINUTES = 15;

const iso = (d) => new Date(d).toISOString();

// Minutes left on a hold, rounded up, or null when nobody holds it.
export function heldMinutes(product, now = new Date()) {
  if (!product?.held_until) return null;
  const ms = new Date(product.held_until).getTime() - new Date(now).getTime();
  return ms > 0 ? Math.max(1, Math.ceil(ms / 60_000)) : null;
}

// → { ok: true }                                  it's this payment's now
//   { sold: true }                                it has sold
//   { held: { minutes, mine, ref } }              somebody is paying for it;
//                                                 mine when it is this buyer
//   { busy: { title, minutes } }                  this buyer is already paying
//                                                 for something else here
//
// `ref` is the Paystack reference that will pay for it: an order's utp_… or a
// cart's utc_…. Taking a hold this reference already has is a no-op.
export async function takeHold(cfg, { productId, tenantId, ref, buyerId = null, now = new Date() }) {
  const t = new Date(now);

  // One payment at a time for each buyer, so nobody can hold a rail of items
  // by pressing Pay on each and walking away.
  if (buyerId) {
    const other = await db(cfg).one(
      'products',
      `tenant_id=eq.${tenantId}&held_by_buyer=eq.${buyerId}&status=eq.active&held_until=gt.${iso(t)}` +
        `&id=neq.${productId}&held_by_ref=neq.${ref}&select=title,held_until`
    );
    if (other) return { busy: { title: other.title, minutes: heldMinutes(other, t) } };
  }

  const hold = { held_by_ref: ref, held_by_buyer: buyerId, held_until: iso(t.getTime() + HOLD_MINUTES * 60_000) };
  const base = `id=eq.${productId}&tenant_id=eq.${tenantId}&status=eq.active`;

  if ((await db(cfg).update('products', `${base}&held_until=is.null`, hold)).length) return { ok: true };

  const current = await db(cfg).one(
    'products',
    `id=eq.${productId}&tenant_id=eq.${tenantId}&select=status,held_by_ref,held_by_buyer,held_until`
  );
  if (!current || current.status !== 'active') return { sold: true };
  if (current.held_by_ref === ref) return { ok: true };

  const minutes = heldMinutes(current, t);
  if (minutes) return { held: heldView(current, minutes, buyerId) };

  // Lapsed. Before anyone else gets it: did that buyer pay after all?
  if (current.held_by_ref) {
    const outcome = await lastPayment(cfg, current.held_by_ref);
    // Paystack didn't answer. Refusing for a minute is better than guessing.
    if (outcome === 'unknown') return { held: heldView(current, 1, buyerId) };
    if (outcome === 'paid') return { sold: true };
  }

  // Taken over only if nobody else took it over first.
  const lapsed = current.held_by_ref ? `held_by_ref=eq.${current.held_by_ref}` : 'held_by_ref=is.null';
  if ((await db(cfg).update('products', `${base}&${lapsed}&held_until=lt.${iso(t)}`, hold)).length) {
    return { ok: true };
  }
  const now2 = await db(cfg).one(
    'products',
    `id=eq.${productId}&tenant_id=eq.${tenantId}&select=status,held_by_ref,held_by_buyer,held_until`
  );
  if (!now2 || now2.status !== 'active') return { sold: true };
  return { held: heldView(now2, heldMinutes(now2, t) ?? 1, buyerId) };
}

function heldView(product, minutes, buyerId) {
  return { minutes, mine: Boolean(buyerId) && product.held_by_buyer === buyerId, ref: product.held_by_ref };
}

// Whether the payment behind a lapsed hold went through. One that did is
// settled on the spot, which takes the item off sale for that buyer.
async function lastPayment(cfg, ref) {
  let verified;
  try {
    verified = await fetchTransaction(cfg.paystackKey, ref);
  } catch {
    return 'unknown';
  }
  // Paystack knowing nothing of it, or knowing it unpaid, is the same answer.
  if (verified?.status !== 'success') return 'unpaid';

  if (isCartRef(ref)) {
    await settleCart(cfg, ref, { kobo: verified.amount });
  } else {
    const order = await byPaymentRef(cfg, ref);
    if (order) await settle(cfg, order, { kobo: verified.amount, channel: null });
  }
  return 'paid';
}

// A payment that won't happen after all (Paystack refused to start it, or a
// cart was cancelled): its items go straight back on sale.
export async function releaseHold(cfg, { tenantId, ref }) {
  if (!ref) return;
  await db(cfg).update(
    'products',
    `tenant_id=eq.${tenantId}&held_by_ref=eq.${ref}&status=eq.active`,
    { held_by_ref: null, held_by_buyer: null, held_until: null },
    { returning: false }
  );
}

// Off sale for a payment that has arrived: the item is this payment's if its
// hold is this payment's, or if nobody else is paying for it right now. False
// when somebody else has it, which is a second payment for one item.
export async function markSold(cfg, { productId, tenantId, ref, now = new Date() }) {
  const patch = {
    status: 'sold',
    sold_at: iso(now),
    quantity_available: 0,
    held_by_ref: null,
    held_by_buyer: null,
    held_until: null,
  };
  const base = `id=eq.${productId}&tenant_id=eq.${tenantId}&status=eq.active`;
  for (const hold of [`held_by_ref=eq.${ref}`, 'held_until=is.null', `held_until=lt.${iso(now)}`]) {
    if ((await db(cfg).update('products', `${base}&${hold}`, patch)).length) return true;
  }
  return false;
}
