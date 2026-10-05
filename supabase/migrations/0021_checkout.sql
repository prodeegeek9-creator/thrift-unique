-- Buying on the platform.
--
-- Until now nothing created an order: "Buy on WhatsApp" opened a chat, and the
-- Paystack webhook had nothing to match. The Worker now creates the order when
-- a buyer starts checkout (from a product page, or a payment link a store
-- sent them), and needs somewhere to keep where the item is going.
alter table public.orders
  add column delivery_address text check (char_length(delivery_address) <= 300),
  add column buyer_note text check (char_length(buyer_note) <= 300);

-- An order waiting for payment is looked up by its product when the same item
-- is bought twice at once; see worker/routes/checkout.js.
create index orders_product_idx on public.orders (product_id, status);
