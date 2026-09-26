-- What a thrift store owes the people it sells for.
--
-- A consignor (somebody who brought the store an item through the SELL
-- conversation) is owed their asking price once it sells. The store pays them
-- itself, the way thrift stores already do; the platform keeps the tally and
-- tells the consignor on WhatsApp when the store marks it paid.

alter table public.submissions
  add column sold_at timestamptz,
  -- Fixed when the item sells: what they asked for it. A later change to the
  -- listing's price does not change what was agreed with them.
  add column owed_amount numeric(12, 2) check (owed_amount >= 0),
  add column consignor_paid_at timestamptz,
  add column consignor_paid_by uuid references auth.users(id) on delete set null,
  add column consignor_paid_note text check (char_length(consignor_paid_note) <= 200);

-- "To pay": sold, not yet paid.
create index submissions_owed_idx
  on public.submissions (tenant_id, sold_at)
  where sold_at is not null and consignor_paid_at is null;

-- However the item sold — a buyer paying through checkout, or the store
-- pressing "Mark as sold" for a sale made in person — the consignor's row
-- follows the product. Back on sale before they were paid (a sale that fell
-- through) clears it again; once paid, it stays.
--
-- Security definer: the store's own session can update products but has no
-- write grant on submissions, which only the Worker and this trigger write.
create or replace function public.track_consignor_sale()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'sold' and old.status is distinct from 'sold' then
    update public.submissions
       set sold_at = coalesce(new.sold_at, now()),
           owed_amount = asking_price
     where product_id = new.id
       and tenant_id = new.tenant_id
       and sold_at is null;
  elsif old.status = 'sold' and new.status is distinct from 'sold' then
    update public.submissions
       set sold_at = null,
           owed_amount = null
     where product_id = new.id
       and tenant_id = new.tenant_id
       and consignor_paid_at is null;
  end if;
  return new;
end;
$$;

revoke execute on function public.track_consignor_sale() from public, anon, authenticated;

create trigger products_track_consignor_sale
  after update of status on public.products
  for each row execute function public.track_consignor_sale();
