import { config } from './env.js';
import { db } from './supabase.js';
import { paystack, settleTransfer } from './transfers.js';
import { fetchTransaction } from './paystack.js';
import { nairaToKobo } from './money.js';
import { noteProblem, AMOUNT_MISMATCH, paidInFull } from './problems.js';
import { byPaymentRef } from './orders.js';
import { settleCart, cartRefOf, isCartRef } from './cartCheckout.js';
import { settle } from '../routes/checkout.js';
import { settlePlanPayment } from '../routes/billing.js';

// The daily check of our books against Paystack's (migration 0035).
//
// Webhooks are how money normally reaches the database, and a webhook can be
// lost: Paystack gives up retrying, the Worker was down, the key was wrong for
// an afternoon. So once a day the Worker lists what Paystack says happened
// over the last week and compares it with what we recorded:
//
//   Paystack's successful payments   each should be an order, a cart or a
//                                    plan fee, applied, for the same amount
//   our payments from the last 48h   each should be a successful payment on
//                                    Paystack (checked one by one before
//                                    saying it isn't)
//   Paystack's transfers             each should be a payout of ours, in the
//                                    same state
//   our payouts from the last 48h    each paid one should be a successful
//                                    transfer on Paystack
//
// Anything Paystack's own record settles is settled, through the same code
// the missed webhook would have run: a payment nobody applied is applied, a
// transfer's outcome is recorded. Everything else goes to the console's Money
// page as a payment problem. Each run is kept in reconciliation_runs.
//
// Overlapping windows are safe: settling is idempotent, and a problem is one
// row per kind and reference however often it is found.

export const RECONCILE_HOUR_UTC = 3; // 4am in Lagos, before anybody is working
export const LOOKBACK_DAYS = 7;
export const RECENT_HOURS = 48;

const PER_PAGE = 100;
const MAX_PAGES = 50;
const iso = (t) => new Date(t).toISOString();
const naira = (kobo) => Number(kobo) / 100;

// From the hourly scheduled handler: once a day, at RECONCILE_HOUR_UTC, and
// not again if that hour's run already happened (a retried cron).
export async function reconcileSweep(env, { now = new Date() } = {}) {
  const at = new Date(now);
  if (at.getUTCHours() !== RECONCILE_HOUR_UTC) return null;
  const cfg = config(env);
  if (!cfg.supabaseUrl || !cfg.serviceKey || !cfg.paystackKey) return null;

  const hourStart = new Date(at);
  hourStart.setUTCMinutes(0, 0, 0);
  const already = await db(cfg).one('reconciliation_runs', `ran_at=gte.${iso(hourStart)}&select=id`);
  if (already) return null;
  return reconcile(cfg, { now: at });
}

export async function reconcile(cfg, { now = new Date() } = {}) {
  const to = new Date(now);
  const from = new Date(to.getTime() - LOOKBACK_DAYS * 86_400_000);
  const since = iso(to.getTime() - RECENT_HOURS * 3_600_000);

  const run = {
    ran_at: iso(to),
    window_from: iso(from),
    window_to: iso(to),
    payments: 0,
    transfers: 0,
    settled_late: 0,
    payouts_updated: 0,
    problems: 0,
    error: null,
  };
  const note = async (problem) => {
    await noteProblem(cfg, problem);
    run.problems += 1;
  };

  try {
    const range = { from: iso(from), to: iso(to) };
    const [payments, transfers] = await Promise.all([
      listAll(cfg, '/transaction', { status: 'success', ...range }),
      listAll(cfg, '/transfer', range),
    ]);
    run.payments = payments.length;
    run.transfers = transfers.length;

    for (const tx of payments) {
      try {
        await checkPayment(cfg, tx, run, note);
      } catch (err) {
        console.error('reconcile: payment', tx?.reference, err?.message ?? err);
      }
    }
    await checkOurPayments(cfg, payments, since, note);

    for (const t of transfers) {
      try {
        await checkTransfer(cfg, t, run, note);
      } catch (err) {
        console.error('reconcile: transfer', t?.reference, err?.message ?? err);
      }
    }
    await checkOurPayouts(cfg, transfers, since, note);
  } catch (err) {
    run.error = String(err?.message ?? err).slice(0, 300);
    console.error('reconcile failed:', run.error);
  }

  await db(cfg)
    .insert('reconciliation_runs', run, { returning: false })
    .catch((err) => console.error('reconcile: run not recorded:', err?.message ?? err));
  return run;
}

