-- Where a listing's photos live.
--
-- Until now products.images has been an empty array on every row, because
-- nothing wrote to it. The bot is the first thing that does: a seller sends a
-- photo on WhatsApp, the Worker fetches it from WAHA once and puts it here,
-- and the WAHA copy can then disappear without breaking the listing.

-- Public read, and deliberately so.
--
-- Three things have to load one of these images without a session: a link
-- preview scraper following /p/<code>, a buyer opening that page, and WAHA
-- itself fetching the file by URL to post it to the seller's Status. Signed
-- URLs would break all three, and there is nothing private here — these are
-- photographs of items their owner is actively trying to show strangers.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-images',
  'product-images',
  true,
  8388608, -- 8 MiB, matching MAX_BYTES in worker/lib/media.js
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do nothing;

-- No storage policies at all, which means no client role can write.
--
-- The Worker uploads under the service key, which bypasses this entirely. That
-- is the whole write path today, and leaving the bucket closed means a stolen
-- anon key cannot be used to fill somebody's storage quota with junk. When the
-- dashboard grows a manual upload form, it gets an insert policy scoped to
-- `(storage.foldername(name))[1] = tenant_id::text` -- which is why the path
-- convention in worker/lib/media.js puts the tenant id first.
