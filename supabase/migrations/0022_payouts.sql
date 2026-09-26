-- Paying stores: where their money goes, and the transfer that takes it there.

-- ── CLOSING A HOLE FIRST ─────────────────────────────────────────────────────
--
-- 0006 granted UPDATE on tenants to authenticated at table level, with the
-- "owners update their tenant" policy deciding which row. Which *columns* was
-- left to the dashboard, which only ever sends four. But the API does not care
-- what the dashboard sends: an owner with their own token could set their
-- commission_pct to 0, their tier to business, or their status to active and
-- approve themselves. Everything the platform charges is in that row.
--
-- The grant is now the four columns an owner may change. Everything else is
-- written by the Worker, under the service key.
revoke update on public.tenants from authenticated;
grant update (name, logo_url, brand_color, whatsapp_number) on public.tenants to authenticated;

-- ── WHERE A STORE IS PAID ────────────────────────────────────────────────────
--
-- Checked against the bank through Paystack before it is saved, and held as a
-- Paystack transfer recipient: the full account number goes to Paystack once
-- and only its last four digits are kept here.
create table public.payout_accounts (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  bank_code text not null,
  bank_name text not null,
  account_last4 text not null check (account_last4 ~ '^[0-9]{4}$'),
  account_name text not null,
  recipient_code text not null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.payout_accounts enable row level security;

-- The owner and managers see which account they are paid into; nobody writes
-- from the browser (see worker/routes/payouts.js).
create policy "managers read the payout account" on public.payout_accounts
  for select using (public.has_tenant_role(tenant_id, array['owner', 'manager']::staff_role[]));

revoke all on public.payout_accounts from anon, authenticated;
grant select on public.payout_accounts to authenticated;

-- ── THE TRANSFER ─────────────────────────────────────────────────────────────
--
-- 'sending': handed to Paystack, waiting for its transfer.success or
-- transfer.failed webhook. Claimed by an update that only matches 'pending',
-- so a payout is never handed over twice.
alter type payout_status add value if not exists 'sending' after 'pending';

alter table public.payouts
  add column transfer_code text,
  add column sent_at timestamptz,
  add column attempts integer not null default 0;

-- What the hourly sweep looks for.
create index payouts_unsent_idx on public.payouts (created_at) where status = 'pending';

-- An operator can hold a store's payouts: a dispute pattern, a changed bank
-- account that looks wrong. Payouts still accrue; they wait.
alter table public.tenants
  add column payouts_paused boolean not null default false;
