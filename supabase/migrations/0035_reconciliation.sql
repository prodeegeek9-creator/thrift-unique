-- The daily check of our records against Paystack's (worker/lib/reconcile.js).
--
-- Once a day the Worker lists Paystack's successful payments and its
-- transfers for the last week and compares them with orders, carts, plan
-- invoices and payouts. What it can put right from Paystack's own record it
-- does, exactly as the missed webhook would have: a payment nobody applied is
-- settled, a transfer's outcome is recorded. What needs a person goes into
-- payment_problems (0034) under four more kinds:
--
--   amount_mismatch    Paystack's amount is not what we recorded
--   missing_payment    we have it as paid, and Paystack has no successful
--                      payment for it (checked one by one before saying so)
--   payout_mismatch    a payout we have as paid that Paystack failed, or
--                      has no transfer for
--   unknown_transfer   a transfer out of the balance with no payout of ours,
--                      e.g. one made by hand on the Paystack dashboard
alter table public.payment_problems drop constraint if exists payment_problems_kind_check;
alter table public.payment_problems
  add constraint payment_problems_kind_check
  check (kind in (
    'unmatched_payment', 'unsettled_payment', 'bad_signature',
    'amount_mismatch', 'missing_payment', 'payout_mismatch', 'unknown_transfer'
  ));

-- One row per run, so the console can say when the books were last checked
-- and what was found. A run that stops appearing is itself the alarm.
create table public.reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  ran_at timestamptz not null default now(),
  window_from timestamptz not null,
  window_to timestamptz not null,
  payments integer not null default 0,
  transfers integer not null default 0,
  settled_late integer not null default 0,
  payouts_updated integer not null default 0,
  problems integer not null default 0,
  error text
);

create index reconciliation_runs_ran_at_idx on public.reconciliation_runs (ran_at desc);

-- Written and read by the Worker under the service key only.
alter table public.reconciliation_runs enable row level security;
revoke all on public.reconciliation_runs from anon, authenticated;
