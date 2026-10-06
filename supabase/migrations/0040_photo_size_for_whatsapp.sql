-- The size check, set for what WhatsApp actually delivers.
--
-- WhatsApp recompresses a photo so its long side is about 1080 pixels. The
-- old minimum of 600 on *both* sides then rejected ordinary phone photos: a
-- landscape shot arrives as 801x590, a tall one as 486x1080. On the first
-- real test, half the rejections were these. 400 still catches thumbnails
-- and forwarded previews, which is what the check is for.
--
-- Only categories still on the old default are moved; one somebody has set
-- on purpose is left alone.
update public.photo_categories
   set min_width = 400, min_height = 400
 where min_width = 600 and min_height = 600;

alter table public.photo_categories alter column min_width set default 400;
alter table public.photo_categories alter column min_height set default 400;
