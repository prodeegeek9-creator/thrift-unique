-- Scope the existing marketplace tables to a tenant, and make the live store
-- tenant #1.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THIS MIGRATION IS ADDITIVE ON PURPOSE. It adds columns, indexes and a
-- backfill. It does NOT enable row level security on any existing table, and
-- it does not drop or alter an existing policy.
--
-- That restraint is the whole point. thrift-unique.prodeegeek9.workers.dev is
-- serving real buyers right now, through the anon key, against these exact
-- tables. Turning on tenant-scoped RLS here would take the marketplace down
-- the moment it ran — every anonymous read would start returning zero rows,
-- because an anonymous visitor belongs to no tenant.
--
-- The lockdown is 20260919d_tenant_rls.sql, which is written to be run at
-- cutover, once the dashboard is what people are actually using. Until then
-- these columns are carried and populated, and nothing reads them but the new
-- app. See the README's "Cutover" section.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The column list below was reconstructed from the live front-end code rather
-- than from the database, because the Supabase credentials available when this
-- was written could not reach the project. Every statement is therefore
-- guarded: a table that does not exist is skipped rather than aborting the
-- run. Verify against the real schema before relying on it.

-- ── TENANT ID EVERYWHERE ─────────────────────────────────────────────────────

do $$
declare
  t text;
  scoped text[] := array[
    'products', 'orders', 'offers', 'cart',
    'chat_messages', 'messages', 'seller_profiles'
  ];
begin
  foreach t in array scoped loop
    if to_regclass('public.' || t) is not null then
      execute format(
        'alter table public.%I add column if not exists tenant_id uuid
           references public.tenants(id) on delete cascade', t);
      execute format(
        'create index if not exists %I on public.%I (tenant_id)',
        t || '_tenant_id_idx', t);
    else
      raise notice 'skipping %, table not found', t;
    end if;
  end loop;
end $$;

-- ── TENANT #1 ────────────────────────────────────────────────────────────────

-- The existing single store. Created here rather than through the Worker's
-- provisioning path because it predates it, and because every backfill below
-- needs something to point at.
--
-- Business tier: it is the platform owner's own store, it is the one that will
-- exercise every feature first, and it should never be the thing that
-- discovers a flag is missing.
insert into public.tenants (slug, name, tier, status, commission_pct)
values ('unique-thrift', 'Unique Thrift', 'business', 'active', 0.00)
on conflict (slug) do nothing;

select public.seed_tenant_features(
  (select id from public.tenants where slug = 'unique-thrift'),
  'business'
);

-- ── BACKFILL ─────────────────────────────────────────────────────────────────

-- Every row that exists today belongs to that store. Only null rows are
-- touched, so re-running this cannot reassign anything that has since been
-- created against another tenant.
do $$
declare
  t text;
  home uuid;
  scoped text[] := array[
    'products', 'orders', 'offers', 'cart',
    'chat_messages', 'messages', 'seller_profiles'
  ];
begin
  select id into home from public.tenants where slug = 'unique-thrift';
  if home is null then
    raise exception 'tenant unique-thrift missing; cannot backfill';
  end if;

  foreach t in array scoped loop
    if to_regclass('public.' || t) is not null then
      execute format(
        'update public.%I set tenant_id = $1 where tenant_id is null', t)
        using home;
    end if;
  end loop;
end $$;

-- ── MEMBERSHIP ───────────────────────────────────────────────────────────────

-- Whoever is already a seller on the existing site becomes a member of tenant
-- #1, so that nobody has to be re-invited at cutover. The account that owns
-- the platform is promoted to owner; everyone else lands as staff and gets
-- raised by hand if they should be more.
do $$
declare
  home uuid;
begin
  select id into home from public.tenants where slug = 'unique-thrift';
  if home is null then return; end if;

  if to_regclass('public.seller_profiles') is not null then
    insert into public.tenant_members (tenant_id, user_id, role)
    select home, sp.id, 'staff'::staff_role
      from public.seller_profiles sp
     where sp.is_seller is true
    on conflict (tenant_id, user_id) do nothing;
  end if;

  update public.tenant_members m
     set role = 'owner'
    from auth.users u
   where m.user_id = u.id
     and m.tenant_id = home
     and lower(u.email) = 'prodeegeek9@gmail.com';
end $$;

-- ── LISTING STATUS ───────────────────────────────────────────────────────────

-- The live site writes products.status as 'pending' at insert and the admin
-- Worker moves it to 'approved' or 'rejected'. The dashboard's Listings screen
-- filters on All / Active / Sold, so 'active' and 'sold' need to be reachable
-- values. Left as free text rather than converted to an enum: an in-place enum
-- conversion on a column the live site is writing is exactly the kind of
-- change this migration is avoiding.
--
-- The mapping ('approved' reads as active) lives in src/components/ui/
-- StatusPill.jsx until 20260919d can do this properly.
do $$
begin
  if to_regclass('public.products') is not null then
    execute 'alter table public.products
               add column if not exists sold_at timestamptz';
    execute 'create index if not exists products_tenant_status_idx
               on public.products (tenant_id, status)';
  end if;
end $$;
