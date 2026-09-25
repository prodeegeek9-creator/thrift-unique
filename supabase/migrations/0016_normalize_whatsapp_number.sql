-- A store's WhatsApp number, stored the one way the bot can match it.
--
-- The bot finds a store by comparing the sender's number, as digits with the
-- country code (2348012345678), against tenants.whatsapp_number exactly.
-- Settings normalises what a seller types (src/lib/phone.js), but a dashboard
-- tab opened before that shipped saved "08012345678" as typed, and the store
-- then silently stopped being recognised. So the database does it too, by the
-- same rules, for every writer: an old tab, the operator, a hand-run query.

create or replace function public.normalize_whatsapp_number()
returns trigger
language plpgsql
as $$
declare
  digits text := nullif(regexp_replace(coalesce(new.whatsapp_number, ''), '\D', '', 'g'), '');
begin
  if digits like '00%' then
    digits := substr(digits, 3);
  end if;
  -- Nigerian local format, which is what most sellers type from memory.
  if length(digits) = 11 and left(digits, 1) = '0' then
    digits := '234' || substr(digits, 2);
  end if;
  new.whatsapp_number := digits;
  return new;
end;
$$;

create trigger tenants_normalize_whatsapp_number
  before insert or update of whatsapp_number on public.tenants
  for each row execute function public.normalize_whatsapp_number();

-- Everything already stored, through the same rules.
update public.tenants set whatsapp_number = whatsapp_number where whatsapp_number is not null;

-- And anything that still is not a plausible international number is refused
-- rather than stored where it can never match.
alter table public.tenants
  add constraint tenants_whatsapp_number_format
  check (whatsapp_number is null or whatsapp_number ~ '^[1-9][0-9]{9,14}$');
