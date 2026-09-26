import { require_, originOf } from '../lib/env.js';
import { verifyWebhook, fetchTransaction } from '../lib/paystack.js';
import { byPaymentRef } from '../lib/orders.js';
import { settle } from './checkout.js';
import { settlePlanPayment } from './billing.js';
import { settleTransfer, paidOutMessage } from '../lib/transfers.js';
import { settleRefundEvent } from '../lib/refunds.js';
import { settleCart, isCartRef } from '../lib/cartCheckout.js';
import { db } from '../lib/supabase.js';
import { chatId } from '../lib/waha.js';
import { say } from './waha.js';
import { json } from '../lib/http.js';
import { noteProblem, lagosDay } from '../lib/problems.js';

// POST /api/paystack/webhook
//
// The only path by which money becomes an order, so the order of operations
// matters more here than anywhere else in the Worker:
//
//   1. read the RAW body — hashing a re-serialised copy never matches
//   2. verify the signature before parsing, let alone acting
//   3. re-read the transaction from Paystack rather than trusting the amount
//   4. convert kobo to naira exactly once
//   5. update only an order still awaiting payment, so a retry is a no-op
//
// Paystack retries on any non-2xx, so every outcome we have actually handled —
// including "this is not an event we care about" — answers 200. A 500 here
// buys a retry storm, not a fix.
export async function handlePaystackWebhook(request, env) {
  const cfg = require_(env, 'supabaseUrl', 'serviceKey', 'paystackKey');

  const raw = await request.text();
  const signature = request.headers.get('x-paystack-signature');

  if (!(await verifyWebhook(cfg.paystackKey, raw, signature))) {
    // Kept for the console, one row a day: a stream of these usually means
    // PAYSTACK_SECRET_KEY is not the key of the account sending webhooks, and
    // every real payment is being turned away here.
    await noteProblem(cfg, {
      kind: 'bad_signature',
      key: lagosDay(),
      detail: `Last from ${request.headers.get('cf-connecting-ip') ?? 'an unknown address'}${signature ? '' : ', with no signature at all'}.`,
    });
    // 401, not 200: an unsigned caller is not Paystack, and there is nothing
    // for it to retry.
    return json({ error: 'Bad signature' }, 401);
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: 'Malformed body' }, 400);
  }

  // A payout landing in (or bouncing back from) a store's bank.
  if (['transfer.success', 'transfer.failed', 'transfer.reversed'].includes(event?.event)) {
    const result = await settleTransfer(cfg, event);
    if (result.newlyPaid) await tellPaidOut(cfg, result.payout).catch(() => {});
    return json({ ok: true, ...result, payout: result.payout?.reference ?? null });
  }

  // A refund reaching (or failing to reach) a buyer's card.
  if (String(event?.event ?? '').startsWith('refund.')) {
    return json({ ok: true, ...(await settleRefundEvent(cfg, event)) });
  }

  if (event?.event !== 'charge.success') {
    return json({ ok: true, ignored: event?.event ?? 'unknown' });
  }

  const reference = event?.data?.reference;
  if (!reference) return json({ ok: true, ignored: 'no reference' });

  // A store paying its plan fee, not a buyer paying for an item.
  if (event.data?.metadata?.kind === 'plan' || reference.startsWith('utb_')) {
    const verified = await fetchTransaction(cfg.paystackKey, reference);
    if (verified && verified.status !== 'success') return json({ ok: true, ignored: `status ${verified.status}` });
    cfg.publicOrigin = originOf(request, cfg);
    const result = await settlePlanPayment(cfg, verified ?? event.data);
    await noteIgnored(cfg, reference, verified?.amount ?? event.data.amount, result.ignored, 'plan fee');
    return json({ ok: true, plan: true, ...result });
  }

  // A WhatsApp cart: one payment for several orders (lib/cartCheckout.js).
  if (event.data?.metadata?.kind === 'cart' || isCartRef(reference)) {
    const verified = await fetchTransaction(cfg.paystackKey, reference);
    if (verified && verified.status !== 'success') return json({ ok: true, ignored: `status ${verified.status}` });
    cfg.publicOrigin = originOf(request, cfg);
    const kobo = verified?.amount ?? event.data.amount;
    const result = await settleCart(cfg, reference, { kobo });
    await noteIgnored(cfg, reference, kobo, result.ignored, 'WhatsApp cart');
    return json({ ok: true, cart: true, ...result });
  }

  const order = await byPaymentRef(cfg, reference);

  // A payment with no matching order is an operational problem — money has
  // moved and we do not know what for. It is deliberately NOT resolved by
  // inventing an order from the event's metadata: an order is created when a
  // buyer is quoted a price, and conjuring one here would mean the amount, the
  // product and the tenant all came from a payload rather than from a decision
  // somebody made. Acknowledged so Paystack stops retrying; surfaced so a
  // human sees it.
  if (!order) {
    console.warn('paystack: no order for reference', reference);
    await noteProblem(cfg, {
      kind: 'unmatched_payment',
      key: reference,
      reference,
      amount: nairaOf(event.data.amount),
      detail: `Paystack says this was paid${event.data.channel ? ` by ${event.data.channel}` : ''}, and no order has this reference.`,
    });
    return json({ ok: true, unmatched: true });
  }

  if (order.status !== 'awaiting_payment') {
    return json({ ok: true, replayed: true, order: order.order_code });
  }

  // Step 3. The signature already proves provenance; this closes the narrower
  // gap where a valid but stale event carries an amount that has since changed.
  const verified = await fetchTransaction(cfg.paystackKey, reference);
  const kobo = verified?.amount ?? event.data.amount;
  if (verified && verified.status !== 'success') {
    return json({ ok: true, ignored: `status ${verified.status}` });
  }

  // Steps 4 and 5, and what follows a sale: see settle() in checkout.js,
  // which the buyer's return page shares so the two meet exactly once.
  cfg.publicOrigin = originOf(request, cfg);
  const { order: updated, replayed, ignored } = await settle(cfg, order, {
    kobo,
    // Attribution, recorded at the only moment it is knowable. Paystack's own
    // `channel` is the payment method (card, bank), not where the buyer found
    // the item — that comes from the metadata set when checkout started.
    channel: event.data?.metadata?.source_channel ?? null,
  });
  if (ignored) {
    await noteProblem(cfg, {
      kind: 'unsettled_payment',
      key: reference,
      reference,
      amount: nairaOf(kobo),
      detail: `Paid for order ${order.order_code}, but it could not be applied: ${ignored}.`,
    });
    return json({ ok: true, ignored });
  }

  return json({
    ok: true,
    replayed,
    order: updated?.order_code ?? order.order_code,
    status: updated?.status ?? order.status,
  });
}

