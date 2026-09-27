import { db } from './supabase.js';

// Money problems that would otherwise reach nothing but the logs, kept for
// the console's Money page (migration 0034): a payment nobody can match, one
// that could not be applied, a webhook Paystack did not sign.
//
// Recording one never fails its caller. The webhook has to answer Paystack
// whatever happens here, and a problem that can't be written is logged.

const KINDS = [
  'unmatched_payment', 'unsettled_payment', 'bad_signature',
  // From the daily check against Paystack (lib/reconcile.js, migration 0035).
  'amount_mismatch', 'missing_payment', 'payout_mismatch', 'unknown_transfer',
];

// Seen again, it is the same row, reopened if it had been marked sorted.
export async function noteProblem(cfg, { kind, key, reference = null, amount = null, detail = null }) {
  if (!KINDS.includes(kind) || !key) return;
  try {
    await db(cfg).insert(
      'payment_problems',
      {
        kind,
        key: String(key).slice(0, 200),
        reference,
        amount: amount == null ? null : Number(amount),
        detail: detail ? String(detail).slice(0, 500) : null,
        last_seen: new Date().toISOString(),
        resolved_at: null,
        resolved_by: null,
        resolution: null,
      },
      { onConflict: 'kind,key', merge: true, returning: false }
    );
  } catch (err) {
    console.error('problem not recorded:', kind, key, err?.message ?? err);
  }
}

// What settle() and settleCart() answer when Paystack took a different
// amount from the price. They record the problem themselves (amountRefused),
// so a caller seeing this must not record it again under another kind.
export const AMOUNT_MISMATCH = 'amount mismatch';

// Whether Paystack took the price. `requestedKobo` is Paystack's
// requested_amount, which differs from `amount` when the account passes its
// fee on to the buyer: either one being the price is the price paid.
export function paidInFull(expectedKobo, { kobo, requestedKobo }) {
  return Number(kobo) === expectedKobo || (requestedKobo != null && Number(requestedKobo) === expectedKobo);
}

// A payment for the wrong amount: nothing is sold and nothing is owed, and it
// waits on the Money page for a person to refund or settle it.
export async function amountRefused(cfg, { reference, kobo, what, expectedKobo }) {
  console.error('payment amount differs:', reference, kobo, expectedKobo);
  await noteProblem(cfg, {
    kind: 'amount_mismatch',
    key: reference,
    reference,
    amount: Number(kobo) / 100,
    detail:
      `Paystack took ₦${(Number(kobo) / 100).toLocaleString('en-NG')} for ${what}, ` +
      `whose price is ₦${(expectedKobo / 100).toLocaleString('en-NG')}. Not settled: nothing was sold and the store is owed nothing. Refund it, or settle it by hand.`,
  });
}

// Lagos days, so "today" in the console is the operator's today.
export function lagosDay(now = new Date()) {
  return new Date(new Date(now).getTime() + 3_600_000).toISOString().slice(0, 10);
}
