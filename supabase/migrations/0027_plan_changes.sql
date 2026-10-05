-- Stores changing their own plan, and nudging them to.
--
-- Upgrading takes effect as soon as the store pays the difference for the rest
-- of what it has already paid for. That payment is a plan invoice of its own
-- (kind 'upgrade'), so it goes through the same pay page, Paystack webhook and
-- return-page check as the monthly fee.
--
-- Downgrading waits for the end of what the store has paid for: the lower plan
-- is recorded as next_tier, starting next_tier_at, and the next monthly
-- invoice is raised at its price.

alter table public.plan_invoices
  add column if not exists kind text not null default 'period' check (kind in ('period', 'upgrade')),
  add column if not exists from_tier tenant_tier;

-- Not in the column grant from 0022, so only the Worker writes them.
alter table public.tenants
  add column if not exists next_tier tenant_tier,
  add column if not exists next_tier_at timestamptz;

-- What the nudges need to remember: a store opening a screen its plan doesn't
-- include ('locked'), and each WhatsApp nudge sent ('whatsapp'), so they go at
-- most once a fortnight. Worker only: RLS on, no policy.
create table public.nudge_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kind text not null check (kind in ('locked', 'whatsapp')),
  flag text,
  reason text,
  tier tenant_tier,
  created_at timestamptz not null default now()
);

create index nudge_events_recent_idx on public.nudge_events (tenant_id, kind, created_at desc);

alter table public.nudge_events enable row level security;
