-- A refund Vendwyze pays Paystack's fee on.
--
-- A refund normally goes back less Paystack's processing fee (0026): the buyer
-- chose to undo the sale. An automatic refund is different: it is a second
-- payment for an item that had already sold (worker/routes/checkout.js,
-- lateSale), which is nobody's doing but the platform's. The buyer gets
-- everything back, `fee` stays 0 because nothing was kept from them, and the
-- fee Paystack keeps is recorded here as what that refund cost Vendwyze.
alter table public.refunds
  add column if not exists platform_fee numeric(12, 2) not null default 0
    check (platform_fee >= 0);
