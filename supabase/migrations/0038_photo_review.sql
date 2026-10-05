-- Photo review: the shots each kind of item needs, and an item's photos on
-- their way to becoming a submission.
--
-- These tables were first created by hand, straight on the live database, for
-- the photo-check and photo-review services that run on their own server
-- (see "Vendwyze and Unique Thrift are the same project" in the README). This
-- file brings them into the repo so the schema is reviewable and rebuildable.
-- Every statement is written to be a no-op against the live database, which
-- already has them — except the grants at the bottom, which are the point.
--
-- How an item flows:
--
--   1. The WhatsApp intake (worker/lib/photoIntake.js) collects the details
--      and inserts a listing_drafts row: category, flags, and the details in
--      `extracted`, tagged source = 'sell'.
--   2. Each photo goes to the photo-check service, which runs plain-code
--      checks (size, light, blur, near-duplicates) and inserts a
--      listing_photos row: 'rejected' with a reason, or 'pending'.
--   3. The photo-review worker labels pending photos' shot types with a
--      vision model and marks them 'passed' or 'rejected'.
--   4. The triggers below recompute the draft's missing_shots and flip it to
--      'ready' once every required shot has passed.
--   5. The Worker's minute cron (worker/routes/photoReview.js) turns a ready
--      draft into a submissions row and marks the draft 'published' — handed
--      to the store's review queue. Everything after that is the existing
--      submission path, unchanged.

-- ── CATEGORIES AND SHOT RULES ────────────────────────────────────────────────

create table if not exists public.photo_categories (
  slug text primary key check (slug ~ '^[a-z0-9_]{2,40}$'),
  name text not null,
  min_width integer not null default 600 check (min_width > 0),
  min_height integer not null default 600 check (min_height > 0),
  min_blur_score numeric not null default 100 check (min_blur_score >= 0),
  min_brightness numeric not null default 40 check (min_brightness >= 0 and min_brightness <= 255),
  max_brightness numeric not null default 220 check (max_brightness >= 0 and max_brightness <= 255),
  dup_max_distance integer not null default 6 check (dup_max_distance >= 0 and dup_max_distance <= 64),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (min_brightness < max_brightness)
);

-- requirement: 'required' always counts; 'conditional' counts only when the
-- draft carries condition_flag (e.g. has_flaws); 'optional' never blocks.
create table if not exists public.photo_shot_rules (
  category text not null references public.photo_categories(slug) on update cascade on delete cascade,
  shot_type text not null check (shot_type ~ '^[a-z0-9_]{2,40}$'),
  label text not null,
  prompt text not null,
  requirement text not null check (requirement in ('required', 'optional', 'conditional')),
  condition_flag text,
  skippable boolean not null default true,
  is_main boolean not null default false,
  sort_order integer not null default 0,
  primary key (category, shot_type),
  check ((requirement = 'conditional') = (condition_flag is not null)),
  check (not is_main or (requirement = 'required' and not skippable))
);

create unique index if not exists photo_shot_rules_one_main
  on public.photo_shot_rules (category) where is_main;

-- ── DRAFTS, PHOTOS, SKIPPED SHOTS ────────────────────────────────────────────

create table if not exists public.listing_drafts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  seller_chat_id text not null,
  category text not null references public.photo_categories(slug) on update cascade,
  flags text[] not null default '{}',
  extracted jsonb not null default '{}',
  status text not null default 'awaiting_photos'
    check (status in ('awaiting_photos', 'ready', 'published', 'expired', 'cancelled')),
  missing_shots text[] not null default '{}',
  reminder_count integer not null default 0 check (reminder_count >= 0),
  last_reminder_at timestamptz,
  expires_at timestamptz not null default (now() + interval '3 days'),
  product_id uuid references public.products(id) on delete set null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, tenant_id)
);

-- One item in progress per person per store.
create unique index if not exists listing_drafts_one_open_per_seller
  on public.listing_drafts (tenant_id, seller_chat_id)
  where status in ('awaiting_photos', 'ready');

