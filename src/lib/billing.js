import { supabase } from './supabase.js';
import { FLAG_MIN_TIER, TIERS, hasFeature, minTierFor } from './features.js';

// The plan card, the usage counters and the two feature columns.

// Usage this month: "Listings 24 · Orders 9 · Social posts 68".
//
// Counted from the rows rather than kept as a running total on the tenant. A
// counter column drifts the first time anything is deleted or a webhook is
// replayed, and the only person who notices is a seller being told they are
// over a limit they have not reached.
export async function fetchUsage(tenantId) {
  const empty = { listings: 0, orders: 0, socialPosts: 0, since: null };
  if (!tenantId) return empty;

  const since = startOfMonth();

  const [listings, orders, posts] = await Promise.all([
    supabase
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .gte('created_at', since),
    supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .gte('created_at', since),
    supabase
      .from('listing_channel_posts')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('status', 'posted')
      .gte('created_at', since),
  ]);

  for (const r of [listings, orders, posts]) if (r.error) throw r.error;

  return {
    listings: listings.count ?? 0,
    orders: orders.count ?? 0,
    socialPosts: posts.count ?? 0,
    since,
  };
}

// The two columns on the Billing screen: what this plan includes, and what the
// next one up would add.
//
// Both are derived from FLAG_MIN_TIER so a flag that moves between tiers moves
// in one file and this screen follows. Hand-written lists here would be a
// third copy of the tier map, and the one most likely to go stale — it is
// marketing copy, so nobody greps it when the product changes.
export function planFeatures(tenant) {
  if (!tenant) return { included: [], locked: [] };

  const included = [];
  const locked = [];

  for (const flag of Object.keys(FLAG_MIN_TIER)) {
    (hasFeature(tenant, flag) ? included : locked).push({
      flag,
      label: FEATURE_LABELS[flag] ?? flag,
      minTier: minTierFor(flag),
    });
  }

  return { included, locked };
}

// The tier above this one, or null at the top. Drives the "Explore Business"
// panel, which should not appear to somebody already on Business.
export function nextTier(tenant) {
  if (!tenant) return null;
  const i = TIERS.indexOf(tenant.tier);
  return i >= 0 && i < TIERS.length - 1 ? TIERS[i + 1] : null;
}

// Short labels for the feature checklists. Deliberately in the seller's terms
// rather than the flag's: "Buyer protection", not "escrow".
const FEATURE_LABELS = {
  contacts: 'Buyer tracking',
  disputes: 'Dispute support',
  escrow: 'Escrow payments',
  publish_instagram: 'Instagram',
  publish_facebook: 'Facebook',
  analytics: 'Advanced analytics',
  team: 'Staff accounts',
  publish_tiktok: 'TikTok',
  catalog_sync: 'WooCommerce sync',
  ai_match: 'AI product matching',
  priority_support: 'Dedicated support',
};

// WhatsApp Status is on every tier and so has no flag, but the Billing screen
// still lists it — it is the thing the whole product is built around, and a
// feature list that omits it reads as if Starter gets nothing.
export const ALWAYS_INCLUDED = ['WhatsApp bot', 'WhatsApp Status'];

function startOfMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}
