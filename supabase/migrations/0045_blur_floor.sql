-- The blur check becomes a floor, and the AI judges the rest.
--
-- 0043 set 50, and the next real test still turned away two sharp photos of
-- a phone's black, switched-off screen at 43 and 44: a dark, plain surface has
-- almost no edges to measure, focused or not. A single number can't tell
-- "plain" from "soft". The plain-code check now stops only photos too blurred
-- to be anything (a shaken shot scores single digits); everything above it
-- goes to the photo-review AI, which sees the photo and can still reject it
-- as 'blurry'.
--
-- Only categories still on 0043's value are moved.
update public.photo_categories
   set min_blur_score = 25
 where min_blur_score = 50;

alter table public.photo_categories alter column min_blur_score set default 25;