// A plan fee or cart payment its settle step turned away. Anything else it
// ignores (already paid, a replay) is not a problem.
async function noteIgnored(cfg, reference, kobo, ignored, what) {
  if (!ignored) return;
  const unmatched = /^no such/.test(ignored);
  await noteProblem(cfg, {
    kind: unmatched ? 'unmatched_payment' : 'unsettled_payment',
    key: reference,
    reference,
    amount: nairaOf(kobo),
    detail: unmatched
      ? `Paid as a ${what}, and there is no ${what} with this reference.`
      : `Paid as a ${what}, but it could not be applied: ${ignored}.`,
  });
}

const nairaOf = (kobo) => (Number.isFinite(Number(kobo)) ? Number(kobo) / 100 : null);

// "💸 ₦32,200 has been paid to your GTBank account ending 1234", to the owner
// on the platform number.
async function tellPaidOut(cfg, payout) {
  const [tenant, account] = await Promise.all([
    db(cfg).one('tenants', `id=eq.${payout.tenant_id}&select=id,whatsapp_number`),
    db(cfg).one('payout_accounts', `tenant_id=eq.${payout.tenant_id}&select=bank_name,account_last4`),
  ]);
  const to = chatId(tenant?.whatsapp_number);
  if (!to || !account) return;
  await say(cfg, tenant, to, paidOutMessage({ amount: payout.amount, bank: account.bank_name, last4: account.account_last4 }));
}
