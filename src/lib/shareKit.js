import { formatNaira } from './money.js';
import { imageUrl } from './images.js';
import { productUrl } from './tenants.js';

// The share kit: an item's photos and a caption, for the seller to post on
// Instagram, TikTok or Facebook themselves. None of the three can be posted to
// from here until each approves Vendwyze, so until then the seller taps Post
// and this hands them everything else.
//
// Keep the caption in step with shareCaption() in worker/lib/bot.js, which
// sends the same kit on WhatsApp (SHARE).

const CONDITION = { brand_new: 'Brand new', excellent: 'Excellent', good: 'Good', fair: 'Fair' };

export function shareCaption(item) {
  return [
    item.title,
    `${formatNaira(item.price)} · ${CONDITION[item.condition] ?? item.condition}`,
    item.description ? `\n${String(item.description).trim()}\n` : null,
    `Order here 👉 ${productUrl(item.public_code)}`,
  ]
    .filter((l) => l != null)
    .join('\n');
}

// The photos as files, which is what the phone's share menu takes. Storage
// serves them with open CORS, so the browser can read them.
export async function photoFiles(item, max = 4) {
  const files = [];
  for (const [i, path] of (item.images ?? []).slice(0, max).entries()) {
    const url = imageUrl(path);
    if (!url) continue;
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const blob = await res.blob();
      const ext = (blob.type.split('/')[1] ?? 'jpg').replace('jpeg', 'jpg');
      files.push(new File([blob], `${item.public_code}-${i + 1}.${ext}`, { type: blob.type || 'image/jpeg' }));
    } catch {
      // One photo that won't load shouldn't cost the others.
    }
  }
  return files;
}

// Whether this browser can hand photos to other apps: phones, mostly.
export function canShareFiles(files) {
  try {
    return Boolean(files?.length && navigator.canShare?.({ files }));
  } catch {
    return false;
  }
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// Opens the phone's share menu with the photos. Instagram and TikTok drop any
// text that comes along, so the caption is copied first, ready to paste.
export async function shareToApps(item, files) {
  const caption = shareCaption(item);
  await copyText(caption);
  await navigator.share({ files, text: caption, title: item.title });
}

export function savePhotos(files) {
  for (const file of files) {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

// Facebook can take a link from anyone, no approval needed: the post shows
// the item's photo, name and price from the page's preview.
export function facebookShareUrl(item) {
  return `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(productUrl(item.public_code))}`;
}
