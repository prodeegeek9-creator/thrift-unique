// What each plan tier unlocks, in one place.
//
// This map is the single source of truth for four separate things:
//
//   1. whether a nav item renders locked          (navItems.js)
//   2. which badge it carries — "Growth+" / "Business"  (TierBadge.jsx)
//   3. whether a route shows its page or an upsell (RequireFeature.jsx)
//   4. whether the server will actually do the thing (worker/lib/features.js)
//
// The fourth is the one that matters. The first three are presentation, and a
// seller who edits their own JavaScript can have all three say whatever they
// like. Keep the Worker's copy in step with this file, and never let the UI
// promise a capability the Worker has not been taught to grant.

export const TIERS = ['starter', 'growth', 'business'];

// Ordering, so "does this tier reach that one" is a comparison rather than a
// chain of ifs.
const TIER_RANK = Object.fromEntries(TIERS.map((tier, i) => [tier, i]));

// The lowest tier at which each flag turns on. A flag absent from this map is
// available to everyone, including Starter — that is the default, and it is
// why listings, orders and payouts are not listed here.
export const FLAG_MIN_TIER = {
  // Growth — the core revenue tier: real social reach and buyer protection.
  contacts: 'growth',           // CRM: buyer list, repeat-buyer flags
  disputes: 'growth',           // manual dispute flagging, routed to staff
  escrow: 'growth',             // funds held until the buyer confirms receipt
  whatsapp_checkout: 'growth',  // cart and payment inside the store's WhatsApp chat
  publish_instagram: 'growth',
  publish_facebook: 'growth',

  // Business — the bespoke, high-ticket tier.
  analytics: 'business',        // sales trend + channel attribution
  team: 'business',             // multi-staff access
  publish_tiktok: 'business',   // and gated again behind the platform audit
  catalog_sync: 'business',     // WooCommerce
  ai_match: 'business',         // "is this in stock?" over pgvector
  priority_support: 'business',
};

// What the badge says. Growth carries a "+" because the feature is also in
// Business, and a bare "Growth" next to a Business-tier item read as a
// downgrade in the mockups.
const TIER_LABEL = {
  growth: 'Growth+',
  business: 'Business',
};

export function tierReaches(tier, minTier) {
  return (TIER_RANK[tier] ?? -1) >= (TIER_RANK[minTier] ?? 0);
}

// The tier a flag needs, or null when everybody has it.
export function minTierFor(flag) {
  return FLAG_MIN_TIER[flag] ?? null;
}

export function badgeFor(flag) {
  const min = minTierFor(flag);
  return min ? TIER_LABEL[min] : null;
}

// Whether a tenant has a flag.
//
// Tier is the default, and `overrides` is what the platform console sets per
// tenant — a Business feature switched on for a Growth customer mid-negotiation,
// or a feature switched off after a chargeback. An explicit override wins over
// the tier in both directions, which is the point of storing flags as rows
// rather than deriving them.
export function hasFeature(tenant, flag) {
  if (!tenant) return false;
  const override = tenant.features?.[flag];
  if (override !== undefined) return override;

  const min = minTierFor(flag);
  return min ? tierReaches(tenant.tier, min) : true;
}

// The channels a tenant can publish to, in the order the mockups show them.
export const CHANNELS = [
  { id: 'whatsapp', label: 'WhatsApp', flag: null },
  { id: 'instagram', label: 'Instagram', flag: 'publish_instagram' },
  { id: 'facebook', label: 'Facebook', flag: 'publish_facebook' },
  { id: 'tiktok', label: 'TikTok', flag: 'publish_tiktok' },
];
