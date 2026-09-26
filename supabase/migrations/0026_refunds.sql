-- Refunds: money going back to a buyer's card through Paystack.
--
-- Only while Vendwyze still holds the payment: held in escrow, or (without
-- escrow) before the store's payout has been sent. Once the payment has been
-- released to the store there is no refund; the buyer opens a dispute. So a
-- refund never takes money back from a store.
--
-- Full refunds only, one per order, less Paystack's processing fee: Paystack
-- keeps its fee on a refund, and that cost is the buyer's, not the store's or
-- the platform's. Vendwyze waives its commission on a refunded sale.

create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  -- One refund per order. A failed one is retried in place, not duplicated.
  order_id uuid not null unique references public.orders(id) on delete cascade,
  -- What the buyer paid, Paystack's fee on it, and what goes back (paid - fee).
  paid numeric(12, 2) not null check (paid > 0),
  fee numeric(12, 2) not null default 0 check (fee >= 0),
  amount numeric(12, 2) not null check (amount > 0),
  reason text,
  -- pending/processing: Paystack has it. processed: back on the buyer's card.
  -- failed: Paystack refused or the call failed; a person retries it.
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'processed', 'failed')),
  paystack_refund_id text,
  failure_reason text,
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

-- A store's payout for a sale refunded before the payout was sent.
alter type payout_status add value if not exists 'cancelled';
