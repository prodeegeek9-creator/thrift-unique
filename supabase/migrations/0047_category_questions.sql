-- A category settles some questions on its own.
--
-- Everyone bringing an item was asked its condition — Brand new, Excellent,
-- Good or Fair — including for a tray of chin chin. And everyone was shown
-- the same example name, a Zara blazer, whatever they were selling.
--
-- default_condition: when set, the condition isn't asked; the item is filed
--   with this one (submissions.condition can't be empty). Food is new by
--   nature, and handmade pieces are made to sell.
-- title_example: the example in "What is the item called? (e.g. …)".
--
-- Both are read by lib/photoIntake.js. Null keeps the old behaviour.

alter table public.photo_categories
  add column if not exists default_condition public.product_condition,
  add column if not exists title_example text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'photo_categories_title_example_length') then
    alter table public.photo_categories add constraint photo_categories_title_example_length
      check (char_length(title_example) <= 60);
  end if;
end $$;

update public.photo_categories
   set default_condition = 'brand_new'
 where slug in ('food', 'handmade') and default_condition is null;

update public.photo_categories
   set title_example = case slug
     when 'clothing' then 'Black Zara blazer, size M'
     when 'shoes'    then 'Nike Air Force 1, size 43'
     when 'bags'     then 'Brown leather tote bag'
     when 'gadgets'  then 'iPhone 11, 64GB'
     when 'food'     then 'Chin chin, 1kg pack'
     when 'handmade' then 'Beaded necklace'
     when 'general'  then 'Wooden side table'
   end
 where title_example is null;
