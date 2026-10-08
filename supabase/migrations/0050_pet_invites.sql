-- People a pet store should invite to list: they messaged the store about
-- selling a pet, but the bot was not answering yet (or was not able to).
--
-- A row is one invitation. The Worker's minute sweep (routes/petInvites.js)
-- sends the bot's opening message from the store's own WhatsApp number, once,
-- and marks the row. Unique per store and number, so a person is never
-- invited twice; a row left in 'sending' by a crash is never retried, which
-- is the safe way round for a message to somebody who did not ask for it
-- again.
--
-- Platform data: nothing is granted to anon or a signed-in user.
create table if not exists public.pet_invites (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  -- Digits only, with the country code: 2348031234567.
  phone text not null check (phone ~ '^[1-9][0-9]{9,14}$'),
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (tenant_id, phone)
);

create index if not exists pet_invites_pending on public.pet_invites (created_at) where status = 'pending';

alter table public.pet_invites enable row level security;
revoke all on public.pet_invites from anon, authenticated;
grant select, insert, update on public.pet_invites to service_role;
