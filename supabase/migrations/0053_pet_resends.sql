-- Pet listings to send to the store's site again after they failed for a
-- reason that was not the seller's: the photos are already in the product-images
-- bucket and the details are what the seller confirmed with YES.
--
-- A row is one listing. The Worker's minute sweep (routes/petResends.js) sends
-- it through the same path as a listing sent live (forwardPetListing): to the
-- site for approval, noted in pet_listings so the seller is told when it goes
-- live, and the seller and the store owner told now. Once: a row is claimed
-- before anything is sent, one that fails is left 'failed' for somebody to look
-- at, and one left in 'sending' by a crash is never sent again, which is the
-- safe way round for a message to a seller.
--
-- Platform data: nothing is granted to anon or a signed-in user.
create table if not exists public.pet_resends (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  -- The seller's chat (…@lid or …@c.us), where they are told.
  chat_id text not null,
  -- The listing as the site takes it, without photos: type, breed, age,
  -- listing_type, price, location, vaccinated, dewormed, description,
  -- seller_name, whatsapp.
  listing jsonb not null,
  -- Paths in the product-images bucket, as kept from the seller's photos.
  photo_paths text[] not null check (cardinality(photo_paths) between 1 and 6),
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists pet_resends_pending on public.pet_resends (created_at) where status = 'pending';

alter table public.pet_resends enable row level security;
revoke all on public.pet_resends from anon, authenticated;
grant select, insert, update on public.pet_resends to service_role;
