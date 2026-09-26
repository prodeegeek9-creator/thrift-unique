import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Icon from './ui/Icon.jsx';
import { useToast } from '../lib/ToastContext.jsx';
import {
  archiveListing,
  createListing,
  fetchListing,
  markSold,
  postListingToStatus,
  updateListing,
} from '../lib/products.js';
import { useTenant } from '../lib/TenantContext.jsx';
import { uploadListingPhoto } from '../lib/uploads.js';
import { imageUrl } from '../lib/images.js';
import { formatNaira, parseNaira } from '../lib/money.js';
import { keys, tenantScope } from '../lib/queryKeys.js';
import { createPaymentLink } from '../lib/checkout.js';

// Adding or editing a listing from the dashboard.
//
// WhatsApp stays the quick way in; this is for somebody at a desk, with the
// photos already on their laptop, or fixing a typo in a price. Same fields as
// the bot collects, plus a description, which is easier to type here.

export const MAX_PHOTOS = 4;

const CONDITIONS = [
  { value: 'brand_new', label: 'Brand new' },
  { value: 'excellent', label: 'Excellent' },
  { value: 'good', label: 'Good' },
  { value: 'fair', label: 'Fair' },
];

const EMPTY = {
  title: '',
  price: '',
  condition: 'good',
  description: '',
  allowNegotiation: false,
  images: [],
};

