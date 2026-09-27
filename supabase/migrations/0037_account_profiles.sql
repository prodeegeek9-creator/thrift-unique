-- Who is behind an account: name, phone and address.
--
-- Asked for when an account is made on the web (src/pages/Signup.jsx), and
-- on the "Set up your store" page for anybody who came in without them: a
-- Google sign-in brings a name and nothing else (src/pages/Onboarding.jsx).
-- The operator sees them on a store waiting for approval
-- (worker/routes/admin.js tenantView).
--
-- The sign-up form hands the details to Supabase with the account itself
-- (auth.signUp's options.data, stored as raw_user_meta_data), and the trigger
-- below copies them in when the account is created. So they are kept even
-- when the account waits on an emailed confirmation link, before the person
-- has a session to save anything with.
create table public.account_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text check (full_name is null or length(full_name) between 1 and 120),
  -- Digits with the country code, like tenants.whatsapp_number (0016).
  phone text check (phone is null or phone ~ '^[1-9][0-9]{9,14}$'),
  address text check (address is null or length(address) between 1 and 300),
  city text check (city is null or length(city) between 1 and 80),
  state text check (state is null or length(state) between 1 and 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A phone number as typed, as the digits the rest of the system stores: the
-- rules of 0016, and worker/lib/phone.js. Anything that still isn't a
-- plausible number comes back as it is, for the check above to refuse.
create or replace function public.phone_digits(raw text)
returns text
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  digits text := nullif(regexp_replace(coalesce(raw, ''), '\D', '', 'g'), '');
begin
  if digits like '00%' then
    digits := substr(digits, 3);
  end if;
  if length(digits) = 11 and left(digits, 1) = '0' then
    digits := '234' || substr(digits, 2);
  end if;
  return digits;
end;
$$;

-- Tidy on the way in, for every writer: blank means not given, and the phone
-- is stored the one way it can be matched.
create or replace function public.account_profiles_tidy()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  new.full_name := nullif(btrim(new.full_name), '');
  new.phone := public.phone_digits(new.phone);
  new.address := nullif(btrim(new.address), '');
  new.city := nullif(btrim(new.city), '');
  new.state := nullif(btrim(new.state), '');
  new.updated_at := now();
  return new;
end;
$$;

create trigger account_profiles_tidy
  before insert or update on public.account_profiles
  for each row execute function public.account_profiles_tidy();

-- A new account's details, from what it was made with. Never allowed to stop
-- the account being made: details that don't fit are left for the person to
-- fill in on the onboarding page, which asks for anything missing.
create or replace function public.account_profile_from_signup()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
begin
  begin
    insert into public.account_profiles (user_id, full_name, phone, address, city, state)
    values (
      new.id,
      left(coalesce(meta ->> 'full_name', meta ->> 'name'), 120),
      meta ->> 'phone',
      left(meta ->> 'address', 300),
      left(meta ->> 'city', 80),
      left(meta ->> 'state', 40)
    )
    on conflict (user_id) do nothing;
  exception when others then
    begin
      -- The phone, most likely. Keep the rest.
      insert into public.account_profiles (user_id, full_name, address, city, state)
      values (
        new.id,
        left(coalesce(meta ->> 'full_name', meta ->> 'name'), 120),
        left(meta ->> 'address', 300),
        left(meta ->> 'city', 80),
        left(meta ->> 'state', 40)
      )
      on conflict (user_id) do nothing;
    exception when others then
      null;
    end;
  end;
  return new;
end;
$$;

create trigger on_auth_user_created_profile
  after insert on auth.users
  for each row execute function public.account_profile_from_signup();

-- Only the triggers call these.
revoke execute on function public.account_profile_from_signup() from public, anon, authenticated;
revoke execute on function public.account_profiles_tidy() from public, anon, authenticated;

-- Each person reads and writes their own row, and nobody else's. The Worker
-- reads them under the service key, for the operator's console.
alter table public.account_profiles enable row level security;
revoke all on public.account_profiles from anon, authenticated;
grant select on public.account_profiles to authenticated;
grant insert (user_id, full_name, phone, address, city, state) on public.account_profiles to authenticated;
grant update (full_name, phone, address, city, state) on public.account_profiles to authenticated;

create policy account_profiles_select_own on public.account_profiles
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy account_profiles_insert_own on public.account_profiles
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy account_profiles_update_own on public.account_profiles
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Accounts made before this: their name, where the sign-in brought one.
insert into public.account_profiles (user_id, full_name)
select u.id, left(coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name'), 120)
from auth.users u
on conflict (user_id) do nothing;
