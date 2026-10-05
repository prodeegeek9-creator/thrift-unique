-- Pin search_path on the photo-review trigger functions 0038 carried over as
-- they were made by hand. Supabase's linter flags a function whose name
-- lookups follow the caller's search_path; these only call fully qualified
-- names, so pinning changes nothing they do — it just takes the question off
-- the table.
alter function public.trg_listing_drafts_touch() set search_path = public, pg_temp;
alter function public.trg_listing_drafts_refresh_self() set search_path = public, pg_temp;
alter function public.trg_listing_child_refresh_draft() set search_path = public, pg_temp;
