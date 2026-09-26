import { useEffect, useState } from 'react';
import Icon from './ui/Icon.jsx';
import { useToast } from '../lib/ToastContext.jsx';
import { imageUrl } from '../lib/images.js';
import { productUrl } from '../lib/tenants.js';
import {
  shareCaption,
  photoFiles,
  canShareFiles,
  copyText,
  shareToApps,
  savePhotos,
  facebookShareUrl,
} from '../lib/shareKit.js';

// One item, ready to post on Instagram, TikTok or Facebook: its photos and a
// caption with the price and the link. On a phone, "Share photos" opens the
// phone's own share menu with the photos in it and the caption already copied.
// On a computer, the photos download and the caption copies.

export default function ShareSheet({ item, onClose }) {
  const toast = useToast();
  const caption = shareCaption(item);
  const [files, setFiles] = useState(null);

  useEffect(() => {
    let live = true;
    photoFiles(item).then((f) => live && setFiles(f));
    return () => {
      live = false;
    };
  }, [item]);

  const shareable = canShareFiles(files);
  const photos = (item.images ?? []).slice(0, 4).map(imageUrl).filter(Boolean);

  async function share() {
    try {
      await shareToApps(item, files);
      toast('Caption copied: paste it in when you post.', 'success');
    } catch (e) {
      // Closing the share menu without picking an app is not an error.
      if (e?.name !== 'AbortError') toast("Couldn't open the share menu. Save the photos instead.", 'error');
    }
  }

  async function copy(text, done) {
    toast((await copyText(text)) ? done : "Couldn't copy. Press and hold the text to copy it.", 'success');
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-label={`Share ${item.title}`}
        onClick={(e) => e.stopPropagation()}
        className="card max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-b-none p-5 sm:rounded-b-card"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-base font-semibold text-ink">Share on Instagram, TikTok or Facebook</h2>
            <p className="mt-0.5 text-xs text-muted">Post the photos, then paste the caption. The link takes buyers straight to the item.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-ink"
          >
            <span className="sr-only">Close</span>
            <span aria-hidden="true" className="text-lg leading-none">×</span>
          </button>
        </div>

        {photos.length ? (
          <div className="mt-4 flex gap-2 overflow-x-auto">
            {photos.map((src) => (
              <img key={src} src={src} alt="" className="h-24 w-24 shrink-0 rounded-lg bg-surface-2 object-cover" />
            ))}
          </div>
        ) : null}

        <div className="mt-4">
          <div className="flex items-baseline justify-between">
            <p className="text-xs font-semibold text-ink">Caption</p>
            <button type="button" onClick={() => copy(caption, 'Caption copied')} className="text-xs font-semibold text-green">
              Copy
            </button>
          </div>
          <pre className="mt-1.5 whitespace-pre-wrap rounded-lg bg-surface-2 p-3 font-sans text-[13px] leading-relaxed text-text">
            {caption}
          </pre>
        </div>

        <div className="mt-4 space-y-2">
          {shareable ? (
            <button
              type="button"
              onClick={share}
              className="flex w-full items-center justify-center gap-2 rounded-pill bg-green py-2.5 text-sm font-semibold text-white"
            >
              <Icon name="instagram" className="h-4 w-4" />
              Share photos to an app
            </button>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={!files?.length}
              onClick={() => savePhotos(files)}
              className={`rounded-pill py-2.5 text-sm font-semibold disabled:opacity-60 ${
                shareable ? 'border border-line text-ink hover:bg-surface-2' : 'bg-green text-white'
              }`}
            >
              {files == null ? 'Getting photos…' : `Save photo${files.length === 1 ? '' : 's'}`}
            </button>
            <a
              href={facebookShareUrl(item)}
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-center gap-1.5 rounded-pill border border-line py-2.5 text-sm font-semibold text-ink hover:bg-surface-2"
            >
              <Icon name="facebook" className="h-4 w-4" />
              Post to Facebook
            </a>
          </div>
          <button
            type="button"
            onClick={() => copy(productUrl(item.public_code), 'Link copied')}
            className="w-full rounded-pill py-2 text-xs font-semibold text-muted hover:text-ink"
          >
            Copy the item's link
          </button>
        </div>

        <ul className="mt-3 space-y-1 rounded-lg bg-surface-2 p-3 text-[11px] leading-relaxed text-muted">
          <li>
            <span className="font-semibold text-ink">Instagram:</span> a post or Story with the photos. Put the link in your
            bio, or add a link sticker on a Story.
          </li>
          <li>
            <span className="font-semibold text-ink">TikTok:</span> choose Photo, pick the photos and paste the caption.
          </li>
          <li>
            <span className="font-semibold text-ink">Facebook:</span> "Post to Facebook" shares the item with its photo and price.
          </li>
          <li>
            On WhatsApp, reply <span className="font-semibold text-ink">SHARE {item.public_code}</span> to get this kit on your
            phone.
          </li>
        </ul>
      </div>
    </div>
  );
}