// listingId null → a new listing.
export default function ListingEditor({ tenantId, listingId = null, onClose }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { tenant } = useTenant();
  const fileInput = useRef(null);
  // Status posting needs a live store and its own WhatsApp linked.
  const canPost = tenant?.status === 'active' && tenant?.waha_status === 'WORKING';
  const [alsoPost, setAlsoPost] = useState(canPost);
  const [form, setForm] = useState(EMPTY);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState(null);

  const { data: existing, isLoading } = useQuery({
    queryKey: keys.listing(tenantId, listingId),
    queryFn: () => fetchListing(tenantId, listingId),
    enabled: Boolean(tenantId && listingId),
  });

  useEffect(() => {
    if (!existing) return;
    setForm({
      title: existing.title ?? '',
      price: String(Number(existing.price)),
      condition: existing.condition ?? 'good',
      description: existing.description ?? '',
      allowNegotiation: Boolean(existing.allow_negotiation),
      images: existing.images ?? [],
    });
  }, [existing]);

  // Escape closes, as everywhere else a sheet like this appears.
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const done = (message) => {
    qc.invalidateQueries(tenantScope(tenantId));
    toast(message, 'success');
    onClose();
  };
  const failed = (err) => setError(err?.message ?? 'Something went wrong. Try again.');

  const save = useMutation({
    mutationFn: async () => {
      const price = parseNaira(form.price);
      const fields = {
        title: form.title.trim().replace(/\s+/g, ' ').slice(0, 120),
        price,
        condition: form.condition,
        description: form.description.trim() || null,
        images: form.images,
      };
      if (listingId) {
        await updateListing(tenantId, listingId, {
          ...fields,
          allow_negotiation: form.allowNegotiation,
        });
        return 'Listing updated';
      }

      const created = await createListing(tenantId, { ...fields, allowNegotiation: form.allowNegotiation });
      if (!(alsoPost && canPost)) return 'Listing added';
      // The listing exists either way; a Status post that fails is reported,
      // not treated as the save failing.
      try {
        await postListingToStatus(tenantId, created.id);
        return 'Listing added and posted to your Status';
      } catch (err) {
        return `Listing added. Status post didn't go out: ${err.message}`;
      }
    },
    onSuccess: (message) => done(message),
    onError: failed,
  });

  const post = useMutation({
    mutationFn: () => postListingToStatus(tenantId, listingId),
    onSuccess: () => {
      qc.invalidateQueries(tenantScope(tenantId));
      toast('Posted to your WhatsApp Status', 'success');
    },
    onError: failed,
  });

  const sold = useMutation({
    mutationFn: () => markSold(tenantId, listingId),
    onSuccess: () => done('Marked as sold'),
    onError: failed,
  });

  const remove = useMutation({
    mutationFn: () => archiveListing(tenantId, listingId),
    onSuccess: () => done('Listing removed'),
    onError: failed,
  });

  async function addPhotos(files) {
    const room = MAX_PHOTOS - form.images.length;
    const picked = Array.from(files ?? []).slice(0, room);
    if (!picked.length) return;
    setError(null);
    setUploading((n) => n + picked.length);

    for (const file of picked) {
      try {
        const path = await uploadListingPhoto(tenantId, file);
        setForm((f) => ({ ...f, images: [...f.images, path].slice(0, MAX_PHOTOS) }));
      } catch (err) {
        setError(err?.message ?? 'That photo could not be uploaded.');
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  function submit(e) {
    e.preventDefault();
    setError(null);
    if (!form.title.trim()) return setError('Give the item a name.');
    if (parseNaira(form.price) == null) return setError('Enter a price, e.g. 35000 or 35k.');
    if (!form.images.length) return setError('Add at least one photo.');
    if (uploading) return setError('Wait for the photos to finish uploading.');
    save.mutate();
  }

  const busy = save.isPending || sold.isPending || remove.isPending || post.isPending;
  const price = parseNaira(form.price);
  const live = existing?.status === 'active';

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 sm:items-center sm:p-4">
      <form
        onSubmit={submit}
        className="card max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-b-none p-5 sm:rounded-b-card"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-base font-semibold text-ink">
              {listingId ? 'Edit listing' : 'Add a product'}
            </h2>
            {listingId && existing?.public_code ? (
              <p className="mt-0.5 text-xs text-muted">Code {existing.public_code}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-ink"
          >
            <span className="sr-only">Close</span>
            <span aria-hidden="true" className="text-lg leading-none">×</span>
          </button>
        </div>

        {listingId && isLoading ? (
          <div className="mt-4 h-64 animate-pulse rounded-card bg-surface-2" />
        ) : (
          <>
            <div className="mt-4">
              <span className="mb-1 block text-xs font-medium text-muted">
                Photos ({form.images.length}/{MAX_PHOTOS})
              </span>
              <div className="grid grid-cols-4 gap-2">
                {form.images.map((path, i) => (
                  <div key={path} className="relative">
                    <img
                      src={imageUrl(path)}
                      alt=""
                      className="aspect-square w-full rounded-lg bg-surface-2 object-cover"
                    />
                    {i === 0 ? (
                      <span className="absolute bottom-1 left-1 rounded bg-ink/70 px-1 text-[10px] text-white">
                        Cover
                      </span>
                    ) : null}
                    <button
                      type="button"
                      onClick={() =>
                        setForm((f) => ({ ...f, images: f.images.filter((p) => p !== path) }))
                      }
                      className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-ink/70 text-xs text-white"
                    >
                      <span className="sr-only">Remove photo</span>×
                    </button>
                  </div>
                ))}
                {Array.from({ length: uploading }).map((_, i) => (
                  <div key={`up-${i}`} className="aspect-square animate-pulse rounded-lg bg-surface-2" />
                ))}
                {form.images.length + uploading < MAX_PHOTOS ? (
                  <button
                    type="button"
                    onClick={() => fileInput.current?.click()}
                    className="grid aspect-square place-items-center rounded-lg border border-dashed border-line text-muted hover:border-green/40 hover:text-ink"
                  >
                    <span className="flex flex-col items-center gap-1 text-[11px]">
                      <Icon name="plus" className="h-5 w-5" />
                      Add
                    </span>
                  </button>
                ) : null}
              </div>
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  addPhotos(e.target.files);
                  e.target.value = '';
                }}
              />
            </div>

            <Field label="Item name">
              <input
                type="text"
                value={form.title}
                maxLength={120}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="Brown leather jacket"
                className={INPUT}
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Price" hint={price != null ? formatNaira(price) : 'e.g. 35000 or 35k'}>
                <input
                  inputMode="decimal"
                  value={form.price}
                  onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                  placeholder="35000"
                  className={INPUT}
                />
              </Field>
              <Field label="Condition">
                <select
                  value={form.condition}
                  onChange={(e) => setForm((f) => ({ ...f, condition: e.target.value }))}
                  className={INPUT}
                >
                  {CONDITIONS.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <Field label="Description (optional)">
              <textarea
                rows={3}
                value={form.description}
                maxLength={2000}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Size, colour, measurements, any flaws…"
                className={INPUT}
              />
            </Field>

            <label className="mt-3 flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={form.allowNegotiation}
                onChange={(e) => setForm((f) => ({ ...f, allowNegotiation: e.target.checked }))}
                className="h-4 w-4 accent-green"
              />
              Buyers can make an offer
            </label>

            {!listingId ? (
              <label className={`mt-2 flex items-center gap-2 text-sm ${canPost ? 'text-ink' : 'text-muted'}`}>
                <input
                  type="checkbox"
                  checked={alsoPost && canPost}
                  disabled={!canPost}
                  onChange={(e) => setAlsoPost(e.target.checked)}
                  className="h-4 w-4 accent-green"
                />
                Also post to my WhatsApp Status
                {!canPost ? <span className="text-[11px]">(link WhatsApp in Channels first)</span> : null}
              </label>
            ) : null}

            {error ? <p className="mt-3 text-sm text-red">{error}</p> : null}

            <button
              type="submit"
              disabled={busy || uploading > 0}
              className="mt-5 w-full rounded-pill bg-green py-2.5 text-sm font-semibold text-white disabled:opacity-60"
            >
              {save.isPending ? 'Saving…' : listingId ? 'Save changes' : 'Add product'}
            </button>

            {listingId && live ? (
              <button
                type="button"
                disabled={busy || !canPost}
                title={canPost ? undefined : 'Link your WhatsApp in Channels first'}
                onClick={() => post.mutate()}
                className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-pill border border-green py-2 text-sm font-semibold text-green hover:bg-green-lt disabled:opacity-50"
              >
                <Icon name="whatsapp" className="h-4 w-4" />
                {post.isPending ? 'Posting…' : 'Post to my WhatsApp Status'}
              </button>
            ) : null}

            {listingId && live && tenant?.status === 'active' ? (
              <PaymentLink tenantId={tenantId} listingId={listingId} listedPrice={existing?.price} />
            ) : null}

            {listingId && existing?.status !== 'archived' ? (
              <div className="mt-3 flex gap-2">
                {live ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => sold.mutate()}
                    className="flex-1 rounded-pill border border-line py-2 text-sm font-medium text-ink hover:bg-surface-2 disabled:opacity-60"
                  >
                    Mark as sold
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm('Remove this listing? It stops showing on your store page.')) {
                      remove.mutate();
                    }
                  }}
                  className="flex-1 rounded-pill border border-line py-2 text-sm font-medium text-red hover:bg-surface-2 disabled:opacity-60"
                >
                  Remove
                </button>
              </div>
            ) : null}
          </>
        )}
      </form>
    </div>
  );
}

