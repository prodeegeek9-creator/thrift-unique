-- The first tenant, run once by hand.
--
-- This is NOT a migration, and lives outside supabase/migrations/ on purpose.
-- Migrations are schema and run on every database; this is one specific
-- person's account with one specific password, and it should run exactly once,
-- on one project, by somebody who has edited the three values below.
--
-- It exists because of a chicken and egg. A tenant is normally provisioned by
-- the Worker after the WhatsApp bot has collected a business name and a tier
-- (see worker/routes/tenants.js, phase 3/4) — but the Worker does not exist
-- yet, there is no self-serve tenant creation from the browser by design, and
-- a dashboard with no tenant sends you to /onboarding forever. So the first
-- one goes in by hand and every later one goes through the bot.
--
-- Everything here is ordinary Supabase auth internals. Prefer the dashboard's
-- Authentication → Users → Add user if you only need an account; this file is
-- for when you want the account, the store, the membership and the flags in
-- one step.

\set owner_email  'you@example.com'
\set owner_name   'Your Name'
\set owner_pass   'replace-me-then-change-it-after-first-login'
\set store_slug   'your-store'
\set store_name   'Your Store'

do $$
declare
  uid uuid := gen_random_uuid();
  tid uuid;
begin
  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at,
    -- Explicit empty strings, not NULL. These columns are nullable with no
    -- default, and GoTrue scans them into Go strings — a NULL in any of them
    -- is the classic "converting NULL to string is unsupported" error at
    -- sign-in, which looks nothing like its cause.
    confirmation_token, recovery_token, email_change_token_new, email_change,
    email_change_token_current, phone_change, phone_change_token,
    reauthentication_token
  ) values (
    uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    :'owner_email',
    -- pgcrypto lives in the `extensions` schema on Supabase, not public.
    extensions.crypt(:'owner_pass', extensions.gen_salt('bf')),
    -- Confirmed on the spot: there is no inbox round trip for a seed, and an
    -- unconfirmed user cannot sign in.
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('name', :'owner_name'),
    now(), now(),
    '', '', '', '', '', '', '', ''
  );

  -- Without this the account signs in but the dashboard's user list and any
  -- later provider linking both misbehave. Note that identities.email is a
  -- generated column off identity_data, so it is not listed here — passing it
  -- fails with "cannot insert a non-DEFAULT value into column email".
  insert into auth.identities (
    provider_id, user_id, identity_data, provider, created_at, updated_at
  ) values (
    uid::text, uid,
    jsonb_build_object('sub', uid::text, 'email', :'owner_email', 'email_verified', true),
    'email', now(), now()
  );

  -- Business tier and 0% commission, because this is the platform's own store:
  -- it is the one that exercises every feature first, and it should never be
  -- the thing that discovers a flag is missing. A real customer gets the tier
  -- they paid for and a commission_pct that is not zero.
  insert into public.tenants (
    slug, name, tier, status, commission_pct,
    disclaimer_accepted_at, disclaimer_version
  ) values (
    :'store_slug', :'store_name', 'business', 'active', 0.00, now(), 'v1-owner'
  ) returning id into tid;

  insert into public.tenant_members (tenant_id, user_id, role)
  values (tid, uid, 'owner');

  perform public.seed_tenant_features(tid, 'business');
end $$;

-- Check it landed, and that the password actually verifies the way GoTrue
-- will check it at sign-in.
select t.slug, t.name, t.tier, m.role, u.email,
       (u.email_confirmed_at is not null) as confirmed,
       (u.encrypted_password = extensions.crypt(:'owner_pass', u.encrypted_password)) as password_ok,
       (select count(*) from public.tenant_features f
         where f.tenant_id = t.id and f.enabled) as flags_on
from public.tenants t
join public.tenant_members m on m.tenant_id = t.id
join auth.users u on u.id = m.user_id
where t.slug = :'store_slug';
