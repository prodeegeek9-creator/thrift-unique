// Turning a stored image path into something an <img> can load.
//
// products.images holds storage object paths, not URLs — the schema is
// explicit about it, because a column full of absolute URLs is a migration
// nobody wants to write the day the bucket moves. That means every place that
// renders a product photo has to resolve the path, and this is the one place
// that knows how.

const BUCKET = 'product-images';
const BASE = import.meta.env.VITE_SUPABASE_URL?.replace(/\/+$/, '') ?? '';

export function imageUrl(path) {
  if (!path) return null;

  // Rows written before the bucket existed, and anything pasted in by hand,
  // may already be absolute. Leave those alone.
  if (/^(https?:|data:|blob:)/i.test(path)) return path;

  // A leading slash means an asset shipped with the app rather than an object
  // in the bucket — public/samples/*.jpg, which is how the demo catalogue has
  // pictures without anything having been uploaded. The two are told apart by
  // the slash because a storage object path never starts with one: it starts
  // with the tenant id (see storagePath() in worker/lib/media.js).
  if (path.startsWith('/')) return path;

  if (!BASE) return null;
  return `${BASE}/storage/v1/object/public/${BUCKET}/${path}`;
}

// The first photo, resolved, or null. Almost every caller wants exactly this —
// a thumbnail in a list, the hero on a product page, the image in a link
// preview.
export function firstImage(product) {
  return imageUrl(product?.images?.[0]);
}
