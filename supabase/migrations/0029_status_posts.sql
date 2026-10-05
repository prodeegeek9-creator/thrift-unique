-- Which item each WhatsApp Status post was.
--
-- A buyer replying to a post quotes it, and the reply carries the post's
-- WhatsApp message ID. Keeping the ID for every post Vendwyze makes lets the
-- bot tell which item the reply is about even when the caption doesn't come
-- through with it. Posts made by hand on the phone never pass through here.

create table public.status_posts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  -- The bare WhatsApp message ID (BAE5…), as a reply quotes it.
  message_id text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, message_id)
);

create index status_posts_product_idx on public.status_posts (product_id);

-- Worker only.
alter table public.status_posts enable row level security;
