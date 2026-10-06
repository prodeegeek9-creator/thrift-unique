-- The blur check, set for what WhatsApp actually delivers.
--
-- Blur is the variance of the Laplacian over the whole photo, and two things
-- pull it down that have nothing to do with focus: WhatsApp shrinking a photo
-- to about 720x1280, and a plain background (a floor, a wall) around a sharp
-- item. On the first real tests a sharp TV remote scored 92 and a pair of
-- shoes 78 against a minimum of 100, while a genuinely unusable photo scored
-- 9. 50 lets the first two through and still stops the third.
--
-- Only categories still on the old default are moved; one somebody has set
-- on purpose is left alone.
update public.photo_categories
   set min_blur_score = 50
 where min_blur_score = 100;

alter table public.photo_categories alter column min_blur_score set default 50;
