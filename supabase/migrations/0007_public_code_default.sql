-- products.public_code had no default, so every caller had to invent one --
-- the bot, the dashboard's manual form, and any future import. Three chances
-- to disagree about the alphabet, and a race between checking a code is free
-- and inserting it.
--
-- The alphabet deliberately drops I, O, 0 and 1. These codes are read aloud on
-- a call, typed off a phone screen, and pasted into a WhatsApp Status caption;
-- a code that cannot be misread is worth more than four extra characters of
-- keyspace. 32^6 is still about a billion.
create or replace function public.gen_public_code()
returns text
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  code text;
  tries int := 0;
begin
  loop
    select string_agg(
             substr('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', floor(random() * 32)::int + 1, 1), '')
      into code
      from generate_series(1, 6);

    exit when not exists (select 1 from public.products p where p.public_code = code);

    tries := tries + 1;
    -- The unique index is still the thing that guarantees correctness; this
    -- loop only keeps the common case from ever reaching it. Twenty misses in
    -- a billion-key space means something is wrong that retrying will not fix.
    if tries > 20 then
      raise exception 'could not allocate a unique product code after % tries', tries;
    end if;
  end loop;
  return code;
end;
$$;

revoke execute on function public.gen_public_code() from public, anon, authenticated;

alter table public.products
  alter column public_code set default public.gen_public_code();