// Every record Paystack lists for the window, a page at a time. Paystack's
// data arrives without a page count here (lib/transfers.js hands back `data`
// only), so a short page is the last one.
async function listAll(cfg, path, params) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const q = new URLSearchParams({ ...params, perPage: String(PER_PAGE), page: String(page) });
    const data = await paystack(cfg, `${path}?${q}`);
    const rows = Array.isArray(data) ? data : [];
    out.push(...rows);
    if (rows.length < PER_PAGE) return out;
  }
  throw new Error(`Paystack listed more than ${PER_PAGE * MAX_PAGES} records at ${path}; the check stopped short`);
}

// ── Paystack's payments against ours ─────────────────────────────────────────

async function checkPayment(cfg, tx, run, note) {
  const ref = String(tx?.reference ?? '');
  const kobo = Number(tx?.amount);
  if (!ref) return;
  const found = (what) =>
    note({
      kind: 'unmatched_payment',
      key: ref,
      reference: ref,
      amount: naira(kobo),
      detail: `Found in the daily check: Paystack has this payment, and ${what}.`,
    });

  // A buyer's single item.
  if (ref.startsWith('utp_')) {
    const order = await byPaymentRef(cfg, ref);
    if (!order) return found('no order has its reference');
    if (order.status === 'awaiting_payment') {
      const r = await settle(cfg, order, { kobo, requestedKobo: tx.requested_amount, channel: tx.metadata?.source_channel ?? null });
      if (r.ignored === AMOUNT_MISMATCH) return;
      if (r.ignored) return unsettled(note, ref, kobo, `order ${order.order_code}: ${r.ignored}`);
      run.settled_late += 1;
      return;
    }
    if (order.status === 'cancelled') {
      return unsettled(note, ref, kobo, `order ${order.order_code}, which had been cancelled. Refund it on Paystack, or settle it by hand`);
    }
    if (!paidInFull(nairaToKobo(order.amount), { kobo, requestedKobo: tx.requested_amount })) {
      return mismatch(note, ref, kobo, `Order ${order.order_code} has ₦${Number(order.amount).toLocaleString('en-NG')}`);
    }
    return;
  }

  // A WhatsApp cart: one payment for several orders.
  if (isCartRef(ref)) {
    const cart = await db(cfg).one('carts', `payment_ref=eq.${ref}&select=id,status,amount`);
    if (!cart) return found('no WhatsApp cart has its reference');
    if (cart.status !== 'paid') {
      const r = await settleCart(cfg, ref, { kobo, requestedKobo: tx.requested_amount });
      if (r.ignored === AMOUNT_MISMATCH) return;
      if (r.ignored) return unsettled(note, ref, kobo, `a WhatsApp cart: ${r.ignored}`);
      if (r.settled) run.settled_late += 1;
      return;
    }
    if (!paidInFull(nairaToKobo(cart.amount), { kobo, requestedKobo: tx.requested_amount })) {
      return mismatch(note, ref, kobo, `The cart has ₦${Number(cart.amount).toLocaleString('en-NG')}`);
    }
    return;
  }

  // A store's plan fee: utb_<invoice>_<attempt>.
  if (ref.startsWith('utb_') || tx.metadata?.kind === 'plan') {
    const invoiceRef = tx.metadata?.invoice_ref ?? ref.split('_').slice(0, 2).join('_');
    const invoice = await db(cfg).one('plan_invoices', `payment_ref=eq.${encodeURIComponent(invoiceRef)}&select=id,status`);
    if (!invoice) return found('no plan fee invoice has its reference');
    if (invoice.status !== 'paid') {
      const r = await settlePlanPayment(cfg, tx);
      if (r.ignored) return unsettled(note, ref, kobo, `a plan fee: ${r.ignored}`);
      run.settled_late += 1;
    }
    return;
  }

  return found("its reference isn't one Vendwyze makes (a payment page or a charge set up on the Paystack dashboard?)");
}

function unsettled(note, ref, kobo, what) {
  return note({
    kind: 'unsettled_payment',
    key: ref,
    reference: ref,
    amount: naira(kobo),
    detail: `Found in the daily check: paid for ${what}.`,
  });
}

function mismatch(note, ref, kobo, ours) {
  return note({
    kind: 'amount_mismatch',
    key: ref,
    reference: ref,
    amount: naira(kobo),
    detail: `Paystack took ₦${naira(kobo).toLocaleString('en-NG')}. ${ours}.`,
  });
}

