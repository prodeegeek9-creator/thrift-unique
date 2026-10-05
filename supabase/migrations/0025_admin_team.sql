-- The admin team, managed from the console rather than by hand in SQL.
--
-- platform_admins stays exactly as locked as 0009 made it: RLS on, no policy,
-- nothing granted to a client role. The console reads and changes it through
-- the Worker, under the service key, and only an owner-level operator can
-- change it (worker/routes/admin.js).
--
-- The email is kept on the row so the team list does not have to ask the auth
-- API about every member on every view, and so a removed-and-re-added person
-- reads the same in the audit log.

alter table public.platform_admins
  add column if not exists email text,
  add column if not exists added_by uuid references auth.users(id) on delete set null;

update public.platform_admins a
set email = lower(u.email)
from auth.users u
where u.id = a.user_id and a.email is null;
