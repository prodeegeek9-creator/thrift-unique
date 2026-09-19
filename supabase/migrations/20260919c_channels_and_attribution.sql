-- Channel publishing, attribution, payouts and disputes.
--
-- Two of these exist now rather than in the phase that needs them, and the
-- reason is the same for both: they are Business-tier *reads* fed by
-- Starter-tier *writes*.
--
-- The Analytics screen shows "where your sales came from" — WhatsApp 42%,
-- Instagram 30%, and so on. That donut is only possible if every order records
-- the channel it arrived through, from the first order onward. Ship orders
-- without it and the first Business customer gets an empty chart with no way
-- to backfill it, because the information never existed. Same story for the
-- usage counters on Billing.
--
-- So: record from day one, display when the tier unlocks.
--
-- All new tables, so RLS is on from the start — unlike 20260919b, nothing here
-- can break the live marketplace.

-- ── ENUMS ────────────────────────────────────────────────────────────────────

do $$ begin
  create type sales_channel as enum
    ('whatsapp', 'instagram', 'facebook', 'tiktok', 'direct', 'storefront');
exception when duplicate_object then null; end $$;

do $$ begin
  create type post_status as enum ('queued', 'posted', 'failed', 'skipped');
exception when duplicate_object then null; end $$;

do $$ begin
  create type dispute_status as enum ('open', 'under_review', 'resolved');
exception when duplicate_object then null; end $$;

do $$ begin
  create type payout_status as enum ('pending', 'paid', 'failed');
exception when duplicate_object then null; end $$;

-- ── ATTRIBUTION ──────────────────────────────────────────────────────────────

do $$
begin
  if to_regclass('public.orders') is not null then
    execute 'alter table public.orders
               add column if not exists source_channel sales_channel';
    execute 'create index if not exists orders_tenant_channel_idx
               on public.orders (tenant_id, source_channel, created_at)';
  end if;
end $$;

-- ── PER-CHANNEL PUBLISHING ───────────────────────────────────────────────────

-- One row per product per channel. The Listings card shows four channel icons
-- with their own states, which needs somewhere to read them from — and a
-- failed Instagram publish that lives only in a log is a failure the seller
-- never finds out about.
create table if not exists public.listing_channel_posts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  product_id uuid not null,
  channel sales_channel not null,
  status post_status not null default 'queued',

  -- What the channel called it once published, so the post can be deleted or
  -- updated when the listing sells.
  external_post_id text,
  external_url text,

  error text,
  posted_at timestamptz,
  created_at timestamptz not null default now(),

  unique (product_id, channel)
);

create index if not exists listing_channel_posts_tenant_idx
  on public.listing_channel_posts (tenant_id, status);

-- ── CHANNEL CONNECTIONS ──────────────────────────────────────────────────────

-- The OAuth grant per tenant per channel, from the /connect step.
--
-- The token column is why this table has no select policy for the seller who
-- owns it: a long-lived Page token in a browser bundle is a token that posts
-- as them forever. The Channels screen needs to know *whether* a channel is
-- connected and under which account name, and those are the two columns the
-- view below exposes.
create table if not exists public.channel_connections (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  channel sales_channel not null,

  account_name text,
  account_id text,

  access_token text,
  refresh_token text,
  expires_at timestamptz,

  connected_at timestamptz not null default now(),
  primary key (tenant_id, channel)
);

create or replace view public.channel_connection_status
with (security_invoker = true) as
  select tenant_id, channel, account_name, connected_at,
         (expires_at is null or expires_at > now()) as healthy
    from public.channel_connections;

-- ── PAYOUTS ──────────────────────────────────────────────────────────────────

create table if not exists public.payouts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,

  -- Naira. Kobo is converted once, at the Paystack webhook in the Worker, and
  -- never again — see src/lib/money.js.
  amount numeric(12, 2) not null check (amount >= 0),
  commission numeric(12, 2) not null default 0 check (commission >= 0),

  status payout_status not null default 'pending',
  reference text unique,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists payouts_tenant_idx
  on public.payouts (tenant_id, created_at desc);

-- ── DISPUTES ─────────────────────────────────────────────────────────────────

create table if not exists public.disputes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  order_id uuid not null,

  reason text not null,
  status dispute_status not null default 'open',

  -- Growth flags a dispute and platform staff work it; Business gets the
  -- structured workflow. Both write here — the difference is who is allowed to
  -- move it along, which is a Worker decision rather than a schema one.
  opened_by text,
  resolution text,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists disputes_tenant_status_idx
  on public.disputes (tenant_id, status);

-- ── RLS ──────────────────────────────────────────────────────────────────────

alter table public.listing_channel_posts enable row level security;
alter table public.channel_connections enable row level security;
alter table public.payouts enable row level security;
alter table public.disputes enable row level security;

drop policy if exists "tenant reads its posts" on public.listing_channel_posts;
create policy "tenant reads its posts" on public.listing_channel_posts
  for select using (tenant_id in (select public.current_tenant_ids()));

drop policy if exists "tenant reads its payouts" on public.payouts;
create policy "tenant reads its payouts" on public.payouts
  for select using (tenant_id in (select public.current_tenant_ids()));

drop policy if exists "tenant reads its disputes" on public.disputes;
create policy "tenant reads its disputes" on public.disputes
  for select using (tenant_id in (select public.current_tenant_ids()));

-- Sellers and staff may raise a dispute; only the platform resolves one, so
-- there is no update policy here.
drop policy if exists "staff raise disputes" on public.disputes;
create policy "staff raise disputes" on public.disputes
  for insert
  with check (
    public.has_tenant_role(tenant_id, array['owner', 'manager']::staff_role[])
  );

-- No policy at all on channel_connections. Every column that matters is a
-- credential, and the seller reads their connection state through
-- channel_connection_status instead. With RLS enabled and no policy, the anon
-- and authenticated roles get nothing; the Worker reaches it under the service
-- key.
--
-- channel_connection_status is security_invoker, so it inherits that refusal.
-- It needs its own grant path once the Channels screen is built — most likely
-- a security definer function returning the two safe columns. Left undone
-- rather than guessed at, because a view that quietly bypasses RLS is how
-- tokens leak.

-- Publishing is written by the Worker after WAHA or the Meta API replies, so
-- listing_channel_posts and payouts have no client write policies either.
