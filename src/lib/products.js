import { supabase } from './supabase.js';

// Listings.
//
// Every query here filters on tenant_id explicitly, and that is not
// belt-and-braces — it is required for correctness. RLS returns the rows for
// *every* tenant the signed-in person belongs to, so a seller running two
// stores would see both catalogues merged into one grid without it. The policy
// decides what they are allowed to see; this decides which store they are
// looking at.

// The grid. No description — the cards do not show one, and descriptions are
// the longest column on the table.
const LIST_COLUMNS =
  'id, public_code, title, price, condition, images, status, ' +
  'quantity_available, sold_at, created_at';

// The editor needs the negotiation settings and the body copy as well.
const DETAIL_COLUMNS =
  LIST_COLUMNS + ', description, category, allow_negotiation, min_discount_pct, updated_at';

// The filter chips are All / Active / Sold, so 'draft' and 'archived' are
// reachable only by asking for them by name. A draft is a listing the bot
// started and the seller never finished; showing those in the default view
// would make the count disagree with what they think they have for sale.
const FILTERS = {
  all: ['draft', 'active', 'sold'],
  active: ['active'],
  sold: ['sold'],
  draft: ['draft'],
  archived: ['archived'],
};

export async function fetchListings(tenantId, { filter = 'all', search = '' } = {}) {
  if (!tenantId) return [];

  let q = supabase
    .from('products')
    .select(LIST_COLUMNS)
    .eq('tenant_id', tenantId)
    .in('status', FILTERS[filter] ?? FILTERS.all)
    .order('created_at', { ascending: false });

  // Title only. A seller searching their own stock is looking for "denim", not
  // for a word buried in a paragraph they wrote three months ago — and an
  // ilike across description would need an index this table does not have.
  if (search.trim()) q = q.ilike('title', `%${search.trim()}%`);

  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

// The numbers on the filter chips: All (25), Active (18), Sold (7).
//
// head: true with count means Postgres returns the count and no rows at all,
// which is three cheap queries instead of pulling the whole catalogue to
// length-check it in the browser.
export async function fetchListingCounts(tenantId) {
  if (!tenantId) return { all: 0, active: 0, sold: 0 };

  const counts = await Promise.all(
    ['all', 'active', 'sold'].map(async (key) => {
      const { count, error } = await supabase
        .from('products')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .in('status', FILTERS[key]);
      if (error) throw error;
      return [key, count ?? 0];
    })
  );

  return Object.fromEntries(counts);
}

export async function fetchListing(tenantId, id) {
  if (!tenantId || !id) return null;

  // maybeSingle, not single: a bookmarked or hand-edited id is a page to
  // render, not an error to throw.
  const { data, error } = await supabase
    .from('products')
    .select(DETAIL_COLUMNS)
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

// Where each listing has been published, as { [productId]: { channel: row } }.
//
// One query for the whole page rather than one per card. The Listings grid
// shows four channel icons on every tile, and a request per tile is twenty-five
// requests on a page of twenty-five items.
export async function fetchChannelPosts(tenantId, productIds) {
  if (!tenantId || !productIds?.length) return {};

  const { data, error } = await supabase
    .from('listing_channel_posts')
    .select('product_id, channel, status, external_url, posted_at, error')
    .eq('tenant_id', tenantId)
    .in('product_id', productIds);

  if (error) throw error;

  const byProduct = {};
  for (const row of data ?? []) {
    (byProduct[row.product_id] ||= {})[row.channel] = row;
  }
  return byProduct;
}

// Manual listing creation — the "Or add manually" path, which is the fallback
// behind "Open WhatsApp" rather than the main route in.
//
// public_code is absent on purpose: the database generates it (see migration
// 0007), so the bot, this form and any future import cannot disagree about the
// alphabet or race each other for the same code.
export async function createListing(tenantId, fields) {
  const { data, error } = await supabase
    .from('products')
    .insert({
      tenant_id: tenantId,
      title: fields.title,
      description: fields.description || null,
      category: fields.category || null,
      condition: fields.condition ?? 'good',
      price: fields.price,
      images: fields.images ?? [],
      quantity_available: fields.quantity ?? 1,
      allow_negotiation: Boolean(fields.allowNegotiation),
      min_discount_pct: fields.allowNegotiation ? fields.minDiscountPct ?? null : null,
      // A manual listing goes live immediately. There is no approval queue:
      // the seller pays for the account and the catalogue is theirs.
      status: fields.status ?? 'active',
    })
    .select(DETAIL_COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

export async function updateListing(tenantId, id, patch) {
  const { data, error } = await supabase
    .from('products')
    .update(patch)
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .select(DETAIL_COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

// Marking an item sold by hand, for a sale that happened outside the platform.
// sold_at is stamped here rather than by a trigger because a seller correcting
// a mistake should not have the timestamp silently rewritten under them.
export async function markSold(tenantId, id) {
  return updateListing(tenantId, id, {
    status: 'sold',
    sold_at: new Date().toISOString(),
    quantity_available: 0,
  });
}

// Archive rather than delete. An order references its product with
// ON DELETE RESTRICT, so a sold item cannot be removed anyway — and an order
// history that cannot say what was bought is not a history.
export async function archiveListing(tenantId, id) {
  return updateListing(tenantId, id, { status: 'archived' });
}

// The one read that happens without a session, behind /p/:code.
//
// It takes no tenantId, which is the only function here that does not — a
// stranger following a shared link has no tenant and no account. The database
// function it calls is SECURITY DEFINER and looks up exactly one row by its
// code, because a plain anon SELECT on products would let anybody walk every
// tenant's catalogue.
export async function fetchPublicProduct(code) {
  if (!code) return null;

  const { data, error } = await supabase.rpc('public_product', { code });
  if (error) throw error;

  // The function returns a set, so an unknown or sold-out code comes back as
  // an empty array rather than an error. That is a page to render, not a throw.
  return data?.[0] ?? null;
}
