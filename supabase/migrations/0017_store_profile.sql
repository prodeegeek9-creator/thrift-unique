-- What a store is, and a public page for each one.
--
-- Two kinds of store sign up. A thrift store is a middleman: people bring
-- items to it and it lists them for them. A brand sells its own stock. Both
-- are recorded, with a category, because what the platform builds next for
-- each (a seller intake queue for the first) depends on it.

alter table public.tenants
  add column store_type text check (store_type in ('consignment', 'brand')),
  add column category text check (char_length(category) <= 40);

-- The sign-up conversation now asks for these, and holds them until the store
-- is created at the end of it.
alter table public.signups
  add column store_type text check (store_type in ('consignment', 'brand')),
  add column category text check (char_length(category) <= 40),
  add column tier tenant_tier;

alter table public.signups drop constraint signups_state_check;
alter table public.signups
  add constraint signups_state_check
  check (state in ('name', 'type', 'category', 'plan', 'email', 'terms', 'pending'));

-- A store's own website: /s/<slug>.
--
-- The same shape as public_product(): security definer, one store by its
-- slug, live stores and live listings only. A plain anon SELECT policy would
-- let anyone page through every tenant's catalogue; this answers exactly one
-- question and nothing adjacent to it. Null for a store that does not exist or
-- is not live, which the page shows as "not found" either way.
create or replace function public.public_store(store_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'name', t.name,
    'slug', t.slug,
    'logo_url', t.logo_url,
    'brand_color', t.brand_color,
    'whatsapp_number', t.whatsapp_number,
    'products', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'public_code', p.public_code,
            'title', p.title,
            'price', p.price,
            'condition', p.condition,
            'image', p.images[1]
          )
          order by p.created_at desc
        )
        from (
          select * from public.products
          where tenant_id = t.id and status = 'active'
          order by created_at desc
          limit 200
        ) p
      ),
      '[]'::jsonb
    )
  )
  from public.tenants t
  where t.slug = lower(store_slug)
    and t.status = 'active';
$$;

grant execute on function public.public_store(text) to anon, authenticated;

-- 0016's trigger function picked up Supabase's default EXECUTE grant. A
-- trigger function cannot be called directly, so this is hygiene rather than
-- a hole; see 0005 for why these are revoked anyway.
revoke execute on function public.normalize_whatsapp_number() from anon, authenticated;
