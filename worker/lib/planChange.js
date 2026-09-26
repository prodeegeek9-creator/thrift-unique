import { db } from './supabase.js';
import { TIERS, PLAN_PRICES, COMMISSION, FLAG_MIN_TIER, planIncludes, tierRank } from './plans.js';

// A store changing its own plan.
//
//   up     straight away, once it has paid the difference for the rest of
//          what it has already paid for. The difference is a plan invoice of
//          kind 'upgrade', paid through the usual pay page; settling it
//          (lib/billing.js) switches the plan.
//   down   at the end of what it has paid for. Recorded as next_tier and
//          next_tier_at; the next monthly invoice is raised at the lower
//          price and the billing sweep switches the plan when the time comes.
//
// While a store pays nothing yet (on its free trial, or not yet approved)
// either way is immediate and free. A store whose price was agreed with
// Vendwyze (plan_price set) changes plan through the operator, not here, and
// neither does a store with an overdue fee.

const DAY = 86_400_000;

// Below this the difference isn't worth a payment: the plan just changes.
export const MIN_UPGRADE_CHARGE = 100;

export class PlanChangeError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

// What changing to `tier` would do, right now. Pure.
//
//   { kind: 'upgrade' | 'downgrade' | 'keep', when: 'now' | 'next_period',
//     amount, effective_at, blocked }
export function quoteChange(tenant, tier, now = new Date()) {
  const base = { tier, kind: null, when: null, amount: 0, effective_at: null, blocked: null };
  if (!TIERS.includes(tier)) return { ...base, blocked: 'Pick a plan.' };
  if (tenant.plan_price != null) {
    return { ...base, blocked: 'Your plan price was agreed with Vendwyze. Message us to change your plan.' };
  }
  if (['past_due', 'paused'].includes(tenant.billing_status)) {
    return { ...base, blocked: 'Pay your overdue plan fee first, then change your plan.' };
  }

  const rank = tierRank(tier) - tierRank(tenant.tier);
  if (rank === 0) return { ...base, kind: 'keep', when: 'now' };

  const paying = tenant.status === 'active' && tenant.billing_status === 'active' && tenant.paid_until;
  const until = paying ? new Date(tenant.paid_until) : null;

  if (rank < 0) {
    // Nothing paid for to wait out: the lower plan starts now.
    if (!paying || until <= now) return { ...base, kind: 'downgrade', when: 'now' };
    return { ...base, kind: 'downgrade', when: 'next_period', effective_at: until.toISOString() };
  }

  if (!paying || until <= now) return { ...base, kind: 'upgrade', when: 'now' };

  // The difference in monthly price, for the days left of what is paid for,
  // counting a month as 30 days.
  const days = (until.getTime() - now.getTime()) / DAY;
  const diff = (PLAN_PRICES[tier] - PLAN_PRICES[tenant.tier]) * (days / 30);
  const amount = Math.ceil(diff);
  return {
    ...base,
    kind: 'upgrade',
    when: 'now',
    amount: amount >= MIN_UPGRADE_CHARGE ? amount : 0,
    period_end: until.toISOString(),
  };
}

// Puts a store on `tier` now: the plan, its features, and its commission if
// it was on the standard rate for its old plan (a rate the operator agreed is
// left alone). An open, unpaid monthly invoice moves to the new price.
export async function applyTier(cfg, tenantId, tier) {
  const tenant = await db(cfg).one('tenants', `id=eq.${tenantId}&select=id,tier,commission_pct,plan_price`);
  if (!tenant) return null;

  const standard = Number(tenant.commission_pct) === COMMISSION[tenant.tier];
  await db(cfg).update(
    'tenants',
    `id=eq.${tenantId}`,
    {
      tier,
      next_tier: null,
      next_tier_at: null,
      ...(standard ? { commission_pct: COMMISSION[tier] } : {}),
    },
    { returning: false }
  );

  for (const flag of Object.keys(FLAG_MIN_TIER)) {
    await db(cfg).insert(
      'tenant_features',
      { tenant_id: tenantId, flag, enabled: planIncludes(tier, flag) },
      { onConflict: 'tenant_id,flag', merge: true, returning: false }
    );
  }

  if (tenant.plan_price == null) {
    await db(cfg).update(
      'plan_invoices',
      `tenant_id=eq.${tenantId}&kind=eq.period&status=eq.open`,
      { tier, amount: PLAN_PRICES[tier] },
      { returning: false }
    );
  }
  return { from: tenant.tier, to: tier };
}

// Does what quoteChange() says. Returns what happened:
//
//   { done: 'changed' }                        now, nothing to pay
//   { done: 'pay', invoice }                   an upgrade invoice to pay
//   { done: 'scheduled', effective_at }        a downgrade at period end
//   { done: 'kept' }                           same plan; any scheduled
//                                              downgrade is called off
export async function changePlan(cfg, tenant, tier, { now = new Date(), newRef }) {
  const quote = quoteChange(tenant, tier, now);
  if (quote.blocked) throw new PlanChangeError(quote.blocked);

  // Whatever was asked before is superseded: an unpaid upgrade, a downgrade.
  await db(cfg).update(
    'plan_invoices',
    `tenant_id=eq.${tenant.id}&kind=eq.upgrade&status=eq.open`,
    { status: 'void' },
    { returning: false }
  );

  if (quote.kind === 'keep') {
    if (tenant.next_tier) {
      await db(cfg).update('tenants', `id=eq.${tenant.id}`, { next_tier: null, next_tier_at: null }, { returning: false });
      await repriceNextInvoice(cfg, tenant, tenant.tier);
    }
    return { done: 'kept', quote };
  }

  if (quote.kind === 'downgrade' && quote.when === 'next_period') {
    await db(cfg).update(
      'tenants',
      `id=eq.${tenant.id}`,
      { next_tier: tier, next_tier_at: quote.effective_at },
      { returning: false }
    );
    await repriceNextInvoice(cfg, { ...tenant, next_tier_at: quote.effective_at }, tier);
    return { done: 'scheduled', effective_at: quote.effective_at, quote };
  }

  if (quote.amount > 0) {
    // (tenant_id, period_start) is unique across plan invoices, so two
    // requests in the same millisecond would collide: step past it.
    for (let i = 0; i < 3; i++) {
      const invoice = await db(cfg).insert(
        'plan_invoices',
        {
          tenant_id: tenant.id,
          kind: 'upgrade',
          from_tier: tenant.tier,
          tier,
          amount: quote.amount,
          period_start: new Date(now.getTime() + i).toISOString(),
          period_end: quote.period_end,
          status: 'open',
          payment_ref: newRef(),
        },
        { onConflict: 'tenant_id,period_start' }
      );
      if (invoice) return { done: 'pay', invoice, quote };
    }
    throw new PlanChangeError('Something went wrong. Try again in a moment.');
  }

  await applyTier(cfg, tenant.id, tier);
  return { done: 'changed', quote };
}

// The open monthly invoice for the period the change applies to, at the price
// of `tier`. Only an unpaid one: a paid month stays paid for.
async function repriceNextInvoice(cfg, tenant, tier) {
  const from = tenant.next_tier_at ?? tenant.paid_until;
  if (!from) return;
  await db(cfg).update(
    'plan_invoices',
    `tenant_id=eq.${tenant.id}&kind=eq.period&status=eq.open&period_start=gte.${encodeURIComponent(from)}`,
    { tier, amount: PLAN_PRICES[tier] },
    { returning: false }
  );
}
