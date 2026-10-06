-- What the AI makes of the item itself, not just each photo.
--
-- The review call that labels a draft's photos now also describes the item:
-- what it looks like, whether it has a screen, whether it fits the category
-- the seller chose, and any visible problems (dirty, stained, damaged, worn,
-- missing parts). Same call, so no extra cost.
--
-- 1. listing_drafts.ai_item holds that read, written by the photo-review
--    service. Its first read decides has_screen; problems found in later
--    calls are added to it.
-- 2. submissions.ai_issues / ai_note carry it to the store's review queue,
--    filled by routes/photoReview.js when the item is filed. A flag for the
--    owner, never a reason to refuse a photo: a clear photo of a dirty item
--    is an honest photo.
-- 3. A gadget's "Screen on" photo is asked for only when the item has one.
--    It was required of every gadget, so a TV remote or a charger could never
--    finish. The seller isn't asked; the AI decides from the photos (the
--    has_screen flag), and the seller is told "if it has a screen".

alter table public.listing_drafts add column if not exists ai_item jsonb;

alter table public.submissions
  add column if not exists ai_issues text[] not null default '{}',
  add column if not exists ai_note text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'submissions_ai_issues_known') then
    alter table public.submissions add constraint submissions_ai_issues_known
      check (ai_issues <@ array['dirty', 'stained', 'damaged', 'worn', 'missing_parts']::text[]);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'submissions_ai_note_length') then
    alter table public.submissions add constraint submissions_ai_note_length
      check (char_length(ai_note) <= 500);
  end if;
end $$;

update public.photo_shot_rules
   set requirement = 'conditional', condition_flag = 'has_screen'
 where category = 'gadgets' and shot_type = 'screen_on' and requirement = 'required';

-- A store that had set this shot to Required or Optional now holds a choice
-- the rule no longer allows (0041: a conditional shot is on or off).
-- Required meant "always ask", which is now "ask when it has a screen".
update public.store_shot_rules
   set requirement = 'conditional'
 where category = 'gadgets' and shot_type = 'screen_on'
   and requirement in ('required', 'optional');

-- Gadgets already waiting on photos stop waiting for a screen they may not
-- have.
select public.refresh_listing_draft(id)
  from public.listing_drafts
 where category = 'gadgets' and status = 'awaiting_photos';
