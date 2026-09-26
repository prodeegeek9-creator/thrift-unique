// Every TanStack Query key in the app, in one place.
//
// Keys are tenant-scoped from the first segment down, which matters more here
// than in a single-tenant app: switching stores in the sidebar must not show
// the previous store's listings for a frame while the new ones load. Because
// the tenant id is inside the key, the cache simply has no entry to show.
//
// Written as functions rather than arrays so a typo is a runtime error at the
// call site instead of a silently separate cache entry.
export const keys = {
  tenant: (t) => ['tenant', t],

  listings: (t, filter = 'all') => ['tenant', t, 'listings', filter],
  listing: (t, id) => ['tenant', t, 'listing', id],
  listingCounts: (t) => ['tenant', t, 'listings', 'counts'],
  channelPosts: (t, ids) => ['tenant', t, 'channel-posts', ids],

  submissions: (t, status = 'pending') => ['tenant', t, 'submissions', status],
  submissionCounts: (t) => ['tenant', t, 'submissions', 'counts'],

  orders: (t, filter = 'all') => ['tenant', t, 'orders', filter],
  order: (t, id) => ['tenant', t, 'order', id],

  payouts: (t) => ['tenant', t, 'payouts'],
  balance: (t) => ['tenant', t, 'balance'],
  payoutAccount: (t) => ['tenant', t, 'payout-account'],
  banks: (t) => ['tenant', t, 'banks'],

  contacts: (t, search = '') => ['tenant', t, 'contacts', search],
  disputes: (t) => ['tenant', t, 'disputes'],

  analytics: (t, from, to) => ['tenant', t, 'analytics', from, to],
  usage: (t) => ['tenant', t, 'usage'],

  staff: (t) => ['tenant', t, 'staff'],
  channels: (t) => ['tenant', t, 'channels'],
  overview: (t) => ['tenant', t, 'overview'],
};

// Everything under one store. Used after a mutation that could plausibly touch
// more than the thing it changed — marking an item sold moves a listing, the
// overview counts and the analytics totals at once.
export const tenantScope = (t) => ({ queryKey: ['tenant', t] });
