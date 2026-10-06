-- The AI photo check becomes a Growth feature, and every AI call is costed.
--
-- 1. photo_review joins the Growth flags. Starter stores keep the plain
--    intake (lib/intake.js): questions and photos straight to the review
--    queue, no AI. A plan change flips the row like any other Growth flag
--    (worker/lib/planChange.js), and the platform can still override it by
--    hand for one store.
--
-- 2. ai_usage: one row per AI call, written by the photo-review service on
--    the photo server (not in this repo) with the token counts OpenAI
--    returns and the cost at the prices it was configured with. Platform
--    data, not the store's: nothing here is granted to a signed-in user.

-- New stores: seeded with the rest of the Growth flags.
create or replace function public.seed_tenant_features(target uuid, plan tenant_tier)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  growth_flags text[] := array[
    'contacts', 'disputes', 'escrow', 'publish_instagram', 'publish_facebook', 'whatsapp_checkout',
    'photo_review'
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

-- Stores already here. A row set by hand (Kay stores, the first one switched
-- on) is left as it is.
insert into public.tenant_features (tenant_id, flag, enabled)
select id, 'photo_review', tier in ('growth', 'business')
from public.tenants
on conflict (tenant_id, flag) do nothing;

create table if not exists public.ai_usage (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  -- Kept when a draft is cleared away, so a store's totals don't shrink.
  draft_id uuid references public.listing_drafts(id) on delete set null,
  purpose text not null default 'photo_review',
  -- As OpenAI reports it, which names the exact version billed.
  model text not null,
  images integer not null default 0 check (images >= 0),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  cached_tokens integer not null default 0 check (cached_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  -- Null when the service has no prices set; the tokens are enough to work
  -- it out afterwards.
  cost_usd numeric(12, 6) check (cost_usd >= 0),
  created_at timestamptz not null default now()
);

create index if not exists ai_usage_tenant_created on public.ai_usage (tenant_id, created_at desc);
create index if not exists ai_usage_draft on public.ai_usage (draft_id);

alter table public.ai_usage enable row level security;
revoke all on public.ai_usage from anon, authenticated;
grant select, insert on public.ai_usage to service_role;
