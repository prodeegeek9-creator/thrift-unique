-- When WhatsApp last reached the Worker, per WAHA session.
--
-- The platform number once went silent for most of a day with WAHA reporting
-- the session WORKING throughout: the messages were arriving, and being turned
-- away before the Worker ran. Nothing in the database changed, so nothing
-- looked wrong. This table is the missing signal: every authorised webhook
-- touches its session's row, and the operator console shows how long ago that
-- was, beside what WAHA itself says.
--
-- It also keeps the platform session's own status, which has no tenants row
-- to live on.
create table public.webhook_activity (
  session text primary key,
  last_event_at timestamptz not null default now(),
  last_message_at timestamptz,
  last_status text
);

-- Written and read by the Worker under the service key only.
alter table public.webhook_activity enable row level security;
revoke all on public.webhook_activity from anon, authenticated;
