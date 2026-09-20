-- WhatsApp: the session a tenant's messages route through, and the state of
-- the conversation the bot is holding with them.

-- Per-tenant shared secret for inbound webhooks.
--
-- WAHA can sign webhooks with its own HMAC, but it also lets a session carry
-- arbitrary customHeaders -- and a secret we issue ourselves is one mechanism
-- we control end to end, rather than depending on a header name and digest
-- that vary between WAHA versions and editions.
--
-- Per tenant rather than one global secret, so a leaked value compromises one
-- seller's inbound traffic instead of every seller's at once.
alter table public.tenants
  add column waha_secret text,
  add column waha_status text
    check (waha_status is null or waha_status in
      ('STARTING', 'SCAN_QR_CODE', 'WORKING', 'FAILED', 'STOPPED'));

-- ── CONVERSATION STATE ───────────────────────────────────────────────────────

-- What the bot is in the middle of asking.
--
-- A row per chat, not per message. WhatsApp has no notion of a form: a listing
-- is assembled across several messages, and without somewhere to keep the
-- half-built product every reply would have to re-ask everything.
--
-- `draft` holds the partial product. It is jsonb rather than columns because
-- the shape belongs to the flow rather than to the schema -- adding a question
-- to the listing conversation should not be a migration.
create table public.bot_conversations (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  -- WAHA's chat id: <phone>@c.us. Kept verbatim rather than parsed to a phone
  -- number, because it is also the address replies are sent to.
  chat_id text not null,

  state text not null default 'idle',
  draft jsonb not null default '{}'::jsonb,

  -- What the conversation produced, once it did. Lets a seller say "cancel"
  -- and lets the bot reference the last thing it made.
  last_product_id uuid references public.products(id) on delete set null,

  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  primary key (tenant_id, chat_id)
);

create index bot_conversations_stale_idx
  on public.bot_conversations (updated_at)
  where state <> 'idle';

create trigger bot_conversations_touch before update on public.bot_conversations
  for each row execute function public.touch_updated_at();

-- ── INBOUND MESSAGE LOG ──────────────────────────────────────────────────────

-- Every message the bot received, kept briefly.
--
-- Two jobs. WAHA retries a webhook it thinks failed, and a retried "list this
-- jacket for 35000" that creates a second product is the kind of bug a seller
-- notices and cannot explain -- so the message id is unique and a replay is a
-- no-op. And when a seller says the bot misunderstood them, this is the only
-- record of what it actually received.
create table public.bot_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  chat_id text not null,

  -- WAHA's own message id. The unique index is what makes a replay harmless.
  external_id text not null unique,

  direction text not null check (direction in ('in', 'out')),
  body text,
  has_media boolean not null default false,

  created_at timestamptz not null default now()
);

create index bot_messages_chat_idx
  on public.bot_messages (tenant_id, chat_id, created_at desc);

-- ── RLS ──────────────────────────────────────────────────────────────────────

alter table public.bot_conversations enable row level security;
alter table public.bot_messages enable row level security;

-- No policies at all on either.
--
-- bot_conversations holds a half-finished listing that the seller is in the
-- middle of dictating; bot_messages holds the literal text of their WhatsApp
-- conversation. Neither is something the dashboard has any reason to read,
-- and the second is about as private as anything in this database. The Worker
-- reaches both under the service key; nobody else reaches them at all.
