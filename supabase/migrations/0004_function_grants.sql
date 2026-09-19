-- Close the default EXECUTE grant.
--
-- Postgres grants EXECUTE on every new function to PUBLIC, which in a Supabase
-- project means `anon` — and `anon` reaches the whole public schema over REST
-- at /rest/v1/rpc/<name>. So every helper in 0001–0003 shipped callable by
-- anybody with the project URL, without signing in. Nothing in those files
-- said so; it is the default, and defaults do not show up in a diff.
--
-- The one that matters is seed_tenant_features(): SECURITY DEFINER, it writes,
-- and it takes the tier as an argument. An anonymous caller who knew a tenant
-- uuid could seed it to 'business'. `on conflict do nothing` blunts that on an
-- already-seeded tenant, but a tenant row that exists before its flags do —
-- a provisioning failure, or the gap between two statements — would take the
-- flags an attacker chose. tenant_has_feature() is milder and still wrong: it
-- reports any tenant's flags to anyone who can name the uuid.
--
-- Revoke everything, then grant back one function at a time, deliberately.

alter function public.touch_updated_at() set search_path = pg_catalog, pg_temp;

revoke execute on function public.current_tenant_ids() from public;
revoke execute on function public.has_tenant_role(uuid, staff_role[]) from public;
revoke execute on function public.tenant_has_feature(uuid, text) from public;
revoke execute on function public.seed_tenant_features(uuid, tenant_tier) from public;
revoke execute on function public.channel_status(uuid) from public;
revoke execute on function public.public_product(text) from public;
revoke execute on function public.touch_updated_at() from public;

-- These two are named inside RLS policies, and a policy is evaluated with the
-- caller's own privileges: without EXECUTE the query fails outright with
-- "permission denied for function current_tenant_ids" rather than returning no
-- rows. Verified against Postgres 16 — revoking these from `authenticated`
-- takes down every screen in the dashboard.
grant execute on function public.current_tenant_ids() to authenticated;
grant execute on function public.has_tenant_role(uuid, staff_role[]) to authenticated;

-- Called directly by the Channels screen. Its own tenant check is in the WHERE
-- clause, so a signed-in caller naming somebody else's tenant gets nothing.
grant execute on function public.channel_status(uuid) to authenticated;

-- The one function that is supposed to answer a stranger: a shared product
-- link has no session behind it.
grant execute on function public.public_product(text) to anon, authenticated;

-- seed_tenant_features() and tenant_has_feature() get no client grant at all.
-- Provisioning runs under the service key in the Worker, and the dashboard
-- reads flags from the tenant_features rows it is already allowed to select.
--
-- touch_updated_at() gets none either. Postgres does not check EXECUTE when
-- firing a trigger, so the triggers keep working with no grant to anyone.
