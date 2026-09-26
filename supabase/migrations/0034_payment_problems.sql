-- Money the platform received, or was told about, and could not act on.
--
-- Failed payouts and failed refunds already have rows of their own, marked
-- failed; the console lists those directly. These are the problems that
-- otherwise reach nothing but the Worker's logs (worker/lib/problems.js):
--
--   unmatched_payment   Paystack says money was paid against a reference no
--                       order, cart or plan invoice has. Money has moved and
--                       nobody knows what for.
--   unsettled_payment   a payment with an order that could not be applied:
--                       short of what was owed, or unreadable.
--   bad_signature       a call to the Paystack webhook that Paystack did not
--                       sign. One row a day. A stream of them usually means
--                       the Worker's PAYSTACK_SECRET_KEY is not the key of the
--                       account sending webhooks (test against live), and
--                       every real payment is being turned away.
--
-- One row per kind and key (a reference, or a day), so a retried webhook
-- updates the row rather than adding one, and a problem seen again after it
-- was marked sorted opens again.
create table public.payment_problems (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('unmatched_payment', 'unsettled_payment', 'bad_signature')),
  key text not null,
  reference text,
  amount numeric(12, 2),
  detail text,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null,
  resolution text,
  unique (kind, key)
);

create index payment_problems_open_idx
  on public.payment_problems (last_seen desc)
  where resolved_at is null;

-- Written and read by the Worker under the service key only.
alter table public.payment_problems enable row level security;
revoke all on public.payment_problems from anon, authenticated;
