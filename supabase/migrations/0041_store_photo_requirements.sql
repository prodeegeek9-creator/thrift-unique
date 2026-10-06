-- Each store's own photo expectations, on top of the platform's defaults.
--
-- photo_shot_rules (0038) says what a category needs on every store. A store
-- owner may disagree — a vintage store that doesn't care about labels, a
-- phone reseller that won't take a phone without its screen switched on — so
-- two thin layers of overrides sit on top:
--
--   store_photo_categories   a category this store does not take (SELL stops
--                            offering it)
--   store_shot_rules         one shot moved to required, optional or off
--
-- A store with no rows here behaves exactly as before: every row is a
-- difference from the default, and setting a value back to the default
-- deletes the row (src/lib/photoRules.js).
--
-- Quality thresholds (size, blur, light) are deliberately not here. They are
-- numbers an owner cannot sensibly choose, and a wrong one silently rejects
-- every photo; they stay platform-wide on photo_categories.

-- ── WHICH CATEGORIES A STORE TAKES ───────────────────────────────────────────

create table public.store_photo_categories (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  category text not null references public.photo_categories(slug) on update cascade on delete cascade,
  -- Only false is ever stored; accepting is the default, so "accept again"
  -- deletes the row. Kept as a column rather than implied by presence so the
  -- row reads as what it means.
  accepted boolean not null check (not accepted),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, category)
);

-- ── WHICH SHOTS A STORE NEEDS ────────────────────────────────────────────────

create table public.store_shot_rules (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  category text not null,
  shot_type text not null,
  requirement text not null check (requirement in ('required', 'optional', 'conditional', 'off')),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, category, shot_type),
  foreign key (category, shot_type)
    references public.photo_shot_rules(category, shot_type) on update cascade on delete cascade
);

-- What an override may say depends on the rule it overrides:
--
--   the main shot      none at all. An item needs one real picture of itself,
--                      and it is the product's first image.
--   a conditional one  'conditional' or 'off'. "Always require a close-up of
--                      the flaws" would ask for one from an item without any.
--   anything else      'required', 'optional' or 'off'.
create or replace function public.trg_check_store_shot_rule()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
declare
  v_rule public.photo_shot_rules;
begin
  select * into v_rule
  from public.photo_shot_rules r
  where r.category = new.category and r.shot_type = new.shot_type;

  if v_rule.is_main then
    raise exception 'The main shot of a category is always required';
  end if;

  if v_rule.requirement = 'conditional' and new.requirement not in ('conditional', 'off') then
    raise exception 'Shot "%" only applies when asked for, or not at all', new.shot_type;
  end if;

  if v_rule.requirement <> 'conditional' and new.requirement = 'conditional' then
    raise exception 'Shot "%" has no question to make it conditional on', new.shot_type;
  end if;

  new.updated_at := now();
  return new;
end;
$function$;

create trigger store_shot_rules_check
  before insert or update on public.store_shot_rules
  for each row execute function public.trg_check_store_shot_rule();

-- ── THE RULES AS ONE STORE SEES THEM ─────────────────────────────────────────

-- The single answer to "what does this store need for this category", read by
-- the WhatsApp intake (worker/routes/waha.js) to ask for the right shots, and
-- by listing_draft_missing_shots() below to decide when an item is ready, so
-- the two cannot disagree. Shots switched off are left out entirely.
--
-- SECURITY INVOKER: called by a signed-in member, RLS on store_shot_rules
-- shows them their own store's overrides and nobody else's — a different
-- store's id just gets the defaults back.
create or replace function public.store_shot_rules_for(p_tenant_id uuid, p_category text default null)
returns table (
  category text,
  shot_type text,
  label text,
  prompt text,
  requirement text,
  condition_flag text,
  is_main boolean,
  sort_order integer
)
language sql
stable
set search_path = public, pg_temp
as $function$
  select r.category, r.shot_type, r.label, r.prompt,
         coalesce(o.requirement, r.requirement),
         r.condition_flag, r.is_main, r.sort_order
  from public.photo_shot_rules r
  left join public.store_shot_rules o
    on o.tenant_id = p_tenant_id and o.category = r.category and o.shot_type = r.shot_type
  where (p_category is null or r.category = p_category)
    and coalesce(o.requirement, r.requirement) <> 'off'
  order by r.category, r.sort_order;