create index if not exists listing_drafts_expiry_idx
  on public.listing_drafts (expires_at) where status = 'awaiting_photos';

create table if not exists public.listing_photos (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  draft_id uuid not null,
  -- The WhatsApp message id: a retried webhook collides instead of adding the
  -- same photo twice.
  source_message_id text not null,
  -- In the private listing-photos bucket. Copied to product-images when the
  -- draft becomes a submission.
  storage_path text not null,
  width integer check (width > 0),
  height integer check (height > 0),
  blur_score numeric,
  brightness numeric,
  phash bit(64),
  shot_type text,
  ai_confidence numeric check (ai_confidence >= 0 and ai_confidence <= 1),
  ai_notes text check (char_length(ai_notes) <= 500),
  status text not null default 'pending'
    check (status in ('pending', 'checking', 'passed', 'rejected')),
  reject_reason text check (reject_reason in (
    'blurry', 'too_dark', 'too_bright', 'too_small', 'duplicate', 'wrong_angle',
    'not_product', 'multiple_products', 'screenshot', 'unreadable', 'other'
  )),
  attempts integer not null default 0 check (attempts >= 0),
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, source_message_id),
  foreign key (draft_id, tenant_id) references public.listing_drafts(id, tenant_id) on delete cascade,
  check ((status = 'rejected') = (reject_reason is not null)),
  check (status <> 'passed' or shot_type is not null)
);

create index if not exists listing_photos_draft_idx on public.listing_photos (draft_id);
create index if not exists listing_photos_queue_idx
  on public.listing_photos (created_at) where status = 'pending';
create index if not exists listing_photos_phash_idx
  on public.listing_photos (tenant_id) where phash is not null;

create table if not exists public.listing_shot_exceptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  draft_id uuid not null unique,
  shot_type text not null,
  reason text not null check (reason in ('no_label', 'does_not_power_on', 'not_applicable', 'other')),
  public_note text not null check (char_length(public_note) between 3 and 140),
  created_at timestamptz not null default now(),
  foreign key (draft_id, tenant_id) references public.listing_drafts(id, tenant_id) on delete cascade
);

-- ── KEEPING A DRAFT'S STATE TRUE ─────────────────────────────────────────────

