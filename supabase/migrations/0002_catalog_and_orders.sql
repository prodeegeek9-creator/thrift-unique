-- Products, buyers, orders, offers.
--
-- Two tables from the old single-store site are deliberately absent. There is
-- no `cart`, because there is no storefront to put one on — a buyer discovers
-- an item on WhatsApp Status or Instagram and buys that item. And there is no
-- web `chat_messages`, because the conversation happens in WhatsApp, which is
-- the entire premise. Both would be schema kept alive out of habit.

-- ── ENUMS ────────────────────────────────────────────────────────────────────

create type product_condition as enum ('brand_new', 'excellent', 'good', 'fair');

-- No 'pending' / 'approved'. On the old single-store site the owner reviewed
-- every listing; here the seller pays for the account and their listings are
-- their own. Platform moderation, if it is ever wanted, is a flag and a
-- separate column rather than a gate every seller waits behind.
create type product_status as enum ('draft', 'active', 'sold', 'archived');

create type order_status as enum (
  'awaiting_payment', 'processing', 'escrow', 'paid', 'completed',
  'cancelled', 'refunded'
);

-- Starter takes no hold at all, so 'none' is a real state and not a null.
create type escrow_state as enum ('none', 'held', 'released', 'refunded');

create type offer_status as enum (
  'pending', 'accepted', 'declined', 'countered', 'expired'
);

create type sales_channel as enum (
  'whatsapp', 'instagram', 'facebook', 'tiktok', 'direct'
);

-- ── PRODUCTS ─────────────────────────────────────────────────────────────────

create table public.products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,

  -- The short code in /p/<code>. It exists so a shared link is short enough to
  -- sit in a WhatsApp Status caption, and so the bot can identify an item
  -- exactly rather than guessing which brown jacket a buyer meant.
  public_code text not null unique
    check (public_code ~ '^[A-Z0-9]{4,10}$'),

  title text not null,
  description text,
  category text,
  condition product_condition not null default 'good',

  -- Naira. Kobo is converted once, at the Paystack webhook in the Worker, and
  -- never again — see src/lib/money.js.
  price numeric(12, 2) not null check (price >= 0),

  -- Storage paths, not full URLs: the bucket can move, and a row full of
  -- absolute URLs is a migration nobody wants to write.
  images text[] not null default '{}',

  quantity_available integer not null default 1 check (quantity_available >= 0),
  status product_status not null default 'draft',

  allow_negotiation boolean not null default false,
  min_discount_pct numeric(5, 2)
    check (min_discount_pct is null or (min_discount_pct >= 0 and min_discount_pct <= 100)),

  sold_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index products_tenant_status_idx on public.products (tenant_id, status, created_at desc);

create trigger products_touch before update on public.products
  for each row execute function public.touch_updated_at();

-- ── BUYERS ───────────────────────────────────────────────────────────────────

-- The Contacts screen, and the thing an order points at.
--
-- Scoped per tenant on purpose. The same person buying from two different
-- sellers is two rows, because each seller owns their own customer
-- relationship — that is what they are paying for, and a shared buyer table
-- would quietly turn the platform into the one with the customer list.
create table public.buyers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,

  -- E.164, digits only. The identity, since every buyer arrives through
  -- WhatsApp.
  phone text not null check (phone ~ '^[1-9][0-9]{7,14}$'),
  name text,

  first_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  unique (tenant_id, phone)
);

-- ── ORDERS ───────────────────────────────────────────────────────────────────

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,

  -- UT-1028 in the mockups. What a seller and a buyer say to each other.
  order_code text not null unique,

  product_id uuid not null references public.products(id) on delete restrict,
  buyer_id uuid not null references public.buyers(id) on delete restrict,

  quantity integer not null default 1 check (quantity > 0),
  amount numeric(12, 2) not null check (amount >= 0),
  commission numeric(12, 2) not null default 0 check (commission >= 0),

  status order_status not null default 'awaiting_payment',
  escrow_status escrow_state not null default 'none',

  -- Attribution, recorded from the first order onward.
  --
  -- This is a Business-tier read fed by a Starter-tier write. The Analytics
  -- donut — WhatsApp 42%, Instagram 30% — is only possible if every order has
  -- carried its channel all along. Ship without it and the first Business
  -- customer gets an empty chart that cannot be backfilled, because the
  -- information never existed.
  source_channel sales_channel,

  payment_ref text unique,

  paid_at timestamptz,
  shipped_at timestamptz,

  -- Escrow. confirm_deadline is what releases funds when a buyer goes quiet:
  -- without it, a buyer who never replies freezes the seller's money forever.
  confirm_deadline timestamptz,
  confirmed_at timestamptz,
  completed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index orders_tenant_status_idx on public.orders (tenant_id, status, created_at desc);
