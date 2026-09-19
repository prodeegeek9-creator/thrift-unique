// Naira, in one place, because the alternative is a row recorded 100× too high
// and nobody noticing until a payout.
//
// The rule: Paystack speaks kobo, this application speaks naira, and the
// conversion happens exactly once — at the webhook, in the Worker. Nothing in
// src/ should ever divide by 100. If a number arriving here looks a hundred
// times too big, the bug is upstream and dividing it here will hide it.

const NGN = new Intl.NumberFormat('en-NG', {
  style: 'currency',
  currency: 'NGN',
  maximumFractionDigits: 0,
});

// ₦45,000 — the form used on every card, table and stat tile in the mockups.
// Kobo is never displayed: these are whole-naira prices set by a seller typing
// into a phone, not computed amounts.
export function formatNaira(amount) {
  if (amount == null || Number.isNaN(Number(amount))) return '—';
  return NGN.format(Math.round(Number(amount)));
}

// For stat tiles, where ₦1,284,000 needs to fit beside two others.
export function formatCompact(amount) {
  if (amount == null || Number.isNaN(Number(amount))) return '—';
  const n = Math.round(Number(amount));
  if (n >= 1_000_000) return `₦${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 100_000) return `₦${Math.round(n / 1000)}k`;
  return formatNaira(n);
}

// The seller's share after the platform's cut. Commission is stored per tenant
// rather than per tier, because the Business tier is explicitly negotiable.
export function sellerProceeds(amount, commissionPct) {
  const gross = Number(amount) || 0;
  const pct = Number(commissionPct) || 0;
  const commission = Math.round((gross * pct) / 100);
  return { gross, commission, net: gross - commission };
}

// Signed, for the "+12% this month" deltas under each stat tile.
export function formatDelta(pct) {
  if (pct == null || Number.isNaN(Number(pct))) return null;
  const n = Number(pct);
  return `${n > 0 ? '+' : ''}${n.toFixed(n % 1 === 0 ? 0 : 1)}%`;
}
