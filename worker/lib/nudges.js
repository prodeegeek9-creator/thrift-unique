import { db } from './supabase.js';
import { TIERS, PLAN_PRICES, FLAG_MIN_TIER, PLAN_PITCH, COMING_SOON, tierRank } from './plans.js';
import { formatNaira } from './bot.js';
import { chatId } from './waha.js';

// Suggesting a bigger plan, at the moment it would pay off.
//
// Four signals, strongest first:
//
//   locked      the store opened a screen its plan doesn't include (last 7 days)
//   big_ticket  a Starter store sold something for ₦50,000 or more: buyer
//               protection is what makes expensive items easy to sell
//   sales       this month's sales are at the level of the next plan
//   listings    this month's listings are
//
// Shown on the dashboard whenever one applies, and sent on WhatsApp to the
// owner at most once every WHATSAPP_EVERY_DAYS. Never to a store that is
// overdue, on an agreed price, or already moving down a plan.

export const NUDGE_LISTINGS = { starter: 15, growth: 60 };
export const NUDGE_SALES = { starter: 300_000, growth: 1_500_000 };
export const BIG_TICKET = 50_000;
export const LOCKED_WITHIN_DAYS = 7;
export const WHATSAPP_EVERY_DAYS = 14;

const DAY = 86_400_000;
const PAID_STATUSES = ['paid', 'escrow', 'completed', 'processing'];

const FEATURE_NAMES = {
  contacts: 'your buyer list',
  disputes: 'dispute handling',
  escrow: 'buyer protection',
  publish_instagram: 'Instagram posting',
  publish_facebook: 'Facebook posting',
  analytics: 'sales analytics',
  team: 'staff accounts',
  publish_tiktok: 'TikTok posting',
  catalog_sync: 'WooCommerce sync',
  ai_match: 'stock matching',
  priority_support: 'priority support',
};

