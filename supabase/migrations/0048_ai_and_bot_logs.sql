-- What the platform console needs to show the AI's work and the bot's chats.
--
-- 1. ai_usage keeps what was asked and what came back: `prompt` (the text
--    sent with the photos — the photos themselves stay in their bucket) and
--    `response` (the model's answer as it arrived). Written by the
--    photo-review service with the token counts it already records.
-- 2. bot_messages.source says who sent an outgoing message when it wasn't
--    the Worker: 'photo_review' for the review service's WhatsApp replies,
--    which it now logs too. Null is the Worker's bot, as every row so far.
-- 3. ai_usage_totals(): calls, tokens and cost for today (Lagos), the last
--    7 and 30 days and all time, for the console's summary.
--
-- Both tables stay out of reach of anon and signed-in users (0013, 0042);
-- the console reads them through the Worker as an operator.

alter table public.ai_usage
  add column if not exists prompt text,
  add column if not exists response text;

alter table public.bot_messages
  add column if not exists source text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ai_usage_prompt_length') then
    alter table public.ai_usage add constraint ai_usage_prompt_length check (char_length(prompt) <= 20000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_usage_response_length') then
    alter table public.ai_usage add constraint ai_usage_response_length check (char_length(response) <= 60000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bot_messages_source_known') then
    alter table public.bot_messages add constraint bot_messages_source_known check (source in ('photo_review'));
  end if;
end $$;

create or replace function public.ai_usage_totals(p_tenant_id uuid default null)
returns table (
  period text,
  calls bigint,
  images bigint,
  input_tokens bigint,
  cached_tokens bigint,
  output_tokens bigint,
  cost_usd numeric,
  unpriced_calls bigint
)
language sql
stable
set search_path = public, pg_temp
as $$
  with windows(period, since, ord) as (
    values
      ('today', (date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos'), 1),
      ('7d',    now() - interval '7 days', 2),
      ('30d',   now() - interval '30 days', 3),
      ('all',   '-infinity'::timestamptz, 4)
  )
  select w.period,
         count(u.id),
         coalesce(sum(u.images), 0),
         coalesce(sum(u.input_tokens), 0),
         coalesce(sum(u.cached_tokens), 0),
         coalesce(sum(u.output_tokens), 0),
         coalesce(sum(u.cost_usd), 0),
         count(u.id) filter (where u.cost_usd is null)
  from windows w
  left join public.ai_usage u
    on u.created_at >= w.since
   and (p_tenant_id is null or u.tenant_id = p_tenant_id)
  group by w.period, w.ord
  order by w.ord;
$$;

revoke all on function public.ai_usage_totals(uuid) from public, anon, authenticated;
grant execute on function public.ai_usage_totals(uuid) to service_role;
