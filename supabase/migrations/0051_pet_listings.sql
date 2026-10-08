-- Pet listings a store has sent to its own site and is waiting to hear back on.
--
-- When the site's owner approves one, the seller is told on WhatsApp. How it
-- was approved (the admin's tick, the edit form, the database) does not
-- matter, because Vendwyze asks: every minute, routes/petListings.js sends the
-- site the slugs still waiting and tells the seller about each that is live.
--
-- chat_id is the chat the seller wrote from, so the notice goes back to the
-- same conversation, not to the number buyers were given. Unique per store
-- and slug: a listing is told once. A row left in 'notifying' by a crash is
-- never sent again, which is the safe way round for a message.
--
-- Platform data: nothing is granted to anon or a signed-in user.
create table if not exists public.pet_listings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,119}$'),
  breed text,
  listing_type text,
  chat_id text not null,
  status text not null default 'pending' check (status in ('pending', 'notifying', 'notified', 'expired', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  error text,
  created_at timestamptz not null default now(),
  notified_at timestamptz,
  unique (tenant_id, slug)
);

create index if not exists pet_listings_pending on public.pet_listings (created_at) where status = 'pending';

alter table public.pet_listings enable row level security;
revoke all on public.pet_listings from anon, authenticated;
grant select, insert, update on public.pet_listings to service_role;
