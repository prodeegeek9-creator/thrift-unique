import { supabase } from './supabase.js';

// A photo from the product form, into the same bucket and folder layout the
// WhatsApp bot uses: <tenant id>/<random>.jpg. The storage policy in migration
// 0019 only accepts a path under a store the signed-in person belongs to.

const BUCKET = 'product-images';

// Phone cameras produce 4000px, 5 MB photos. A listing never shows one wider
// than a phone screen, so it is shrunk before it leaves the phone: faster on a
// Nigerian mobile connection, and well under the bucket's 8 MB limit.
const MAX_EDGE = 1600;

export async function uploadListingPhoto(tenantId, file) {
  if (!tenantId) throw new Error('No store');
  if (!file?.type?.startsWith('image/')) throw new Error('That is not a photo.');

  const blob = await shrink(file);
  const path = `${tenantId}/${crypto.randomUUID()}.jpg`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, { contentType: 'image/jpeg', upsert: false });
  if (error) throw error;

  return path;
}

async function shrink(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // A format this browser cannot decode (HEIC on some Androids): send it as
    // it is and let the bucket's type check decide.
    return file;
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  // A transparent PNG would turn black as a JPEG.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read that photo.'))), 'image/jpeg', 0.85)
  );
}
