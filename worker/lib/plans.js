// What each plan switches on, server side, for moving a store between plans.
//
// The same map as seed_tenant_features() in migration 0001 (which seeds a new
// store and never overwrites) and FLAG_MIN_TIER in src/lib/features.js (which
// decides what the dashboard draws). Keep all three in step.

export const TIERS = ['starter', 'growth', 'business'];

// The monthly plan fee, in naira, and its terms. Quoted by the sign-up bot and
// charged by lib/billing.js; the homepage and Billing page carry the same
// numbers (src/pages/public/Home.jsx, src/lib/billing.js).
export const PLAN_PRICES = { starter: 10000, growth: 25000, business: 75000 };
export const TRIAL_DAYS = 14;
export const GRACE_DAYS = 7;

export const FLAG_MIN_TIER = {
  contacts: 'growth',
  disputes: 'growth',
  escrow: 'growth',
  publish_instagram: 'growth',
  publish_facebook: 'growth',
  analytics: 'business',
  team: 'business',
  publish_tiktok: 'business',
  catalog_sync: 'business',
  ai_match: 'business',
  priority_support: 'business',
};

// Whether a plan includes a flag.
export function planIncludes(tier, flag) {
  const min = FLAG_MIN_TIER[flag];
  if (!min) return false;
  return TIERS.indexOf(tier) >= TIERS.indexOf(min);
}