create index orders_tenant_channel_idx on public.orders (tenant_id, source_channel, created_at);
create index orders_buyer_idx on public.orders (buyer_id);

-- Funds waiting on a buyer who has stopped replying. The release sweep reads
-- this; a partial index because it is a small slice of a growing table.
create index orders_escrow_deadline_idx on public.orders (confirm_deadline)
  where escrow_status = 'held';

create trigger orders_touch before update on public.orders
  for each row execute function public.touch_updated_at();

-- ── OFFERS ───────────────────────────────────────────────────────────────────

create table public.offers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  buyer_id uuid not null references public.buyers(id) on delete cascade,

  offer_amount numeric(12, 2) not null check (offer_amount >= 0),
  -- Snapshotted, not joined. What the item cost when the offer was made is
  -- part of the offer; a seller who later drops the price must not
  -- retroactively change what a buyer was arguing about.
  listed_price numeric(12, 2) not null,
  message text,

  status offer_status not null default 'pending',
  counter_amount numeric(12, 2),
  counter_note text,
  countered_at timestamptz,

  expires_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index offers_tenant_status_idx on public.offers (tenant_id, status, created_at desc);

-- ── CONTACTS VIEW ────────────────────────────────────────────────────────────

-- What the Contacts screen reads: orders, total spent, last purchase, and the
-- repeat-buyer flag the mockups put a green badge on.
--
-- security_invoker so the view enforces the caller's RLS rather than the
-- definer's. A view that quietly bypasses row security is how one tenant ends
-- up reading another's customer list.
create view public.buyer_summary
with (security_invoker = true) as
  select
    b.id,
    b.tenant_id,
    b.name,
    b.phone,
    b.first_seen_at,
    count(o.id) filter (where o.status in ('paid', 'completed')) as order_count,
    coalesce(sum(o.amount) filter (where o.status in ('paid', 'completed')), 0) as total_spent,
    max(o.created_at) filter (where o.status in ('paid', 'completed')) as last_purchase_at,
    count(o.id) filter (where o.status in ('paid', 'completed')) > 1 as is_repeat
  from public.buyers b
  left join public.orders o on o.buyer_id = b.id
  group by b.id;

-- ── PUBLIC PRODUCT LOOKUP ────────────────────────────────────────────────────

-- The one thing an anonymous visitor may read, and only one row at a time.
--
-- A plain anon SELECT policy on products would let anybody walk the whole
-- catalogue of every tenant on the platform. Requiring the code means a
-- visitor can only see a listing somebody deliberately shared with them, and
-- returning named columns means the seller's cost, their negotiation floor and
-- their internal status never leave the database.
create or replace function public.public_product(code text)
returns table (
  public_code text,
  title text,
  description text,
  condition product_condition,
  price numeric,
  images text[],
  tenant_name text,
  tenant_slug text,
  tenant_whatsapp text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    p.public_code, p.title, p.description, p.condition, p.price, p.images,
    t.name, t.slug, t.whatsapp_number
  from public.products p
  join public.tenants t on t.id = p.tenant_id
  where p.public_code = upper(code)
    and p.status = 'active'
    and t.status = 'active';
$$;

grant execute on function public.public_product(text) to anon, authenticated;

-- ── RLS ──────────────────────────────────────────────────────────────────────

alter table public.products enable row level security;
alter table public.buyers enable row level security;
alter table public.orders enable row level security;
alter table public.offers enable row level security;

-- Everyone on the team can see the catalogue; staff can list, which is exactly
-- what "Staff — listings only" means on the Team screen.
create policy "team reads listings" on public.products
  for select using (tenant_id in (select public.current_tenant_ids()));

create policy "team writes listings" on public.products
  for all
  using (public.has_tenant_role(tenant_id, array['owner', 'manager', 'staff']::staff_role[]))
  with check (public.has_tenant_role(tenant_id, array['owner', 'manager', 'staff']::staff_role[]));

-- Buyers and orders stop at manager. Staff list items; they do not get the
-- customer list or the money.
create policy "managers read buyers" on public.buyers
  for select using (
    public.has_tenant_role(tenant_id, array['owner', 'manager']::staff_role[])
  );

create policy "managers read orders" on public.orders
  for select using (
    public.has_tenant_role(tenant_id, array['owner', 'manager']::staff_role[])
  );

create policy "managers read offers" on public.offers
  for select using (
    public.has_tenant_role(tenant_id, array['owner', 'manager']::staff_role[])
  );

-- No client write policies on buyers, orders or offers. Every one of those
-- rows is created by the bot or by a payment webhook, under the service key —
-- a seller who could insert a completed order could also release escrow to
-- themselves.