// Our side: every payment recorded in the last RECENT_HOURS should be a
// successful payment on Paystack. One missing from the list is asked about on
// its own before it is called missing; Paystack not answering is not an
// answer.
async function checkOurPayments(cfg, payments, since, note) {
  const paid = new Set(payments.map((t) => String(t.reference)));
  const invoicesPaid = new Set(
    payments
      .filter((t) => String(t.reference).startsWith('utb_') || t.metadata?.kind === 'plan')
      .map((t) => t.metadata?.invoice_ref ?? String(t.reference).split('_').slice(0, 2).join('_'))
  );

  const orders = await db(cfg).select(
    'orders',
    `paid_at=gte.${since}&payment_ref=not.is.null&select=order_code,payment_ref,amount&limit=5000`
  );
  const checked = new Set();
  for (const o of orders) {
    const ref = cartRefOf(o.payment_ref) ?? o.payment_ref;
    if (paid.has(ref) || checked.has(ref)) continue;
    checked.add(ref);
    const verified = await fetchTransaction(cfg.paystackKey, ref).catch(() => 'unknown');
    if (verified === 'unknown' || verified?.status === 'success') continue;
    await note({
      kind: 'missing_payment',
      key: ref,
      reference: ref,
      amount: Number(o.amount),
      detail: `Order ${o.order_code} is recorded as paid, and Paystack has no successful payment for ${ref}${verified?.status ? ` (it says ${verified.status})` : ''}.`,
    });
  }

  // Plan fees paid through Paystack. Paid by hand ('manual') never touched it.
  const invoices = await db(cfg).select(
    'plan_invoices',
    `status=eq.paid&paid_at=gte.${since}&paid_via=in.(link,card)&select=payment_ref,amount&limit=5000`
  );
  for (const inv of invoices) {
    if (invoicesPaid.has(inv.payment_ref)) continue;
    await note({
      kind: 'missing_payment',
      key: inv.payment_ref,
      reference: inv.payment_ref,
      amount: Number(inv.amount),
      detail: `A plan fee is recorded as paid through Paystack, and Paystack lists no successful payment for ${inv.payment_ref} this week.`,
    });
  }
}

// ── Paystack's transfers against our payouts ─────────────────────────────────

const OUTCOMES = { success: 'transfer.success', failed: 'transfer.failed', reversed: 'transfer.reversed' };

async function checkTransfer(cfg, t, run, note) {
  const ref = String(t?.reference ?? '');
  const payout = ref
    ? await db(cfg).one('payouts', `reference=eq.${encodeURIComponent(ref.toUpperCase())}&select=id,status,amount,reference`)
    : null;

  if (!payout) {
    return note({
      kind: 'unknown_transfer',
      key: String(t?.transfer_code ?? ref ?? t?.id),
      reference: ref || null,
      amount: naira(t?.amount),
      detail: `A transfer out of the Paystack balance (${t?.status ?? 'status unknown'}${t?.recipient?.name ? `, to ${t.recipient.name}` : ''}) that is not a Vendwyze payout. Made by hand on the Paystack dashboard?`,
    });
  }

  if (nairaToKobo(payout.amount) !== Number(t.amount)) {
    await note({
      kind: 'payout_mismatch',
      key: payout.reference,
      reference: payout.reference,
      amount: Number(payout.amount),
      detail: `Paystack sent ₦${naira(t.amount).toLocaleString('en-NG')} for this payout of ₦${Number(payout.amount).toLocaleString('en-NG')}.`,
    });
  }

  // Paystack's outcome, where ours doesn't have it yet: what the transfer
  // webhook would have done.
  const outcome = OUTCOMES[t.status];
  const behind =
    (t.status === 'success' && ['sending', 'pending'].includes(payout.status)) ||
    (['failed', 'reversed'].includes(t.status) && ['sending', 'paid'].includes(payout.status));
  if (outcome && behind) {
    await settleTransfer(cfg, { event: outcome, data: t });
    run.payouts_updated += 1;
  }
}

// Our side: every payout marked paid in the last RECENT_HOURS should be a
// successful transfer on Paystack.
async function checkOurPayouts(cfg, transfers, since, note) {
  const listed = new Map(transfers.map((t) => [String(t.reference ?? '').toUpperCase(), t]));
  const payouts = await db(cfg).select(
    'payouts',
    `status=eq.paid&paid_at=gte.${since}&select=reference,amount&limit=5000`
  );
  for (const p of payouts) {
    if (!p.reference) continue;
    let t = listed.get(p.reference);
    if (!t) {
      t = await paystack(cfg, `/transfer/verify/${encodeURIComponent(p.reference.toLowerCase())}`).catch((err) =>
        err?.status === 404 || err?.status === 400 ? null : 'unknown'
      );
      if (t === 'unknown') continue;
    }
    if (t?.status === 'success') continue;
    await note({
      kind: 'payout_mismatch',
      key: p.reference,
      reference: p.reference,
      amount: Number(p.amount),
      detail: t
        ? `This payout is recorded as paid, and Paystack says the transfer is ${t.status}.`
        : 'This payout is recorded as paid, and Paystack has no transfer for it.',
    });
  }
}