$function$;

-- 0038's function, now reading the store's overrides. Same shape, same
-- callers (refresh_listing_draft); only the requirement is the store's.
create or replace function public.listing_draft_missing_shots(p_draft_id uuid)
returns text[]
language sql
stable
set search_path to 'public'
as $function$
  select coalesce(array_agg(r.shot_type order by r.sort_order), '{}')
  from public.listing_drafts d
  join public.photo_shot_rules r on r.category = d.category
  left join public.store_shot_rules o
    on o.tenant_id = d.tenant_id and o.category = r.category and o.shot_type = r.shot_type
  where d.id = p_draft_id
    and (
      coalesce(o.requirement, r.requirement) = 'required'
      or (coalesce(o.requirement, r.requirement) = 'conditional' and r.condition_flag = any (d.flags))
    )
    and not exists (
      select 1 from public.listing_photos p
      where p.draft_id = d.id and p.shot_type = r.shot_type and p.status = 'passed'
    )
    and not exists (
      select 1 from public.listing_shot_exceptions e
      where e.draft_id = d.id and e.shot_type = r.shot_type
    );
$function$;

-- A changed rule applies to items still waiting on photos: relaxing one can
-- make an item complete on the spot, tightening one adds to what it waits for.
-- A 'ready' item is left alone — it is filed within the minute.
--
-- SECURITY DEFINER because the owner changes these from the dashboard, as
-- `authenticated`, which 0038 took EXECUTE on refresh_listing_draft away from.
create or replace function public.trg_store_shot_rules_refresh()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_tenant uuid := coalesce(new.tenant_id, old.tenant_id);
  v_category text := coalesce(new.category, old.category);
  v_draft uuid;
begin
  for v_draft in
    select d.id from public.listing_drafts d
    where d.tenant_id = v_tenant and d.category = v_category and d.status = 'awaiting_photos'
  loop
    perform public.refresh_listing_draft(v_draft);
  end loop;
  return null;
end;
$function$;

create trigger store_shot_rules_refresh
  after insert or update or delete on public.store_shot_rules
  for each row execute function public.trg_store_shot_rules_refresh();

-- ── WHO MAY READ AND CHANGE THEM ─────────────────────────────────────────────

alter table public.store_photo_categories enable row level security;
alter table public.store_shot_rules enable row level security;

create policy "team reads photo categories" on public.store_photo_categories
  for select to authenticated using (tenant_id in (select public.current_tenant_ids()));

create policy "owner sets photo categories" on public.store_photo_categories
  for all to authenticated
  using (public.has_tenant_role(tenant_id, array['owner']::staff_role[]))
  with check (public.has_tenant_role(tenant_id, array['owner']::staff_role[]));

create policy "team reads shot rules" on public.store_shot_rules
  for select to authenticated using (tenant_id in (select public.current_tenant_ids()));

create policy "owner sets shot rules" on public.store_shot_rules
  for all to authenticated
  using (public.has_tenant_role(tenant_id, array['owner']::staff_role[]))
  with check (public.has_tenant_role(tenant_id, array['owner']::staff_role[]));

-- The grants the policies need and nothing more (0006, 0013).
revoke all on public.store_photo_categories, public.store_shot_rules from anon, authenticated;
grant select, insert, update, delete on public.store_photo_categories, public.store_shot_rules to authenticated;

revoke execute on function
  public.store_shot_rules_for(uuid, text),
  public.trg_check_store_shot_rule(),
  public.trg_store_shot_rules_refresh()
  from public, anon, authenticated;

-- The dashboard and the Worker both read the merged rules.
grant execute on function public.store_shot_rules_for(uuid, text) to authenticated, service_role;
grant execute on function
  public.trg_check_store_shot_rule(),
  public.trg_store_shot_rules_refresh()
  to service_role;
