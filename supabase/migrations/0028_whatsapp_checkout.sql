-- Checkout inside WhatsApp (Growth and Business).
--
-- A buyer collects items in a chat with the store's own number (BUY <code>,
-- or replying to a Status post), gives a name and delivery address, and gets
-- one Paystack link for all of them. Until they pay, the cart lives in the
-- conversation (bot_conversations.draft). At PAY it becomes a cart row with
-- the Paystack reference and one order per item: each item keeps its own
-- delivery, escrow hold, dispute and refund, exactly as a single purchase.

create table public.carts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  buyer_id uuid references public.buyers(id) on delete set null,
  -- The chat on the store's number the cart came from, to answer there.
  chat_id text not null,
  -- The Paystack reference for the one payment (utc_…). Each order in the
  -- cart carries it with its own suffix (utc_…_1, utc_…_2).
  payment_ref text not null unique,
  amount numeric(12, 2) not null check (amount > 0),
  status text not null default 'open' check (status in ('open', 'paid', 'cancelled')),
  buyer_name text,
  delivery_address text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create index carts_tenant_idx on public.carts (tenant_id, created_at desc);

-- Worker only.
alter table public.carts enable row level security;

alter table public.orders
  add column if not exists cart_id uuid references public.carts(id) on delete set null;

create index if not exists orders_cart_idx on public.orders (cart_id) where cart_id is not null;

-- The owner answering a chat by hand: the bot keeps out of it until then.
alter table public.bot_conversations
  add column if not exists paused_until timestamptz;

-- An item in a cart sold to somebody else first is refunded automatically.
alter table public.refunds drop constraint if exists refunds_requested_via_check;
alter table public.refunds
  add constraint refunds_requested_via_check
  check (requested_via in ('store', 'operator', 'dispute', 'auto'));

-- The new Growth feature, for new stores and for the ones already here.
create or replace function public.seed_tenant_features(target uuid, plan tenant_tier)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  growth_flags text[] := array[
    'contacts', 'disputes', 'escrow', 'publish_instagram', 'publish_facebook', 'whatsapp_checkout'
  ];
  business_flags text[] := array[
    'analytics', 'team', 'publish_tiktok', 'catalog_sync', 'ai_match',
    'priority_support'
  ];
  f text;
begin
  foreach f in array (growth_flags || business_flags) loop
    insert into public.tenant_features (tenant_id, flag, enabled)
    values (
      target, f,
      case
        when f = any(growth_flags) then plan in ('growth', 'business')
        else plan = 'business'
      end
    )
    -- Deliberately not overwriting. Re-seeding after a plan change must not
    -- undo an override the platform set by hand; moving a tenant between tiers
    -- is its own operation, not a side effect of running this.
    on conflict (tenant_id, flag) do nothing;
  end loop;
end;
$$;

insert into public.tenant_features (tenant_id, flag, enabled)
select id, 'whatsapp_checkout', tier in ('growth', 'business')
from public.tenants
on conflict (tenant_id, flag) do nothing;

-- A product page offers "Buy on WhatsApp" only where the bot will answer: the
-- store has the feature and its own WhatsApp is linked and working. A new
-- column in the result means dropping and recreating the function, and so
-- granting it again exactly as 0004 did.
drop function if exists public.public_product(text);

create function public.public_product(code text)
returns table (
  public_code text,
  title text,
  description text,
  condition product_condition,
  price numeric,
  images text[],
  tenant_name text,
  tenant_slug text,
  tenant_whatsapp text,
  whatsapp_checkout boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    p.public_code, p.title, p.description, p.condition, p.price, p.images,
    t.name, t.slug, t.whatsapp_number,
    coalesce(t.waha_status = 'WORKING' and exists (
      select 1 from public.tenant_features f
      where f.tenant_id = t.id and f.flag = 'whatsapp_checkout' and f.enabled
    ), false)
  from public.products p
  join public.tenants t on t.id = p.tenant_id
  where p.public_code = upper(code)
    and p.status = 'active'
    and t.status = 'active'
    and t.billing_status <> 'paused';
$$;

revoke execute on function public.public_product(text) from public;
grant execute on function public.public_product(text) to anon, authenticated;
