import { db } from './supabase.js';

// Money problems that would otherwise reach nothing but the logs, kept for
// the console's Money page (migration 0034): a payment nobody can match, one
// that could not be applied, a webhook Paystack did not sign.
//
// Recording one never fails its caller. The webhook has to answer Paystack
// whatever happens here, and a problem that can't be written is logged.

const KINDS = ['unmatched_payment', 'unsettled_payment', 'bad_signature'];

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

// Lagos days, so "today" in the console is the operator's today.
export function lagosDay(now = new Date()) {
  return new Date(new Date(now).getTime() + 3_600_000).toISOString().slice(0, 10);
}
