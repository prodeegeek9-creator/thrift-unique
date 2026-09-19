-- Distribution, money out, and things going wrong.

create type post_status as enum ('queued', 'posted', 'failed', 'skipped');
create type dispute_status as enum ('open', 'under_review', 'resolved');
create type payout_status as enum ('pending', 'paid', 'failed');

-- ── PER-CHANNEL PUBLISHING ───────────────────────────────────────────────────

-- One row per product per channel. The Listings card in the mockups shows four
-- channel icons with their own states, which needs somewhere to read from —
-- and a failed Instagram publish that lives only in a log is a failure the
-- seller never finds out about.
create table public.listing_channel_posts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  channel sales_channel not null,

  status post_status not null default 'queued',

  -- What the channel called it once published, so the post can be updated or
  -- taken down when the item sells.
  external_post_id text,
  external_url text,

  error text,
  posted_at timestamptz,
  created_at timestamptz not null default now(),

  unique (product_id, channel)
);

create index listing_channel_posts_tenant_idx
  on public.listing_channel_posts (tenant_id, status);

-- Work waiting to go out. Partial, because a queue is a thin slice of a table
-- that only grows.
create index listing_channel_posts_queue_idx
  on public.listing_channel_posts (created_at)
  where status = 'queued';

-- ── CHANNEL CONNECTIONS ──────────────────────────────────────────────────────

-- The OAuth grant per tenant per channel, from the /connect step.
--
-- Posting happens as the *seller's own* Page and Instagram account — that is
-- the entire value proposition, reaching followers they already have — so
-- these are long-lived tokens that post as them until revoked.
create table public.channel_connections (
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

-- What the Channels screen is allowed to know: whether a channel is connected,
-- under which account name, and whether the token is still good. Not the
-- token.
--
-- security_definer here rather than invoker, deliberately and unusually: the
-- base table has RLS on with no policy, so an invoker view would return
-- nothing. The function-shaped alternative would be identical. The safety
-- comes from the column list, which is fixed here and cannot be widened by a
-- caller, and from the tenant check in the WHERE clause.
create or replace function public.channel_status(target uuid)
returns table (
  channel sales_channel,
  account_name text,
  connected_at timestamptz,
  healthy boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.channel, c.account_name, c.connected_at,
         (c.expires_at is null or c.expires_at > now())
    from public.channel_connections c
   where c.tenant_id = target
     -- The check that makes SECURITY DEFINER safe here. Without it this
     -- function would hand any authenticated caller any tenant's connections.
     and target in (select public.current_tenant_ids());
$$;

grant execute on function public.channel_status(uuid) to authenticated;

-- ── PAYOUTS ──────────────────────────────────────────────────────────────────

create table public.payouts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,

  -- Naira, like everything else. See src/lib/money.js.
  amount numeric(12, 2) not null check (amount >= 0),
  commission numeric(12, 2) not null default 0 check (commission >= 0),

  status payout_status not null default 'pending',
  reference text unique,
  failure_reason text,

  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create index payouts_tenant_idx on public.payouts (tenant_id, created_at desc);

-- Which orders a payout settled. A separate table rather than a column,
-- because one payout covers several orders and one order can be partly
-- refunded — and reconciling a dispute six weeks later means being able to say
-- exactly which sale a given transfer paid for.
create table public.payout_items (
  payout_id uuid not null references public.payouts(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete restrict,
  amount numeric(12, 2) not null check (amount >= 0),
  primary key (payout_id, order_id)
);

-- ── DISPUTES ─────────────────────────────────────────────────────────────────

create table public.disputes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,

  reason text not null,
  status dispute_status not null default 'open',

  -- Growth flags a dispute and platform staff work it; Business gets the
  -- structured workflow. Both write here — what differs is who may move it
  -- along, which is a Worker decision rather than a schema one.
  opened_by text,
  resolution text,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index disputes_tenant_status_idx on public.disputes (tenant_id, status);

-- ── RLS ──────────────────────────────────────────────────────────────────────

alter table public.listing_channel_posts enable row level security;
alter table public.channel_connections enable row level security;
alter table public.payouts enable row level security;
alter table public.payout_items enable row level security;
alter table public.disputes enable row level security;

create policy "team reads its posts" on public.listing_channel_posts
  for select using (tenant_id in (select public.current_tenant_ids()));

create policy "managers read payouts" on public.payouts
  for select using (
    public.has_tenant_role(tenant_id, array['owner', 'manager']::staff_role[])
  );

create policy "managers read payout items" on public.payout_items
  for select using (
    exists (
      select 1 from public.payouts p
      where p.id = payout_id
        and public.has_tenant_role(p.tenant_id, array['owner', 'manager']::staff_role[])
    )
  );

create policy "managers read disputes" on public.disputes
  for select using (
    public.has_tenant_role(tenant_id, array['owner', 'manager']::staff_role[])
  );

create policy "managers raise disputes" on public.disputes
  for insert
  with check (
    public.has_tenant_role(tenant_id, array['owner', 'manager']::staff_role[])
  );

-- No policy at all on channel_connections: every column that matters is a
-- credential, and the Channels screen reads channel_status() instead. RLS on
-- with no policy means anon and authenticated get nothing, and the Worker
-- reaches it under the service key.
--
-- Nothing else here takes client writes. Publishing rows are written after
-- WAHA or the Meta API replies; payouts after Paystack settles; a dispute is
-- resolved by the platform, never by the tenant it is against.