export function startOfMonth(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

// What the rules look at, for one store.
export async function nudgeStats(cfg, tenant, now = new Date()) {
  const since = startOfMonth(now);
  const lockedSince = new Date(now.getTime() - LOCKED_WITHIN_DAYS * DAY).toISOString();
  const [listings, orders, locked] = await Promise.all([
    db(cfg).select('products', `tenant_id=eq.${tenant.id}&created_at=gte.${since}&select=id&limit=1000`),
    db(cfg).select(
      'orders',
      `tenant_id=eq.${tenant.id}&paid_at=gte.${since}&status=in.(${PAID_STATUSES.join(',')})&select=amount&limit=2000`
    ),
    db(cfg).select(
      'nudge_events',
      `tenant_id=eq.${tenant.id}&kind=eq.locked&created_at=gte.${lockedSince}&select=flag,created_at&order=created_at.desc&limit=10`
    ),
  ]);
  const amounts = orders.map((o) => Number(o.amount) || 0);
  return {
    listings: listings.length,
    sales: amounts.reduce((a, b) => a + b, 0),
    biggest: amounts.length ? Math.max(...amounts) : 0,
    locked: locked.map((l) => l.flag).filter(Boolean),
  };
}

// The nudge for this store now, or null. Pure.
//
//   { reason, tier, headline, body, features, coming_soon, price }
export function pickNudge(tenant, stats) {
  if (!tenant || tenant.plan_price != null || tenant.next_tier) return null;
  if (['past_due', 'paused'].includes(tenant.billing_status)) return null;
  const rank = tierRank(tenant.tier);
  const next = TIERS[rank + 1];
  if (!next) return null;

  const offer = (reason, tier, headline, body) => ({
    reason,
    tier,
    headline,
    body,
    features: PLAN_PITCH[tier],
    coming_soon: COMING_SOON[tier] ?? null,
    price: PLAN_PRICES[tier],
  });

  const flag = (stats.locked ?? []).find((f) => FLAG_MIN_TIER[f] && tierRank(FLAG_MIN_TIER[f]) > rank);
  if (flag) {
    const tier = FLAG_MIN_TIER[flag];
    const name = FEATURE_NAMES[flag] ?? 'that feature';
    return offer('locked', tier, `You looked at ${name}.`, `It comes with ${cap(tier)}, along with ${list(PLAN_PITCH[tier], name)}.`);
  }

  if (tenant.tier === 'starter' && stats.biggest >= BIG_TICKET) {
    return offer(
      'big_ticket',
      'growth',
      `You just sold something for ${formatNaira(stats.biggest)}.`,
      'On Growth, buyers pay into buyer protection and you are paid when they confirm it arrived. Expensive items sell more easily when buyers know their money is safe.'
    );
  }

  if (stats.sales >= NUDGE_SALES[tenant.tier]) {
    return offer(
      'sales',
      next,
      `${formatNaira(stats.sales)} in sales this month.`,
      `You're selling like a ${cap(next)} store. ${cap(next)} adds ${list(PLAN_PITCH[next])}.`
    );
  }

  if (stats.listings >= NUDGE_LISTINGS[tenant.tier]) {
    return offer(
      'listings',
      next,
      `You've listed ${stats.listings} items this month.`,
      `${cap(next)} adds ${list(PLAN_PITCH[next])}.`
    );
  }

  return null;
}

// The WhatsApp version, to the owner on the platform number.
export function nudgeMessage(nudge, { origin, store }) {
  const link = `${origin ?? ''}/dashboard/billing?plan=${nudge.tier}`;
  return (
    `💡 ${nudge.headline} ${nudge.body}\n\n` +
    `*${cap(nudge.tier)}* is ${formatNaira(nudge.price)} a month` +
    `${nudge.coming_soon ? `, with ${nudge.coming_soon} coming soon` : ''}. ` +
    `You only pay the difference for the rest of this month.\n\n` +
    `See it for ${store}: ${link}`
  );
}

// A store opening a screen its plan doesn't include. Once a day per screen is
// plenty to go on.
export async function recordLocked(cfg, tenantId, flag, now = new Date()) {
  if (!FLAG_MIN_TIER[flag]) return false;
  const since = new Date(now.getTime() - DAY).toISOString();
  const seen = await db(cfg).one(
    'nudge_events',
    `tenant_id=eq.${tenantId}&kind=eq.locked&flag=eq.${flag}&created_at=gte.${since}&select=id`
  );
  if (seen) return false;
  await db(cfg).insert(
    'nudge_events',
    { tenant_id: tenantId, kind: 'locked', flag, created_at: now.toISOString() },
    { returning: false }
  );
  return true;
}

// The daily WhatsApp pass. Stores that pay a standard price and have a plan
// above them; at most one message each per WHATSAPP_EVERY_DAYS.
export async function nudgeSweep(cfg, { now = new Date(), say, limit = 300 } = {}) {
  const out = { checked: 0, sent: 0 };
  if (!say) return out;

  const tenants = await db(cfg).select(
    'tenants',
    'status=eq.active&tier=in.(starter,growth)&plan_price=is.null&billing_status=in.(trial,active)' +
      `&select=id,slug,name,tier,status,whatsapp_number,billing_status,plan_price,next_tier&limit=${limit}`
  );
  const since = new Date(now.getTime() - WHATSAPP_EVERY_DAYS * DAY).toISOString();

  for (const tenant of tenants ?? []) {
    out.checked += 1;
    try {
      if (!chatId(tenant.whatsapp_number)) continue;
      const recent = await db(cfg).one(
        'nudge_events',
        `tenant_id=eq.${tenant.id}&kind=eq.whatsapp&created_at=gte.${since}&select=id`
      );
      if (recent) continue;

      const nudge = pickNudge(tenant, await nudgeStats(cfg, tenant, now));
      if (!nudge) continue;

      // Recorded first: a send that fails is not retried tomorrow, which is
      // the right side to err on for a sales message.
      await db(cfg).insert(
        'nudge_events',
        { tenant_id: tenant.id, kind: 'whatsapp', reason: nudge.reason, tier: nudge.tier, created_at: now.toISOString() },
        { returning: false }
      );
      await say(tenant, nudgeMessage(nudge, { origin: cfg.publicOrigin, store: tenant.name }));
      out.sent += 1;
    } catch (err) {
      console.error('nudge sweep: failed on', tenant.slug, err?.message ?? err);
    }
  }
  return out;
}

function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// "a, b and c", leaving out one already named.
function list(items, except = null) {
  const xs = items.filter((x) => !except || !x.toLowerCase().includes(except.toLowerCase()));
  if (xs.length <= 1) return lower(xs[0] ?? '');
  return `${xs.slice(0, -1).map(lower).join(', ')} and ${lower(xs.at(-1))}`;
}

function lower(s) {
  // Keep "7% commission…" and proper nouns as written; lower-case the rest.
  return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}
