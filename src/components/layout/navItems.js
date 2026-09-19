import { CHANNELS } from '../../lib/features.js';

// The sidebar, as data.
//
// Every item carries its `flag` rather than being filtered out when a tenant
// cannot reach it. That is the whole navigation decision from the mockups:
// Contacts and Disputes render for a Starter seller with a "Growth+" badge,
// Analytics and Team with "Business", and clicking one arrives at a page that
// explains the feature instead of a redirect or a 404. Locked items are the
// upsell surface — hiding them would remove the only place most sellers will
// ever learn the higher tiers exist.
//
// The badge text is not stored here. It comes from FLAG_MIN_TIER via
// badgeFor(), so a flag that moves between tiers moves in one file.

export const MAIN_NAV = [
  { to: '/dashboard', icon: 'overview', label: 'Overview', end: true },
  { to: '/dashboard/listings', icon: 'listings', label: 'Listings' },
  { to: '/dashboard/orders', icon: 'orders', label: 'Orders' },
  { to: '/dashboard/payouts', icon: 'payouts', label: 'Payouts' },
  { to: '/dashboard/contacts', icon: 'contacts', label: 'Contacts', flag: 'contacts' },
  { to: '/dashboard/disputes', icon: 'disputes', label: 'Disputes', flag: 'disputes' },
  { to: '/dashboard/analytics', icon: 'analytics', label: 'Analytics', flag: 'analytics' },
  { to: '/dashboard/team', icon: 'team', label: 'Team', flag: 'team' },
];

// The Channels group. One row per channel, each showing its own connection
// state, all leading to the same screen — the mockups list them individually
// so a seller can see at a glance that Instagram is connected and TikTok is
// not, without opening anything.
export const CHANNEL_NAV = CHANNELS.map((c) => ({
  to: `/dashboard/channels#${c.id}`,
  icon: c.id,
  label: c.label,
  flag: c.flag,
  channel: c.id,
}));

export const FOOTER_NAV = [
  { to: '/dashboard/billing', icon: 'billing', label: 'Billing & Plan' },
  { to: '/dashboard/settings', icon: 'settings', label: 'Settings' },
  { to: '/dashboard/help', icon: 'help', label: 'Help' },
];

// Mobile. Five slots is what a thumb reach allows, so the four that survive
// are the four a seller opens daily and everything else goes behind More.
export const TAB_NAV = [
  { to: '/dashboard', icon: 'overview', label: 'Home', end: true },
  { to: '/dashboard/listings', icon: 'listings', label: 'Listings' },
  { to: '/dashboard/orders', icon: 'orders', label: 'Orders' },
  { to: '/dashboard/payouts', icon: 'payouts', label: 'Payouts' },
  { to: '/dashboard/more', icon: 'more', label: 'More' },
];
