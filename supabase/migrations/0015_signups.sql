-- A seller opening a store over WhatsApp.
--
-- The platform number answers everyone, and somebody whose number belongs to
-- no store is asked for a business name and an email. That conversation needs
-- somewhere to live before any store exists, which rules out
-- bot_conversations: it is scoped by tenant_id, and there is no tenant yet.
--
-- The row lives on, as 'pending', after the store has been created: the email
-- is held here rather than turned into an account straight away, so a sign-up
-- the operator rejects leaves no login behind. Approval (worker/routes/
-- admin.js) creates the account from it and deletes the row.
--
-- Keyed by phone, the same digits the store is registered under
-- (tenants.whatsapp_number), which is how approval finds it.

create table public.signups (
  phone text primary key check (phone ~ '^[0-9]{8,15}$'),

  -- The chat as WhatsApp addressed it, which may be a privacy id (…@lid)
  -- rather than the number. Replies and the approval message go here.
  chat_id text not null,

  state text not null check (state in ('name', 'email', 'pending')),
  business_name text check (char_length(business_name) <= 60),
  email text,

  -- The last inbound message applied, so a webhook WAHA retries does not
  -- answer the same question twice.
  last_message_id text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger signups_touch before update on public.signups
  for each row execute function public.touch_updated_at();

-- Service role only: the Worker is the one reader and writer. See 0013 for why
-- the default grant is removed even though RLS with no policy already denies.
alter table public.signups enable row level security;
revoke all on public.signups from anon, authenticated;
