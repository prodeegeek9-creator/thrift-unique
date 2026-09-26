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

// Commission per plan, from the pricing table: the top of each range, since
// the operator can lower a rate but raising one after acceptance would be
// charging for something nobody agreed to. Business is negotiable, so it
// starts at Growth's rate until the operator agrees another.
export const COMMISSION = { starter: 8, growth: 7, business: 7 };
export const GRACE_DAYS = 7;

export const FLAG_MIN_TIER = {
  contacts: 'growth',
  disputes: 'growth',
  escrow: 'growth',
  whatsapp_checkout: 'growth',
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

export const tierRank = (tier) => TIERS.indexOf(tier);

// What the store gets on each plan, in the words the Billing page, the nudges
// and WhatsApp use. Only what works today: Instagram, Facebook and TikTok
// posting wait on Meta's and TikTok's reviews, so they are "coming soon".
export const PLAN_PITCH = {
  starter: ['WhatsApp listing bot', 'WhatsApp Status posting', 'Your own store page', 'Checkout and payment links'],
  growth: ['Buyer protection (payment held until the buyer confirms)', 'Checkout inside WhatsApp: a cart and one payment link', 'Your buyer list', 'Dispute handling', `${COMMISSION.growth}% commission instead of ${COMMISSION.starter}%`],
  business: ['Sales analytics', 'Staff accounts', 'Priority support'],
};
export const COMING_SOON = { growth: 'Instagram and Facebook posting', business: 'TikTok posting and WooCommerce sync' };
