-- Refunds: money going back to a buyer's card through Paystack.
--
-- Full refunds only, one per order: every order is one item, and a partial
-- refund of a single secondhand item is a conversation, not a feature.
--
-- Where the money comes from depends on where it is when the refund is made:
--
--   still with the platform   (held in escrow, or the store's payout not yet
--                              sent)  the payout is cancelled; the store was
--                              never paid, so it owes nothing
--   already paid to the store the store owes back what it received, and that
--                              is withheld from its next payouts
--
-- The platform waives its commission on a refunded sale and absorbs Paystack's
-- fee: the buyer gets back exactly what they paid.

create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  -- One refund per order. A failed one is retried in place, not duplicated.
  order_id uuid not null unique references public.orders(id) on delete cascade,
  amount numeric(12, 2) not null check (amount > 0),
  reason text,
  -- pending/processing: Paystack has it. processed: back on the buyer's card.
  -- failed: Paystack refused or the call failed; a person retries it.
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'processed', 'failed')),
  paystack_refund_id text,
  failure_reason text,
  -- What the store had already been paid for this sale and now owes back.
  store_debt numeric(12, 2) not null default 0 check (store_debt >= 0),
  requested_by uuid references auth.users(id) on delete set null,
  requested_via text not null check (requested_via in ('store', 'operator', 'dispute')),
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index refunds_tenant_idx on public.refunds (tenant_id, created_at desc);
create index refunds_open_idx on public.refunds (created_at) where status in ('pending', 'processing', 'failed');

alter table public.refunds enable row level security;

-- Read like payouts: owners and managers. Written only by the Worker.
create policy "managers read refunds" on public.refunds
  for select using (
    public.has_tenant_role(tenant_id, array['owner', 'manager']::staff_role[])
  );

-- What a store owes the platform from refunds of sales it had already been
-- paid for. Taken out of its next payouts. Not in the column grant from 0022,
-- so no store can write it.
alter table public.tenants
  add column if not exists owed_to_platform numeric(12, 2) not null default 0
    check (owed_to_platform >= 0);

-- How much of a payout was kept back toward that debt. The store sees it, so a
-- smaller transfer than the sale explains itself.
alter table public.payouts
  add column if not exists withheld numeric(12, 2) not null default 0 check (withheld >= 0);

-- A payout for a sale that was refunded before the money left.
alter type payout_status add value if not exists 'cancelled';
