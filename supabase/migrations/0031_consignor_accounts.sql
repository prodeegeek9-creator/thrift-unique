-- Where a store pays the people who bring it items (consignors).
--
-- Collected on WhatsApp, on the store's own number, after somebody's first
-- item: their bank and account number, nothing else. The name comes from the
-- bank (Paystack's account lookup) and is shown back to them to confirm, so
-- nobody types a name at all.
--
-- The store pays consignors itself, by transfer, so it needs the whole account
-- number; it is readable by the store's owner and managers only.
--
-- Changing it is where money gets stolen (somebody with the phone points the
-- payouts at their own account), so a change:
--   * must be to an account in the same name as the first one
--   * is allowed twice in any 6 months
--   * is confirmed with the consignor about 2 hours after they ask, so it
--     reaches the phone after whoever asked may have put it down
--   * and approved by the store
-- and takes effect only when both have happened.

create table public.consignor_accounts (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  -- The consignor's chat on the store's number, as on submissions.
  seller_chat_id text not null,
  bank_code text not null,
  bank_name text not null,
  account_number text not null check (account_number ~ '^[0-9]{10}$'),
  account_name text not null,
  -- The name on the first account. Every later account must match it.
  anchor_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, seller_chat_id)
);

create table public.consignor_account_changes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  seller_chat_id text not null,
  bank_code text not null,
  bank_name text not null,
  account_number text not null check (account_number ~ '^[0-9]{10}$'),
  account_name text not null,
  -- The account it replaces, for the store to compare.
  old_bank_name text,
  old_account_number text,
  requested_at timestamptz not null default now(),
  -- The consignor's own confirmation, asked ~2 hours after requested_at.
  verify_sent_at timestamptz,
  verified_at timestamptz,
  -- The store's.
  store_decision text not null default 'pending' check (store_decision in ('pending', 'approved', 'rejected')),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  status text not null default 'pending'
    check (status in ('pending', 'applied', 'rejected', 'cancelled', 'expired')),
  applied_at timestamptz
);

create index consignor_account_changes_open_idx
  on public.consignor_account_changes (tenant_id, seller_chat_id, requested_at desc);
create index consignor_account_changes_due_idx
  on public.consignor_account_changes (requested_at) where status = 'pending';

alter table public.consignor_accounts enable row level security;
alter table public.consignor_account_changes enable row level security;

-- Owner and managers read; only the Worker writes.
create policy "managers read consignor accounts" on public.consignor_accounts
  for select using (public.has_tenant_role(tenant_id, array['owner', 'manager']::staff_role[]));
create policy "managers read consignor account changes" on public.consignor_account_changes
  for select using (public.has_tenant_role(tenant_id, array['owner', 'manager']::staff_role[]));

revoke all on public.consignor_accounts from anon, authenticated;
revoke all on public.consignor_account_changes from anon, authenticated;
grant select on public.consignor_accounts to authenticated;
grant select on public.consignor_account_changes to authenticated;
