-- 0004 was not enough, and the reason is worth writing down.
--
-- A new function in `public` on Supabase ends up with two separate EXECUTE
-- grants:
--
--     =X/postgres              <- PUBLIC, from Postgres itself
--     anon=X/postgres          <- explicit, from Supabase's default privileges
--     authenticated=X/postgres <- explicit, same
--     service_role=X/postgres  <- explicit, same
--
-- 0004 ran `revoke execute ... from public`, which removed the first line and
-- nothing else. A revoke from PUBLIC does not touch a grant made to a named
-- role, so `anon` kept its own. Every helper stayed callable without signing
-- in, and the database linter went on reporting exactly that.
--
-- This is also a warning about testing against plain Postgres: a stub database
-- with hand-made `anon` and `authenticated` roles has only the PUBLIC grant,
-- so 0004 passed there. The explicit grants only exist on a real project.
-- The linter caught what the local run could not.

-- Named roles this time, not PUBLIC.
revoke execute on function public.current_tenant_ids() from anon;
revoke execute on function public.has_tenant_role(uuid, staff_role[]) from anon;
revoke execute on function public.channel_status(uuid) from anon;

-- Neither role has any business calling these. seed_tenant_features() is the
-- one that actually mattered: SECURITY DEFINER, it writes, and it takes the
-- tier as an argument, so a caller who knew a tenant uuid could hand it
-- 'business'. Provisioning runs under the service key, which keeps its own
-- explicit grant and is unaffected by everything here.
revoke execute on function public.seed_tenant_features(uuid, tenant_tier) from anon, authenticated;
revoke execute on function public.tenant_has_feature(uuid, text) from anon, authenticated;

-- Fires from a trigger, which Postgres runs without checking EXECUTE.
revoke execute on function public.touch_updated_at() from anon, authenticated;

-- What remains, deliberately:
--
--   public_product(text)       anon + authenticated — a shared product link
--                              has no session behind it, and this is the only
--                              reason the anon key exists in this app
--   current_tenant_ids()       authenticated — named inside every RLS policy,
--                              and a policy is evaluated with the caller's own
--                              privileges: revoke this and every screen dies
--                              with "permission denied for function"
--   has_tenant_role(...)       authenticated — same, for the role-scoped
--                              policies on buyers, orders, offers and payouts
--   channel_status(uuid)       authenticated — the Channels screen calls it
--                              directly; its tenant check is in the WHERE
--
-- public.rls_auto_enable() is left exactly as it is. It belongs to Supabase,
-- not to this schema: an event-trigger function that enables RLS on newly
-- created public tables. Its body reads pg_event_trigger_ddl_commands(), which
-- returns nothing outside an event-trigger context, so calling it over REST
-- does nothing at all. The linter will keep listing it; that is Supabase
-- reporting its own default, and revoking grants on a platform-managed object
-- is how you break the next platform upgrade.
