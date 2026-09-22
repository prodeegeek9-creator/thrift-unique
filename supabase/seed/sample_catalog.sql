-- A demo catalogue, so the dashboard looks like the design instead of like a
-- set of empty states.
--
-- Not a migration, and not something to run on a store with real stock. It
-- targets one tenant by slug and is safe to run twice — every insert is keyed
-- on something unique (public_code, order_code, phone) and does nothing the
-- second time.
--
-- The pictures are app assets, not storage objects: public/samples/*.jpg,
-- referenced by a leading-slash path. imageUrl() in the bundle and publicUrl()
-- in the Worker both tell the two apart by that slash, because a real uploaded
-- object's path always starts with the tenant id. That means this seed needs
-- no storage upload and no credentials — the pictures deploy with the code.
--
-- To remove it again:
--   delete from public.products where public_code like 'SMPL%';
-- which cascades to nothing, because orders reference products with
-- `on delete restrict` — clear the sample orders first if you have any.

\set store_slug 'unique-thrift'

do $$
declare
  tid uuid;
  -- Orders are dated backwards from today so the Overview's "this week" and
  -- "this month" tiles, and the Analytics range, have something to divide up.
  now_ts timestamptz := now();
begin
  select id into tid from public.tenants where slug = :'store_slug';
  if tid is null then
    raise exception 'No tenant with slug %. Edit :store_slug at the top.', :'store_slug';
  end if;

  -- ── CATALOGUE ─────────────────────────────────────────────────────────────
  --
  -- The two rows that already existed get pictures rather than duplicates; the
  -- rest are new. Prices are the kind of numbers this market actually uses.
  update public.products
     set images = array['/samples/leather-jacket.jpg'], category = 'Jackets'
   where tenant_id = tid and title = 'Vintage Leather Jacket' and images = '{}';

  update public.products
     set images = array['/samples/sneakers.jpg'], category = 'Shoes'
   where tenant_id = tid and title = 'Nike Air Max' and images = '{}';

  insert into public.products
    (tenant_id, public_code, title, description, category, condition, price,
     images, quantity_available, status, allow_negotiation, sold_at, created_at)
  values
    (tid, 'SMPL01', 'Ankara Wrap Dress', 'Hand-sewn, lined, never worn out of the house.',
     'Dresses', 'excellent', 18500, array['/samples/ankara-dress.jpg'], 1, 'active', true,
     null, now_ts - interval '3 days'),

    (tid, 'SMPL02', 'Straight-Leg Denim', 'Classic indigo, barely faded. 32 waist.',
     'Jeans', 'good', 12000, array['/samples/denim-jeans.jpg'], 2, 'active', true,
     null, now_ts - interval '5 days'),

    (tid, 'SMPL03', 'Tan Leather Tote', 'Full-grain, one small scuff on the base.',
     'Bags', 'good', 27500, array['/samples/tote-bag.jpg'], 1, 'active', false,
     null, now_ts - interval '9 days'),

    (tid, 'SMPL04', 'Cream Linen Shirt', 'Lightweight, ideal for harmattan mornings.',
     'Shirts', 'brand_new', 9500, array['/samples/linen-shirt.jpg'], 3, 'active', false,
     null, now_ts - interval '12 days'),

    (tid, 'SMPL05', 'Forest Green Hoodie', 'Heavyweight cotton, no pilling.',
     'Hoodies', 'excellent', 15000, array['/samples/green-hoodie.jpg'], 1, 'sold', false,
     now_ts - interval '6 days', now_ts - interval '21 days'),

    (tid, 'SMPL06', 'Gold-Tone Wristwatch', 'Working, new battery, leather strap.',
     'Accessories', 'good', 22000, array['/samples/gold-watch.jpg'], 1, 'sold', false,
     now_ts - interval '2 days', now_ts - interval '26 days')
  on conflict (public_code) do nothing;

  -- ── BUYERS ────────────────────────────────────────────────────────────────
  --
  -- Scoped per tenant, which is the point of the buyers table: each seller
  -- owns their own customer relationship.
  insert into public.buyers (tenant_id, phone, name, first_seen_at)
  values
    (tid, '2348023456789', 'Amara Eze',     now_ts - interval '40 days'),
    (tid, '2348034567890', 'Tunde Bakare',  now_ts - interval '26 days'),
    (tid, '2348045678901', 'Ngozi Okafor',  now_ts - interval '18 days'),
    (tid, '2347061234567', 'Bisi Adeyemi',  now_ts - interval '7 days')
  on conflict (tenant_id, phone) do nothing;

  -- ── ORDERS ────────────────────────────────────────────────────────────────
  --
  -- Spread across the lifecycle on purpose, so every filter on the Orders
  -- screen has rows behind it and the Analytics donut has more than one
  -- channel to divide.
  --
  -- commission is 0 because this tenant's rate is 0%. It is stored on the row
  -- rather than derived, so a later rate change cannot retroactively alter
  -- what an older sale was worth — see pctFrom() in worker/lib/orders.js.
  insert into public.orders
    (tenant_id, order_code, product_id, buyer_id, quantity, amount, commission,
     status, escrow_status, source_channel, payment_ref,
     paid_at, shipped_at, confirm_deadline, confirmed_at, completed_at, created_at)
  select tid, v.order_code, p.id, b.id, 1, v.amount, 0,
         v.status::order_status, v.escrow::escrow_state, v.channel::sales_channel, v.ref,
         v.paid_at, v.shipped_at, v.deadline, v.confirmed_at, v.completed_at, v.created_at
  from (values
      -- Sold and settled: the seller has been paid.
      ('UT-1021', 'SMPL05', '2348023456789', 15000::numeric, 'completed', 'released', 'whatsapp', 'SMPL-REF-1021',
       now_ts - interval '6 days', now_ts - interval '6 days', now_ts + interval '1 day',
       now_ts - interval '4 days', now_ts - interval '4 days', now_ts - interval '7 days'),

      -- Money held, buyer has not confirmed yet. This is what the escrow tile
      -- and the release queue read.
      ('UT-1022', 'SMPL06', '2348034567890', 22000::numeric, 'escrow', 'held', 'instagram', 'SMPL-REF-1022',
       now_ts - interval '2 days', now_ts - interval '1 day', now_ts + interval '5 days',
       null, null, now_ts - interval '2 days'),

      -- Paid and not yet sent: the notification bell's "orders to send".
      ('UT-1023', 'SMPL03', '2348045678901', 27500::numeric, 'paid', 'none', 'facebook', 'SMPL-REF-1023',
       now_ts - interval '1 day', null, null, null, null, now_ts - interval '1 day'),

      -- Waiting on the buyer to actually pay.
      ('UT-1024', 'SMPL02', '2347061234567', 12000::numeric, 'awaiting_payment', 'none', 'whatsapp', null,
       null, null, null, null, null, now_ts - interval '4 hours'),

      -- The unhappy paths, so those states are not theoretical.
      ('UT-1025', 'SMPL04', '2348023456789', 9500::numeric, 'cancelled', 'none', 'whatsapp', null,
       null, null, null, null, null, now_ts - interval '11 days'),

      ('UT-1026', 'SMPL01', '2348034567890', 18500::numeric, 'refunded', 'refunded', 'tiktok', 'SMPL-REF-1026',
       now_ts - interval '15 days', now_ts - interval '14 days', now_ts - interval '8 days',
       null, null, now_ts - interval '15 days')
    ) as v(order_code, code, phone, amount, status, escrow, channel, ref,
           paid_at, shipped_at, deadline, confirmed_at, completed_at, created_at)
  join public.products p on p.tenant_id = tid and p.public_code = v.code
  join public.buyers   b on b.tenant_id = tid and b.phone = v.phone
  on conflict (order_code) do nothing;

  -- ── PAYOUTS ───────────────────────────────────────────────────────────────
  --
  -- One settled, one waiting, so the Payouts screen shows both a history and a
  -- balance. The reference matches what the Worker would have generated, so a
  -- real release for the same order collides instead of paying twice.
  insert into public.payouts (tenant_id, amount, commission, status, reference, paid_at, created_at)
  values
    (tid, 15000, 0, 'paid',    'PO-UT-1021', now_ts - interval '3 days', now_ts - interval '4 days'),
    (tid, 27500, 0, 'pending', 'PO-UT-1023', null,                       now_ts - interval '1 day')
  on conflict (reference) do nothing;

  insert into public.payout_items (payout_id, order_id, amount)
  select pay.id, o.id, pay.amount
  from public.payouts pay
  join public.orders o
    on o.tenant_id = tid and o.order_code = replace(pay.reference, 'PO-', '')
  where pay.tenant_id = tid and pay.reference like 'PO-UT-10%'
  on conflict (payout_id, order_id) do nothing;

  -- ── A DISPUTE ─────────────────────────────────────────────────────────────
  --
  -- Resolved rather than open, so the Disputes screen has history without the
  -- demo permanently showing a red badge in the notification bell.
  insert into public.disputes
    (tenant_id, order_id, reason, status, outcome, resolution, opened_by, resolved_at, created_at)
  select tid, o.id,
         'Item arrived with a mark on the sleeve that was not in the photos.',
         'resolved', 'refunded',
         'Refunded in full. Seller agreed the mark was not disclosed.',
         'buyer', now_ts - interval '8 days', now_ts - interval '13 days'
  from public.orders o
  where o.tenant_id = tid and o.order_code = 'UT-1026'
    and not exists (select 1 from public.disputes d where d.order_id = o.id);

  raise notice 'Sample catalogue seeded for tenant %', tid;
end $$;
