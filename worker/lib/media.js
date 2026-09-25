// Moving a photo from WhatsApp into storage we control.
//
// WAHA serves inbound media from its own disk, behind its own API key, for as
// long as it keeps the file. That is fine for a bot reading a message and
// useless for a listing that has to render in a browser and in a link preview
// months later, so every image a seller sends is fetched once and re-uploaded
// to Supabase Storage. After that the WAHA copy can disappear and nothing
// breaks.

export const BUCKET = 'product-images';

// Generous for a phone photo, small enough that a malformed or hostile
// content-length cannot be used to make the Worker chew through memory.
const MAX_BYTES = 8 * 1024 * 1024;

const EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export class MediaError extends Error {}

// The path stored in products.images — not a URL.
//
// The schema is explicit about this: a column full of absolute URLs is a
// migration nobody wants to write the day the bucket moves. Rendering goes
// through publicUrl() on the Worker and src/lib/images.js in the bundle.
export function storagePath(tenantId, mimetype) {
  const ext = EXTENSIONS[String(mimetype ?? '').toLowerCase()] ?? 'jpg';
  return `${tenantId}/${crypto.randomUUID()}.${ext}`;
}

export function publicUrl(cfg, path) {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;

  // An asset shipped with the app rather than an object in the bucket — the
  // demo catalogue's pictures. Absolute here rather than root-relative,
  // because both callers hand this to somebody else's fetcher: a link-preview
  // scraper and WAHA, neither of which has an origin to resolve against.
  if (path.startsWith('/')) {
    return cfg.publicOrigin ? `${cfg.publicOrigin}${path}` : null;
  }

  return `${cfg.supabaseUrl}/storage/v1/object/public/${BUCKET}/${path}`;
}

// Where to fetch a WAHA media URL from, and with what.
//
// WAHA writes these URLs from its own WAHA_BASE_URL, which defaults to
// http://localhost:3000 — easy to leave unset, and unreachable from here. And
// the request carries the WAHA API key, which must never go to any host but
// WAHA's. So a WAHA file path is always fetched from WAHA_URL, whatever host
// the payload named; anything else (media WAHA keeps in S3, say) is fetched
// as given, without the key.
export function mediaRequest(cfg, url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new MediaError('Bad media URL');
  }

  if (cfg.wahaUrl && parsed.pathname.startsWith('/api/files/')) {
    return {
      url: `${cfg.wahaUrl}${parsed.pathname}${parsed.search}`,
      headers: cfg.wahaKey ? { 'X-Api-Key': cfg.wahaKey } : {},
    };
  }
  return { url: parsed.href, headers: {} };
}

// Fetch from WAHA, upload to Supabase, return the storage path.
export async function storeImage(cfg, tenantId, { url, mimetype }) {
  if (!url) throw new MediaError('No media URL');

  const source = mediaRequest(cfg, url);
  const res = await fetch(source.url, { headers: source.headers });
  if (!res.ok) throw new MediaError(`Could not fetch media: ${res.status}`);

  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) throw new MediaError(`Image too large: ${declared} bytes`);

  const bytes = new Uint8Array(await res.arrayBuffer());
  // Checked again after reading: content-length is a claim, not a fact.
  if (bytes.byteLength > MAX_BYTES) throw new MediaError(`Image too large: ${bytes.byteLength} bytes`);
  if (!bytes.byteLength) throw new MediaError('Empty image');

  const type = res.headers.get('content-type')?.split(';')[0] || mimetype || 'image/jpeg';
  if (!type.startsWith('image/')) throw new MediaError(`Not an image: ${type}`);

  return upload(cfg, storagePath(tenantId, type), bytes, type);
}

async function upload(cfg, path, bytes, contentType) {
  const res = await fetch(`${cfg.supabaseUrl}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: cfg.serviceKey,
      Authorization: `Bearer ${cfg.serviceKey}`,
      'Content-Type': contentType,
      // The path carries a UUID, so a collision means something is badly
      // wrong and overwriting would hide it.
      'x-upsert': 'false',
    },
    body: bytes,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new MediaError(`Storage ${res.status}: ${body.slice(0, 200)}`);
  }

  return path;
}
