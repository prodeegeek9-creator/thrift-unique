-- Items people bring to a thrift store, before the store has said yes.
--
-- A thrift store is a middleman. People who want something sold message the
-- store's own WhatsApp number; the bot on the store's linked session takes the
-- photos, a name, the price they want and the condition, and files it here.
-- The store reviews it from the dashboard: approving makes it a product (at a
-- price the store chooses, which may be above what the seller asked) and
-- tells the seller; declining tells them why.
--
-- Rows are written by the Worker under the service key, from the webhook and
-- from the approve/decline endpoint, because both also send WhatsApp messages
-- with credentials the browser must never hold. The team only reads.

create table public.submissions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,

  -- The chat to answer, verbatim, and the number behind it when WhatsApp
  -- would say. A hidden number (an @lid chat the session cannot resolve) still
  -- gets its item reviewed; the store just cannot see the digits.
  seller_chat_id text not null,
  seller_phone text check (seller_phone ~ '^[0-9]{8,15}$'),
  seller_name text check (char_length(seller_name) <= 80),

  title text not null check (char_length(title) between 1 and 120),
  -- What the seller wants for it. The listing price is the store's call and
  -- lives on the product.
  asking_price numeric(12, 2) not null check (asking_price > 0),
  condition product_condition not null,
  -- Storage paths, uploaded when the seller confirmed, so the store reviews
  -- the actual photos and approving needs nothing from WAHA.
  images text[] not null default '{}',

  status text not null default 'pending'
    check (status in ('pending', 'approved', 'declined')),
  decline_reason text check (char_length(decline_reason) <= 300),
  product_id uuid references public.products(id) on delete set null,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,

  created_at timestamptz not null default now()
);

create index submissions_queue_idx
  on public.submissions (tenant_id, status, created_at desc);

-- "What name should this go under?" is asked once per seller, not per item.
create index submissions_seller_idx
  on public.submissions (tenant_id, seller_chat_id, created_at desc);

alter table public.submissions enable row level security;

create policy "team reads submissions" on public.submissions
  for select using (tenant_id in (select public.current_tenant_ids()));

-- Read only, from the browser. See the note at the top.
revoke all on public.submissions from anon, authenticated;
grant select on public.submissions to authenticated;

-- A store's page offers "Sell with us" only when somebody will answer: a
-- thrift store (or one that never said) whose own WhatsApp is linked.
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
    'takes_items', (
      t.store_type is distinct from 'brand'
      and t.waha_session is not null
      and t.waha_status = 'WORKING'
    ),
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
