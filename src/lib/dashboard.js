import { supabase } from './supabase.js';
import { fetchBalance } from './payouts.js';
import { fetchRecentOrders } from './orders.js';
import { nextTier } from './billing.js';

// The Overview screen: four stat tiles, the recent orders table, and the
// upgrade nudge.

const COUNTED = ['paid', 'completed'];

export async function fetchOverview(tenantId) {
  if (!tenantId) return null;

  const now = new Date();
  const weekAgo = daysAgo(7);
  const monthStart = startOfMonth(now);
  const lastMonthStart = startOfMonth(new Date(now.getFullYear(), now.getMonth() - 1, 1));

  const [
    active,
    newThisWeek,
    soldThisMonth,
    soldThisWeek,
    salesAllTime,
    salesThisMonth,
    salesLastMonth,
    balance,
    recentOrders,
  ] = await Promise.all([
    count('products', tenantId, (q) => q.eq('status', 'active')),
    count('products', tenantId, (q) => q.gte('created_at', weekAgo)),
    count('products', tenantId, (q) => q.eq('status', 'sold').gte('sold_at', monthStart)),
    count('products', tenantId, (q) => q.eq('status', 'sold').gte('sold_at', weekAgo)),
    sumOrders(tenantId),
    sumOrders(tenantId, monthStart),
    sumOrders(tenantId, lastMonthStart, monthStart),
    fetchBalance(tenantId),
    fetchRecentOrders(tenantId, 5),
  ]);

  return {
    activeListings: active,
    newListingsThisWeek: newThisWeek,
    soldThisMonth,
    soldThisWeek,
    totalSales: salesAllTime,
    salesThisMonth,
    // Null rather than 0 when there is no previous month to compare against.
    // "+0%" on a store's first month is a made-up number; the tile should show
    // nothing instead.
    salesDeltaPct: percentChange(salesLastMonth, salesThisMonth),
    availableBalance: balance.available,
    pendingEscrow: balance.pendingEscrow,
    nextPayoutNote: balance.nextPayoutNote,
    recentOrders,
  };
}

// The green card: "You've listed 18 items this month. Growth gives you
// Instagram + Facebook, buyer protection and buyer tracking."
//
// Volume-triggered rather than shown always, because a nudge that is always
// there is furniture. A seller who has listed twenty items in a month is
// working hard enough on distribution that more of it is worth money to them;
// one who has listed two is not, and telling them to upgrade is noise.
//
// "Remind me later" is a per-viewer convenience and lives in localStorage —
// losing it in a private window just means seeing the card again, which is the
// right failure.
const NUDGE_THRESHOLD = 15;
const SNOOZE_DAYS = 14;

export function upgradeNudge(tenant, usage) {
  if (!tenant) return null;

  const next = nextTier(tenant);
  if (!next) return null;
  if ((usage?.listings ?? 0) < NUDGE_THRESHOLD) return null;
  if (isSnoozed(tenant.id)) return null;

  return {
    tier: next,
    listings: usage.listings,
    headline: `You've listed ${usage.listings} items this month.`,
    body:
      next === 'growth'
        ? 'Growth adds Instagram and Facebook, buyer protection and buyer tracking.'
        : 'Business adds TikTok, staff accounts and full analytics.',
  };
}

export function snoozeNudge(tenantId) {
  try {
    localStorage.setItem(`ut-nudge-${tenantId}`, String(Date.now()));
  } catch {
    // Private windows and blocked site data both throw. Not remembering means
    // the card comes back, which is a fine outcome.
  }
}

function isSnoozed(tenantId) {
  try {
    const at = Number(localStorage.getItem(`ut-nudge-${tenantId}`));
    return Boolean(at) && Date.now() - at < SNOOZE_DAYS * 86_400_000;
  } catch {
    return false;
  }
}

async function count(table, tenantId, build) {
  let q = supabase
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);

  if (build) q = build(q);

  const { count: n, error } = await q;
  if (error) throw error;
  return n ?? 0;
}

async function sumOrders(tenantId, from, to) {
  let q = supabase
    .from('orders')
    .select('amount')
    .eq('tenant_id', tenantId)
    .in('status', COUNTED);

  if (from) q = q.gte('created_at', from);
  if (to) q = q.lt('created_at', to);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).reduce((n, r) => n + Number(r.amount || 0), 0);
}

function percentChange(before, after) {
  if (!before) return null;
  return Math.round(((after - before) / before) * 100);
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

function daysAgo(n) {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}
