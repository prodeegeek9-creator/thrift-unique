-- Charging the monthly plan fee.
--
-- Each store is free for 14 days from approval, then pays its plan's price a
-- month at a time: by a Paystack link sent on WhatsApp, or by the card it paid
-- with last time if it chose to renew automatically. Unpaid past a 7-day grace
-- period, the store is paused (its pages go quiet, the bot asks for payment)
-- until it pays; nothing is deleted. See worker/lib/billing.js.

alter table public.tenants
  add column billing_status text not null default 'trial'
    check (billing_status in ('trial', 'active', 'past_due', 'paused')),
  -- The end of the time already paid for (or of the trial). Null before
  -- approval, and for a store that pays nothing.
  add column paid_until timestamptz,
  -- A price agreed for this store in place of its plan's: Business is
  -- negotiable. Zero means the store pays no plan fee at all.
  add column plan_price numeric(12, 2) check (plan_price >= 0),
  add column auto_renew boolean not null default false;

-- The platform's own stores (owned by an operator) pay no plan fee.
update public.tenants t
   set plan_price = 0, billing_status = 'active'
 where exists (
   select 1 from public.tenant_members m
     join public.platform_admins a on a.user_id = m.user_id
    where m.tenant_id = t.id and m.role = 'owner'
 );

-- Every other store already live starts its free period now.
update public.tenants
   set paid_until = now() + interval '14 days'
 where status = 'active' and plan_price is null;

-- ── ONE MONTH, ONE INVOICE ──────────────────────────────────────────────────

create table public.plan_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  tier tenant_tier not null,
  amount numeric(12, 2) not null check (amount > 0),
  period_start timestamptz not null,
  period_end timestamptz not null,
  status text not null default 'open' check (status in ('open', 'paid', 'void')),
  -- The Paystack reference for paying it, and the address of its pay page:
  -- /billing/pay/<payment_ref>. Unguessable, so it can travel on WhatsApp.
  payment_ref text not null unique,
  paid_at timestamptz,
  paid_via text check (paid_via in ('link', 'card', 'manual')),
  -- Which reminder went last: 1 before it is due, 2 on the day, 3 in the
  -- grace period, 4 the pause notice. Each is sent once.
  reminder_stage integer not null default 0,
  created_at timestamptz not null default now(),
  unique (tenant_id, period_start)
);

create index plan_invoices_open_idx on public.plan_invoices (tenant_id) where status = 'open';

alter table public.plan_invoices enable row level security;
create policy "managers read plan invoices" on public.plan_invoices
  for select using (public.has_tenant_role(tenant_id, array['owner', 'manager']::staff_role[]));
revoke all on public.plan_invoices from anon, authenticated;
grant select on public.plan_invoices to authenticated;

-- ── A SAVED CARD, FOR AUTO-RENEW ─────────────────────────────────────────────
--
-- Paystack's authorization code charges this card again without the owner
-- present. It is a credential: RLS on, no policy, no grant. The Worker shows
-- the owner only the brand and last four digits.
create table public.billing_cards (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  authorization_code text not null,
  email text not null,
  card_brand text,
  card_last4 text,
  exp_month text,
  exp_year text,
  updated_at timestamptz not null default now()
);

alter table public.billing_cards enable row level security;
revoke all on public.billing_cards from anon, authenticated;

-- ── A PAUSED STORE GOES QUIET ────────────────────────────────────────────────

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
    and t.status = 'active'
    and t.billing_status <> 'paused';
$$;

-- A paused store's page says so, rather than "not found": its buyers should
-- know it is coming back.
create or replace function public.public_store(store_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when t.billing_status = 'paused' then
    jsonb_build_object('name', t.name, 'slug', t.slug, 'paused', true, 'products', '[]'::jsonb)
  else jsonb_build_object(
    'name', t.name,
    'slug', t.slug,
    'logo_url', t.logo_url,
    'brand_color', t.brand_color,
    'whatsapp_number', t.whatsapp_number,
    'takes_items', (
      t.store_type is distinct from 'brand'
      and t.waha_session is not null
      and t.waha_status = 'WORKING'
    ),
    'products', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'public_code', p.public_code,
            'title', p.title,
            'price', p.price,
            'condition', p.condition,
            'image', p.images[1]
          )
          order by p.created_at desc
        )
        from (
          select * from public.products
          where tenant_id = t.id and status = 'active'
          order by created_at desc
          limit 200
        ) p
      ),
      '[]'::jsonb
    )
  ) end
  from public.tenants t
  where t.slug = lower(store_slug)
    and t.status = 'active';
$$;
