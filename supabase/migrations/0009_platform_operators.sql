-- The platform side: who operates it, and a record of what they did.
--
-- Note what this migration does NOT do. It adds no `or is_platform_admin()`
-- escape hatch to any existing policy, and it grants no client role anything
-- new. Every RLS policy in 0001-0003 stays strictly tenant-scoped, with no
-- exceptions, because an exception is a hole in every policy at once: one
-- mistake in the admin predicate and any seller reads the whole platform.
--
-- Cross-tenant reading lives in the Worker instead, under the service key,
-- behind a single check in worker/lib/operator.js. One place to audit rather
-- than fifteen policies to keep honest.

-- ── WHO ──────────────────────────────────────────────────────────────────────

create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  -- 'support' can look and can resolve disputes; 'owner' can also move money
  -- and change what a tenant is paying. Two levels, because "can read every
  -- customer's orders" and "can release forty thousand naira" should not be
  -- the same grant.
  level text not null default 'support' check (level in ('support', 'owner')),
  note text,
  created_at timestamptz not null default now()
);

-- RLS on, and deliberately no policy at all.
--
-- The browser must never be able to read this table -- not even to check
-- whether the current user is in it. A client that can ask "am I an admin?"
-- is a client whose answer can be edited, and every screen that trusted the
-- answer would follow. The Worker reads it under the service key and the
-- browser is simply told what it may see.
alter table public.platform_admins enable row level security;

-- ── WHAT THEY DID ────────────────────────────────────────────────────────────

create table public.operator_audit (
  id bigint generated always as identity primary key,
  actor uuid references auth.users(id) on delete set null,
  action text not null,
  -- The tenant acted upon, when there is one. Nullable because provisioning
  -- and platform-wide reads have no single subject.
  tenant_id uuid references public.tenants(id) on delete set null,
  subject text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index operator_audit_recent_idx on public.operator_audit (created_at desc);
create index operator_audit_tenant_idx on public.operator_audit (tenant_id, created_at desc);

alter table public.operator_audit enable row level security;

-- Append-only, enforced rather than asserted.
--
-- The service key can do anything, so "we only ever insert" is a promise the
-- database is not holding anyone to. This makes an UPDATE or DELETE fail
-- outright, which is what an audit log has to do to be worth reading back:
-- a record that can be tidied afterwards is not evidence of anything.
create or replace function public.operator_audit_is_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'operator_audit is append-only (attempted %)', tg_op;
end;
$$;

create trigger operator_audit_no_update
  before update or delete on public.operator_audit
  for each row execute function public.operator_audit_is_append_only();

-- ── MONEY MOVED BY AN OPERATOR ───────────────────────────────────────────────

-- Resolving a dispute can refund a buyer, which is a state escrow_state
-- already has but nothing could reach until now. Recording who decided it, and
-- why, belongs on the dispute rather than in a log line somebody has to go
-- looking for.
alter table public.disputes
  add column resolved_by uuid references auth.users(id) on delete set null,
  add column outcome text check (outcome in ('released', 'refunded', 'no_action'));

-- ── THE FIRST OPERATOR ───────────────────────────────────────────────────────

-- Same chicken and egg as the first tenant: there is no way to grant the first
-- operator from inside a console only an operator can open.
insert into public.platform_admins (user_id, level, note)
select id, 'owner', 'Platform owner — seeded with the console'
from auth.users
where lower(email) = 'prodeegeek9@gmail.com'
on conflict (user_id) do nothing;
