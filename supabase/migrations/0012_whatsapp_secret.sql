-- The WhatsApp webhook secret was put on public.tenants, where every member of
-- a store can read it.
--
-- Not because a policy allows it. Because the table-level SELECT grant in 0006
-- covers every column, present and future — so adding a column to `tenants`
-- publishes it to `authenticated` by default. That is fine for a session name
-- and wrong for a shared secret, and it is the same class of mistake as 0004
-- and 0007: a grant that was already there quietly covering something new.
--
-- channel_connections is the pattern this should have followed from the start,
-- and its comment already says why: a table whose every column is a credential
-- gets RLS on, no policy and no grant. The Worker reaches it under the service
-- key; nobody else reaches it at all.
--
-- A column-level REVOKE would not have done it. When a table-level SELECT
-- grant exists, revoking one column from it does nothing — the table privilege
-- still covers the column. The grant would have to be dropped and re-issued
-- per column, on a list that then has to be kept correct forever.

create table public.whatsapp_secrets (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,

  -- What WAHA carries in X-Thrift-Secret on every webhook for this tenant's
  -- session, and what the Worker compares against before acting on one.
  webhook_secret text not null,

  rotated_at timestamptz not null default now()
);

-- Anything already issued moves across, so a session linked before this
-- migration keeps authenticating.
insert into public.whatsapp_secrets (tenant_id, webhook_secret)
select id, waha_secret
from public.tenants
where waha_secret is not null
on conflict (tenant_id) do nothing;

alter table public.tenants drop column waha_secret;

-- RLS on with no policies, and no grant to anon or authenticated. Both are
-- needed: the grant is what the roles have, the policy is what they may see
-- with it, and a table with a grant and no policy is only closed by accident
-- of nobody having written the policy yet.
alter table public.whatsapp_secrets enable row level security;
