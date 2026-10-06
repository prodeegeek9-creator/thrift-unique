-- One photo can count for every shot it shows.
--
-- Each photo had one shot_type, so a phone's front with a cracked screen was
-- labelled either "front" or "flaw", never both — and on the first real test
-- the AI picked "flaw", the seller was told "Still need: Front", and sending
-- the same photo again was refused as a duplicate. There was no way through
-- but a new photo of something already photographed.
--
-- also_shot_types holds the other shots a passed photo shows, set by the
-- photo-review service alongside shot_type. A required shot is covered by a
-- passed photo whose shot_type is it, or whose also_shot_types include it.

alter table public.listing_photos
  add column if not exists also_shot_types text[] not null default '{}';

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
      where p.draft_id = d.id
        and p.status = 'passed'
        and (p.shot_type = r.shot_type or r.shot_type = any (p.also_shot_types))
    )
    and not exists (
      select 1 from public.listing_shot_exceptions e
      where e.draft_id = d.id and e.shot_type = r.shot_type
    );
$function$;

-- The draft is re-checked when a photo's extra shots change, as it already
-- is for its status and shot_type.
create or replace trigger listing_photos_refresh_draft
  after insert or delete or update of status, shot_type, also_shot_types, draft_id on public.listing_photos
  for each row execute function public.trg_listing_child_refresh_draft();