// A link to send a buyer in chat, at a price agreed there. The item comes off
// sale when it is paid; the link lasts three days.
function PaymentLink({ tenantId, listingId, listedPrice }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState(listedPrice != null ? String(Number(listedPrice)) : '');
  const [made, setMade] = useState(null);

  const create = useMutation({
    mutationFn: () => createPaymentLink(tenantId, listingId, price),
    onSuccess: (result) => setMade(result),
    onError: (e) => toast(e.message, 'error'),
  });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 w-full rounded-pill border border-line py-2 text-sm font-semibold text-ink hover:bg-surface-2"
      >
        💳 Payment link for a buyer
      </button>
    );
  }

  const share = made
    ? `https://wa.me/?text=${encodeURIComponent(`Here's the payment link (${formatNaira(made.price)}): ${made.url}`)}`
    : null;

  return (
    <div className="mt-3 rounded-lg border border-line p-3">
      <p className="text-xs font-medium text-muted">Payment link for a buyer</p>
      {made ? (
        <>
          <p className="mt-2 break-all rounded bg-surface-2 px-2 py-1.5 text-xs text-ink">{made.url}</p>
          <p className="mt-1 text-[11px] text-muted">
            {formatNaira(made.price)} · works for 3 days · the item comes off sale once it's paid
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() =>
                navigator.clipboard
                  ?.writeText(made.url)
                  .then(() => toast('Link copied', 'success'))
                  .catch(() => toast('Could not copy that link', 'error'))
              }
              className="flex-1 rounded-pill bg-green py-2 text-xs font-semibold text-white"
            >
              Copy link
            </button>
            <a
              href={share}
              target="_blank"
              rel="noreferrer"
              className="flex-1 rounded-pill border border-line py-2 text-center text-xs font-semibold text-ink"
            >
              Send on WhatsApp
            </a>
          </div>
        </>
      ) : (
        <div className="mt-2 flex gap-2">
          <input
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            aria-label="Agreed price"
            className={`${INPUT} flex-1`}
          />
          <button
            type="button"
            disabled={create.isPending}
            onClick={() => create.mutate()}
            className="rounded-pill bg-green px-4 text-xs font-semibold text-white disabled:opacity-50"
          >
            {create.isPending ? 'Making…' : 'Make link'}
          </button>
        </div>
      )}
    </div>
  );
}

const INPUT =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-green/40';

function Field({ label, hint, children }) {
  return (
    <label className="mt-3 block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-muted">{hint}</span> : null}
    </label>
  );
}
