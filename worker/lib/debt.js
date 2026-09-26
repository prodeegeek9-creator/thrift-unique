import { db } from './supabase.js';

// What a store owes the platform: sales it had already been paid for and then
// refunded (lib/refunds.js). Kept as one running figure on the tenant, and
// taken back out of the store's next payouts (lib/orders.js).
//
// Changed with a compare-and-set on the old value rather than read-modify-write,
// so two payouts or a payout and a refund landing together cannot both start
// from the same figure and lose one change.

const TRIES = 5;

// Adds to (positive) or forgives (negative) what the store owes. Never below 0.
export async function adjustDebt(cfg, tenantId, delta) {
  const change = round(delta);
  if (!change) return null;
  for (let i = 0; i < TRIES; i++) {
    const row = await db(cfg).one('tenants', `id=eq.${tenantId}&select=owed_to_platform`);
    if (!row) return null;
    const before = round(row.owed_to_platform);
    const after = Math.max(0, round(before + change));
    const hit = await db(cfg).update(
      'tenants',
      `id=eq.${tenantId}&owed_to_platform=eq.${before}`,
      { owed_to_platform: after }
    );
    if (hit.length) return after;
  }
  throw new Error('Could not update what the store owes; try again');
}

// Takes up to `max` naira of the debt, for a payout about to be made. Returns
// what it took.
export async function takeDebt(cfg, tenantId, max) {
  const cap = round(max);
  if (cap <= 0) return 0;
  for (let i = 0; i < TRIES; i++) {
    const row = await db(cfg).one('tenants', `id=eq.${tenantId}&select=owed_to_platform`);
    const before = round(row?.owed_to_platform);
    if (before <= 0) return 0;
    const take = Math.min(before, cap);
    const hit = await db(cfg).update(
      'tenants',
      `id=eq.${tenantId}&owed_to_platform=eq.${before}`,
      { owed_to_platform: round(before - take) }
    );
    if (hit.length) return take;
  }
  // Better to pay the store in full this once than to fail its payout.
  return 0;
}

function round(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
