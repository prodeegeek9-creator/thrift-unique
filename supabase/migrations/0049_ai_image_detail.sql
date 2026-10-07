-- Which size of photo the AI was shown, per call.
--
-- OpenAI reads a photo at 'high' detail (tiled, up to ~2048px) or 'low'
-- (one 512px view). With gpt-4o-mini a WhatsApp photo cost 26,000–37,000
-- input tokens at high; low is a small fixed amount. The photo-review service
-- now takes OPENAI_IMAGE_DETAIL from its .env and records it here, so the
-- console's AI log can show the two side by side: tokens, and whether the
-- labels it chose still hold up.
alter table public.ai_usage
  add column if not exists image_detail text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ai_usage_image_detail_known') then
    alter table public.ai_usage add constraint ai_usage_image_detail_known
      check (image_detail in ('low', 'high', 'auto'));
  end if;
end $$;
