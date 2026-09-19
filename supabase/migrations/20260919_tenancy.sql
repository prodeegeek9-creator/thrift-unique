-- Tenancy foundation: who the businesses are, who belongs to them, and what
-- each one is entitled to.
--
-- Nothing else in the platform can be built correctly before this lands. Every
-- table that follows is scoped by tenant_id, and every policy that follows
-- reads current_tenant_ids().
--
-- Safe to run against the live database: this migration only adds new objects.
-- It does not touch products, orders, offers or any other existing table, and
-- it does not change RLS on them. See 20260919b and 20260919c.

-- ── ENUMS ────────────────────────────────────────────────────────────────────

do $$ begin
  create type tenant_tier as enum ('starter', 'growth', 'business');
exception when duplicate_object then null; end $$;

do $$ begin
  create type tenant_status as enum ('onboarding', 'active', 'suspended');
exception when duplicate_object then null; end $$;

-- Three roles, fixed, matching the Team screen: owner has everything, manager
-- has listings/orders/customers, staff has listings only. A fixed enum rather
-- than a permission matrix, because that is what the product actually offers
-- and an unused matrix is a thing you have to keep honest forever.
do $$ begin
  create type staff_role as enum ('owner', 'manager', 'staff');
exception when duplicate_object then null; end $$;

-- ── TENANTS ──────────────────────────────────────────────────────────────────

create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),

  -- The address a storefront would live at, and the tag the WhatsApp bot uses
  -- to disambiguate a seller who runs more than one store. Lowercase enforced
  -- rather than relying on citext, which may not be installed.
  slug text not null unique check (slug = lower(slug) and slug ~ '^[a-z0-9-]{3,40}$'),
  name text not null,

  tier tenant_tier not null default 'starter',
  status tenant_status not null default 'onboarding',

  -- Branding. The dashboard chrome re-points its colour tokens from here, so a
  -- seller sees their own store rather than ours.
  logo_url text,
  brand_color text,

  -- How an inbound WhatsApp message is resolved to a business. This is the
  -- authoritative lookup — the "Store: <slug>" tag the deep link adds is a
  -- hint, and loses to this when the two disagree.
  whatsapp_number text unique,

  -- The WAHA session this tenant's messages route through. Managed by the
  -- platform; the seller only ever scans a QR code.
  waha_session text unique,

  -- Per tenant rather than per tier: the Business tier is explicitly
  -- negotiable, and a tier-derived rate would have nowhere to record that.
  commission_pct numeric(5, 2) not null default 8.00
    check (commission_pct >= 0 and commission_pct <= 100),

  -- Where this tenant's money settles.
  paystack_subaccount text,

  -- Commission disclaimer acceptance, logged at onboarding. Timestamped and
  -- tied to the tenant because the whole commercial relationship rests on it.
  disclaimer_accepted_at timestamptz,
  disclaimer_version text,

  created_at timestamptz not null default now()
);

create table if not exists public.tenant_members (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role staff_role not null default 'staff',
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create index if not exists tenant_members_user_id_idx
  on public.tenant_members (user_id);

-- Feature flags as rows, not as a property derived from the tier.
--
-- The platform console needs to switch a Business feature on for a Growth
-- customer mid-negotiation, and switch one off after a chargeback, without
-- moving anybody between plans. Rows make both a one-line update. The tier
-- only decides what gets seeded here at provisioning — see
-- seed_tenant_features() below.
create table if not exists public.tenant_features (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  flag text not null,
  enabled boolean not null default false,
  primary key (tenant_id, flag)
);

-- ── SCOPE HELPERS ────────────────────────────────────────────────────────────

-- The tenants the caller belongs to.
--
-- SECURITY DEFINER is load-bearing, not incidental. The policy on
-- tenant_members below calls this function, and this function selects from
-- tenant_members — under the caller's own rights that is infinite recursion,
-- and Postgres reports it as a policy error a long way from its cause.
-- Running as the owner skips RLS on the read and breaks the cycle.
--
-- search_path is pinned for the usual reason: a SECURITY DEFINER function that
-- resolves its own table names through a caller-controlled search_path is a
-- privilege escalation waiting to be written up.
create or replace function public.current_tenant_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select tenant_id from public.tenant_members where user_id = auth.uid();
$$;

create or replace function public.has_tenant_role(target uuid, allowed staff_role[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.tenant_members
    where tenant_id = target
      and user_id = auth.uid()
      and role = any(allowed)
  );
$$;

-- Whether a tenant holds a flag. Reads the row and nothing else: the tier→flag
-- map lives in the seed function and in src/lib/features.js, and this is the
-- record both of them write to.
create or replace function public.tenant_has_feature(target uuid, flag_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select enabled from public.tenant_features
      where tenant_id = target and flag = flag_name),
    false
  );
$$;

-- The tier→flag map, server side. Keep in step with FLAG_MIN_TIER in
-- src/lib/features.js — that copy decides what the dashboard draws, this one
-- decides what a tenant actually gets.
create or replace function public.seed_tenant_features(target uuid, plan tenant_tier)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  growth_flags text[] := array[
    'contacts', 'disputes', 'escrow', 'publish_instagram', 'publish_facebook'
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
      target,
      f,
      case
        when f = any(growth_flags) then plan in ('growth', 'business')
        else plan = 'business'
      end
    )
    -- Deliberately not overwriting. Re-seeding on a plan change must not undo
    -- an override the platform set by hand; moving a tenant between tiers is
    -- its own operation, not a side effect of running this.
    on conflict (tenant_id, flag) do nothing;
  end loop;
end;
$$;

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- New tables, so enabling this here breaks nothing that is currently running.

alter table public.tenants enable row level security;
alter table public.tenant_members enable row level security;
alter table public.tenant_features enable row level security;

drop policy if exists "members read their tenants" on public.tenants;
create policy "members read their tenants" on public.tenants
  for select using (id in (select public.current_tenant_ids()));

-- Only an owner edits the business. Note the WITH CHECK as well as the USING:
-- without it an owner could update the row to point at a tenant they do not
-- belong to, which is the classic way a scoped update policy leaks.
drop policy if exists "owners update their tenant" on public.tenants;
create policy "owners update their tenant" on public.tenants
  for update
  using (public.has_tenant_role(id, array['owner']::staff_role[]))
  with check (public.has_tenant_role(id, array['owner']::staff_role[]));

drop policy if exists "members read their colleagues" on public.tenant_members;
create policy "members read their colleagues" on public.tenant_members
  for select using (tenant_id in (select public.current_tenant_ids()));

drop policy if exists "owners manage staff" on public.tenant_members;
create policy "owners manage staff" on public.tenant_members
  for all
  using (public.has_tenant_role(tenant_id, array['owner']::staff_role[]))
  with check (public.has_tenant_role(tenant_id, array['owner']::staff_role[]));

drop policy if exists "members read their flags" on public.tenant_features;
create policy "members read their flags" on public.tenant_features
  for select using (tenant_id in (select public.current_tenant_ids()));

-- No write policy on tenant_features on purpose. A seller who could grant
-- themselves a flag would have bought nothing. These rows are written by the
-- Worker under the service key, and by nobody else.

-- Tenants are created by the provisioning path in the Worker, under the
-- service key, after the bot has collected a business name and a tier. There
-- is deliberately no insert policy for authenticated users: self-serve tenant
-- creation from the browser would let anyone mint a store with a
-- commission_pct of zero.