create or replace function public.listing_draft_missing_shots(p_draft_id uuid)
returns text[]
language sql
stable
set search_path to 'public'
as $function$
  select coalesce(array_agg(r.shot_type order by r.sort_order), '{}')
  from public.listing_drafts d
  join public.photo_shot_rules r on r.category = d.category
  where d.id = p_draft_id
    and (
      r.requirement = 'required'
      or (r.requirement = 'conditional' and r.condition_flag = any (d.flags))
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

-- Only ever moves a draft between 'awaiting_photos' and 'ready'. 'published',
-- 'expired' and 'cancelled' are final and left alone.
create or replace function public.refresh_listing_draft(p_draft_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_missing text[];
begin
  v_missing := public.listing_draft_missing_shots(p_draft_id);

  update public.listing_drafts d
     set missing_shots = v_missing,
         status = case
                    when d.status not in ('awaiting_photos','ready') then d.status
                    when cardinality(v_missing) = 0 then 'ready'
                    else 'awaiting_photos'
                  end
   where d.id = p_draft_id;
end;
$function$;

create or replace function public.find_similar_photos(p_photo_id uuid, p_max_distance integer default null)
returns table(photo_id uuid, draft_id uuid, distance integer)
language sql
stable
set search_path to 'public'
as $function$
  with me as (
    select p.id, p.tenant_id, p.phash, p.created_at,
           coalesce(p_max_distance, c.dup_max_distance) as max_d
    from public.listing_photos p
    join public.listing_drafts d   on d.id = p.draft_id
    join public.photo_categories c on c.slug = d.category
    where p.id = p_photo_id and p.phash is not null
  )
  select o.id, o.draft_id, bit_count(o.phash # me.phash)::int
  from me
  join public.listing_photos o
    on o.tenant_id = me.tenant_id
   and o.id <> me.id
   and (o.created_at < me.created_at or (o.created_at = me.created_at and o.id < me.id))
  where o.phash is not null
    and o.status <> 'rejected'
    and bit_count(o.phash # me.phash) <= me.max_d
  order by 3
  limit 5;
$function$;

create or replace function public.expire_stale_listing_drafts()
returns integer
language sql
set search_path to 'public'
as $function$
  with x as (
    update public.listing_drafts
       set status = 'expired'
     where status = 'awaiting_photos' and expires_at < now()
    returning 1
  )
  select count(*)::int from x;
$function$;

create or replace function public.trg_listing_drafts_touch()
returns trigger
language plpgsql
as $function$
begin
  new.updated_at := now();
  return new;
end;
$function$;

create or replace function public.trg_listing_drafts_refresh_self()
returns trigger
language plpgsql
as $function$
begin
  perform public.refresh_listing_draft(new.id);
  return null;
end;
$function$;

create or replace function public.trg_listing_child_refresh_draft()
returns trigger
language plpgsql
as $function$
begin
  if tg_op in ('UPDATE','DELETE') then
    perform public.refresh_listing_draft(old.draft_id);
  end if;
  if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.draft_id is distinct from old.draft_id) then
    perform public.refresh_listing_draft(new.draft_id);
  end if;
  return null;
end;
$function$;

create or replace function public.trg_check_shot_exception()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_category text;
  v_rule     public.photo_shot_rules;
begin
  select d.category into v_category
  from public.listing_drafts d where d.id = new.draft_id;

  select * into v_rule
  from public.photo_shot_rules r
  where r.category = v_category and r.shot_type = new.shot_type;

  if not found then
    raise exception 'Shot "%" is not a rule for category "%"', new.shot_type, v_category;
  end if;

  if not v_rule.skippable then
    raise exception 'Shot "%" cannot be skipped', new.shot_type;
  end if;

  if v_rule.requirement = 'optional' then
    raise exception 'Shot "%" is optional, nothing to skip', new.shot_type;
  end if;

  return new;
end;
$function$;

create or replace trigger listing_drafts_touch
  before update on public.listing_drafts
  for each row execute function public.trg_listing_drafts_touch();

create or replace trigger listing_drafts_refresh_self
  after insert or update of category, flags on public.listing_drafts
  for each row execute function public.trg_listing_drafts_refresh_self();

create or replace trigger listing_photos_refresh_draft
  after insert or delete or update of status, shot_type, draft_id on public.listing_photos
  for each row execute function public.trg_listing_child_refresh_draft();

create or replace trigger listing_shot_exceptions_check
  before insert or update on public.listing_shot_exceptions
  for each row execute function public.trg_check_shot_exception();

create or replace trigger listing_shot_exceptions_refresh_draft
  after insert or delete or update on public.listing_shot_exceptions
  for each row execute function public.trg_listing_child_refresh_draft();

-- ── RLS ──────────────────────────────────────────────────────────────────────

alter table public.photo_categories enable row level security;
alter table public.photo_shot_rules enable row level security;
alter table public.listing_drafts enable row level security;
alter table public.listing_photos enable row level security;
alter table public.listing_shot_exceptions enable row level security;

drop policy if exists "photo_categories read" on public.photo_categories;
create policy "photo_categories read" on public.photo_categories
  for select to authenticated using (true);

drop policy if exists "photo_shot_rules read" on public.photo_shot_rules;
create policy "photo_shot_rules read" on public.photo_shot_rules
  for select to authenticated using (true);

drop policy if exists "listing_drafts member read" on public.listing_drafts;
create policy "listing_drafts member read" on public.listing_drafts
  for select to authenticated using (
    exists (select 1 from public.tenant_members m
            where m.tenant_id = listing_drafts.tenant_id and m.user_id = (select auth.uid()))
  );

drop policy if exists "listing_photos member read" on public.listing_photos;
create policy "listing_photos member read" on public.listing_photos
  for select to authenticated using (
    exists (select 1 from public.tenant_members m
            where m.tenant_id = listing_photos.tenant_id and m.user_id = (select auth.uid()))
  );

drop policy if exists "listing_shot_exceptions member read" on public.listing_shot_exceptions;
create policy "listing_shot_exceptions member read" on public.listing_shot_exceptions
  for select to authenticated using (
    exists (select 1 from public.tenant_members m
            where m.tenant_id = listing_shot_exceptions.tenant_id and m.user_id = (select auth.uid()))
  );

-- ── GRANTS ───────────────────────────────────────────────────────────────────
--
-- Created by hand, these tables kept Supabase's default grants: INSERT,
-- UPDATE, DELETE and TRUNCATE for every signed-in user, held back only by RLS
-- (and TRUNCATE is not subject to RLS at all). The rule this repo learned the
-- hard way (0006, 0013): a grant that does not exist cannot be reached by a
-- policy mistake. Signed-in users read; only the service key writes.

revoke all on public.photo_categories, public.photo_shot_rules, public.listing_drafts,
  public.listing_photos, public.listing_shot_exceptions
  from anon, authenticated;
grant select on public.photo_categories, public.photo_shot_rules, public.listing_drafts,
  public.listing_photos, public.listing_shot_exceptions
  to authenticated;

-- And the functions. refresh_listing_draft is SECURITY DEFINER and writes, and
-- was callable without signing in — the same trap 0004/0005 describe. Two
-- separate grants have to go: the PUBLIC one Postgres adds, and the explicit
-- anon/authenticated ones Supabase's default privileges add.
--
-- service_role keeps EXECUTE explicitly: the triggers run as whoever wrote
-- the row (the service key, from the Worker and the photo services), and a
-- trigger function that PERFORMs refresh_listing_draft needs EXECUTE on it at
-- that moment — the 0007/0008 lesson.
revoke execute on function
  public.listing_draft_missing_shots(uuid),
  public.refresh_listing_draft(uuid),
  public.find_similar_photos(uuid, integer),
  public.expire_stale_listing_drafts(),
  public.trg_listing_drafts_touch(),
  public.trg_listing_drafts_refresh_self(),
  public.trg_listing_child_refresh_draft(),
  public.trg_check_shot_exception()
  from public, anon, authenticated;

grant execute on function
  public.listing_draft_missing_shots(uuid),
  public.refresh_listing_draft(uuid),
  public.find_similar_photos(uuid, integer),
  public.expire_stale_listing_drafts(),
  public.trg_listing_drafts_touch(),
  public.trg_listing_drafts_refresh_self(),
  public.trg_listing_child_refresh_draft(),
  public.trg_check_shot_exception()
  to service_role;

-- ── THE PRIVATE PHOTO BUCKET ─────────────────────────────────────────────────

-- Raw seller photos, before review. Private: nothing here is public until it
-- has passed and been copied to product-images.
insert into storage.buckets (id, name, public)
values ('listing-photos', 'listing-photos', false)
on conflict (id) do nothing;

-- ── A SUBMISSION REMEMBERS ITS DRAFT ─────────────────────────────────────────

-- Unique: the cron that files a ready draft can run twice, and the second
-- insert must collide rather than file the item again.
alter table public.submissions
  add column if not exists draft_id uuid unique
    references public.listing_drafts(id) on delete set null;

-- ── THE RULES AS THEY STAND ──────────────────────────────────────────────────

insert into public.photo_categories
  (slug, name, min_width, min_height, min_blur_score, min_brightness, max_brightness, dup_max_distance, active)
values
  ('bags',     'Bags',              600, 600, 100, 40, 220, 6, true),
  ('clothing', 'Clothing',          600, 600, 100, 40, 220, 6, true),
  ('food',     'Food',              600, 600, 100, 40, 220, 6, true),
  ('gadgets',  'Gadgets',           600, 600, 100, 40, 220, 6, true),
  ('general',  'General',           600, 600, 100, 40, 220, 6, true),
  ('handmade', 'Handmade & crafts', 600, 600, 100, 40, 220, 6, true),
  ('shoes',    'Shoes',             600, 600, 100, 40, 220, 6, true)
on conflict (slug) do nothing;

insert into public.photo_shot_rules
  (category, shot_type, label, requirement, condition_flag, skippable, is_main, sort_order, prompt)
values
  ('bags', 'front', 'Front', 'required', null, false, true, 1, 'a photo of the front of the bag'),
  ('bags', 'back', 'Back', 'required', null, true, false, 2, 'a photo of the back of the bag'),
  ('bags', 'inside', 'Inside', 'required', null, true, false, 3, 'a photo of the inside of the bag'),
  ('bags', 'flaw', 'Flaw close-up', 'conditional', 'has_flaws', false, false, 4, 'a close-up of each flaw (scratch, peeling, stain)'),
  ('bags', 'logo_hardware', 'Logo/hardware', 'optional', null, true, false, 5, 'a close-up of the logo or zips/buckles (optional)'),
  ('clothing', 'front', 'Front', 'required', null, false, true, 1, 'a photo of the front of the item, laid flat or on a hanger'),
  ('clothing', 'back', 'Back', 'required', null, true, false, 2, 'a photo of the back of the item'),
  ('clothing', 'label', 'Size/brand label', 'required', null, true, false, 3, 'a close-up of the size or brand label'),
  ('clothing', 'flaw', 'Flaw close-up', 'conditional', 'has_flaws', false, false, 4, 'a close-up of each flaw (stain, tear, missing button)'),
  ('clothing', 'on_model', 'Worn on a model', 'optional', null, true, false, 5, 'a photo of someone wearing it (optional)'),
  ('food', 'product', 'Finished product', 'required', null, false, true, 1, 'a clear photo of the food itself'),
  ('food', 'packaging_label', 'Packaging label', 'conditional', 'packaged', false, false, 2, 'a photo of the packaging label'),
  ('food', 'portion_reference', 'Portion size', 'optional', null, true, false, 3, 'a photo showing the portion size, e.g. next to a spoon (optional)'),
  ('gadgets', 'front', 'Front', 'required', null, false, true, 1, 'a photo of the front of the device'),
  ('gadgets', 'back', 'Back', 'required', null, true, false, 2, 'a photo of the back of the device'),
  ('gadgets', 'screen_on', 'Screen on', 'required', null, true, false, 3, 'a photo with the screen switched on'),
  ('gadgets', 'about_screen', 'About phone', 'conditional', 'is_phone', true, false, 4, 'a photo of the About phone screen showing model and storage. Cover the IMEI'),
  ('gadgets', 'flaw', 'Flaw close-up', 'conditional', 'has_flaws', false, false, 5, 'a close-up of each flaw (crack, dent, scratch)'),
  ('gadgets', 'sides_ports', 'Sides and ports', 'optional', null, true, false, 6, 'a photo of the sides and charging port (optional)'),
  ('general', 'main', 'Main view', 'required', null, false, true, 1, 'a clear photo of the item'),
  ('handmade', 'main', 'Main view', 'required', null, false, true, 1, 'a photo of the full item'),
  ('handmade', 'detail', 'Detail close-up', 'required', null, true, false, 2, 'a close-up of the details or finishing'),
  ('handmade', 'size_reference', 'Size reference', 'optional', null, true, false, 3, 'a photo showing its size, e.g. in your hand (optional)'),
  ('shoes', 'side', 'Side view', 'required', null, false, true, 1, 'a photo of the shoe from the side'),
  ('shoes', 'sole', 'Sole', 'required', null, true, false, 2, 'a photo of the sole'),
  ('shoes', 'inside_label', 'Inside size label', 'required', null, true, false, 3, 'a close-up of the size label inside the shoe'),
  ('shoes', 'flaw', 'Flaw close-up', 'conditional', 'has_flaws', false, false, 4, 'a close-up of each flaw (scuff, crease, tear)'),
  ('shoes', 'top', 'Top view', 'optional', null, true, false, 5, 'a photo from above showing the toe box (optional)')
on conflict (category, shot_type) do nothing;
