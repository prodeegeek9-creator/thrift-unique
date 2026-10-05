-- One buyer at a time for each item.
--
-- A thrift item is usually the only one, and it can be bought from its page,
-- from a payment link, or in a WhatsApp cart. Once a buyer has given their
-- details and pressed Pay, the item is held for them for a few minutes
-- (worker/lib/reservations.js), and everyone else is told a payment is in progress
-- instead of being let pay for the same thing.
--
--   held_by_ref    the Paystack reference paying for it: an order's (utp_…)
--                  or a WhatsApp cart's (utc_…)
--   held_by_buyer  who, so a buyer can hold items for one payment at a time
--   held_until     when the hold lapses. A lapsed hold is not cleared by a
--                  job; the next buyer to press Pay checks with Paystack that
--                  the last one didn't pay, and takes it over.
--
-- All three are written by the Worker only. The dashboard never selects them.
alter table public.products
  add column if not exists held_by_ref text,
  add column if not exists held_by_buyer uuid references public.buyers(id) on delete set null,
  add column if not exists held_until timestamptz;

create index if not exists products_held_by_buyer_idx
  on public.products (tenant_id, held_by_buyer)
  where held_until is not null;

-- The Paystack page an order was given, so a buyer who comes back to an item
-- they are already paying for is sent to the same page rather than opening a
-- second payment for it.
alter table public.orders
  add column if not exists checkout_url text;

-- The product page shows "Payment in progress" instead of Buy now while an
-- item is held: held_minutes is the minutes left on the hold, or null when
-- nobody is paying for it. Who holds it never leaves the database.
drop function if exists public.public_product(text);

create function public.public_product(code text)
returns table (
  public_code text,
  title text,
  description text,
  condition product_condition,
  price numeric,
  images text[],
  tenant_name text,
  tenant_slug text,
  tenant_whatsapp text,
  whatsapp_checkout boolean,
  held_minutes integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    p.public_code, p.title, p.description, p.condition, p.price, p.images,
    t.name, t.slug, t.whatsapp_number,
    coalesce(t.waha_status = 'WORKING' and exists (
      select 1 from public.tenant_features f
      where f.tenant_id = t.id and f.flag = 'whatsapp_checkout' and f.enabled
    ), false),
    case
      when p.held_until > now()
        then greatest(1, ceil(extract(epoch from (p.held_until - now())) / 60))::integer
    end
  from public.products p
  join public.tenants t on t.id = p.tenant_id
  where p.public_code = upper(code)
    and p.status = 'active'
    and t.status = 'active'
    and t.billing_status <> 'paused';
$$;

revoke execute on function public.public_product(text) from public;
grant execute on function public.public_product(text) to anon, authenticated;
