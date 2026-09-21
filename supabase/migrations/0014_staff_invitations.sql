-- Inviting a colleague.
--
-- The Team screen could list staff and never add one, because adding one is
-- the single thing a browser cannot do here: a membership needs a user_id, and
-- turning an email address into a user_id means reading auth.users, which is
-- not in the exposed schema and carries the password hash and every recovery
-- token. So the button sat disabled with a tooltip pointing at the README.
--
-- Two pieces close that: somewhere to put the person's name, and a way for the
-- Worker (and only the Worker) to resolve an email.

-- ── WHO THE MEMBERSHIP IS ────────────────────────────────────────────────────

-- Names live here rather than being joined out of auth.users, which is the
-- decision fetchStaff() already documents. What a colleague needs to see of a
-- colleague is a name and an email; everything else on the auth row is either
-- a secret or nobody's business.
--
-- Note what this exposes. The policy "members read their colleagues" lets any
-- member read every row for their own tenant, so junior staff can see the
-- owner's email. That is what a team screen is for, and it is worth saying out
-- loud rather than discovering: these two columns are visible to everyone in
-- the store, and nothing more private should be added beside them.
alter table public.tenant_members
  add column display_name text,
  add column email text,

  -- Who added them, and when they were asked as opposed to when they arrived.
  -- `accepted_at` is null for somebody who has been sent a link and has not
  -- used it yet, which is the difference between "invited" and "on the team"
  -- and the only way the screen can show a pending row honestly.
  add column invited_by uuid references auth.users(id) on delete set null,
  add column invited_at timestamptz,
  add column accepted_at timestamptz;

-- ── EMAIL → USER ─────────────────────────────────────────────────────────────

-- The one lookup the invitation flow needs, and nothing else.
--
-- Returns a uuid or null. It cannot be used to read anything about the
-- account, list accounts, or test more than one address per call, which is
-- what keeps it a narrow tool rather than a window into auth.users.
--
-- search_path is pinned to pg_catalog, and auth.users is written out in full:
-- a SECURITY DEFINER function that resolves its own table names through a
-- caller-controlled search_path is a privilege escalation waiting to be
-- written up.
create or replace function public.user_id_for_email(addr text)
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select u.id
  from auth.users u
  where lower(u.email) = lower(btrim(addr))
  limit 1;
$$;

-- Nobody but the Worker. The revoke covers all three spellings for the reason
-- 0004 and 0005 exist: a new function in `public` gets a PUBLIC grant from
-- Postgres *and* explicit grants to anon and authenticated from Supabase's
-- defaults, and revoking from PUBLIC alone leaves the other two in place.
--
-- service_role is not named here and keeps its grant, which is the whole
-- point -- it is what the Worker connects as.
revoke execute on function public.user_id_for_email(text) from public, anon, authenticated;
