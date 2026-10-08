-- The name a seller gave on their last pet listing, so the bot does not ask for
-- it every time. One row per store and chat: the chat is what a seller is
-- recognised by, as with every other conversation here.
--
-- Only names that passed the check in lib/petIntake.js (parseSellerName) are
-- stored, and only once a listing has actually reached the store's site.
--
-- Platform data: nothing is granted to anon or a signed-in user.
create table if not exists public.pet_sellers (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  chat_id text not null,
  name text not null check (char_length(name) between 2 and 80),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, chat_id)
);

alter table public.pet_sellers enable row level security;
revoke all on public.pet_sellers from anon, authenticated;
grant select, insert, update on public.pet_sellers to service_role;
