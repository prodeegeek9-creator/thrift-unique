-- Make the table grants agree with the policies.
--
-- Supabase's default privileges hand `anon` and `authenticated` SELECT,
-- INSERT, UPDATE and DELETE on every table in `public`. The intended model is
-- that RLS does the filtering and the grants stay wide — which works, but it
-- leaves exactly one thing between an anonymous request and every row in the
-- database, and it means a table shipped without a policy is a table shipped
-- open.
--
-- Two layers instead of one. A grant that does not exist cannot be reached by
-- a policy mistake.

-- ── ANON ─────────────────────────────────────────────────────────────────────
--
-- There is no storefront, so an anonymous visitor has no business reading any
-- table at all. Its one entry point is public_product(), which is SECURITY
-- DEFINER and runs as the owner — it needs no grant here and keeps working.
--
-- This also settles a wart from 0005. With table access, an anonymous SELECT
-- on `products` reached the policy, which calls current_tenant_ids(), which
-- anon may no longer execute — so it failed with "permission denied for
-- function", which is a confusing way to say "not for you". Now it stops at
-- the table, which is both earlier and clearer.
revoke all on all tables in schema public from anon;

-- ── AUTHENTICATED ────────────────────────────────────────────────────────────
--
-- Start from nothing and grant back what a policy actually allows, so the two
-- cannot drift apart.
revoke all on all tables in schema public from authenticated;

-- Readable by the team, filtered to their own tenant by RLS.
grant select on
  public.tenants,
  public.tenant_members,
  public.tenant_features,
  public.products,
  public.buyers,
  public.orders,
  public.offers,
  public.buyer_summary,
  public.listing_channel_posts,
  public.payouts,
  public.payout_items,
  public.disputes
to authenticated;

-- Writable, and only where a policy says so:
--
--   products        "team writes listings" — owner, manager and staff. This is
--                   what "Staff — listings only" means on the Team screen.
--   tenant_members  "owners manage staff" — the Team screen's add/remove.
--   tenants         "owners update their tenant" — UPDATE only; a tenant is
--                   created by the Worker at provisioning, never from here.
--   disputes        "managers raise disputes" — INSERT only. Resolving one is
--                   the platform's job, not the tenant's.
grant insert, update, delete on public.products to authenticated;
grant insert, update, delete on public.tenant_members to authenticated;
grant update on public.tenants to authenticated;
grant insert on public.disputes to authenticated;

-- Everything left out is deliberate. buyers, orders, offers, payouts,
-- payout_items, listing_channel_posts and tenant_features are written by the
-- bot, by a payment webhook, or by the publisher — all under the service key,
-- which these statements do not touch. A seller who could insert a completed
-- order could also release escrow to themselves.
--
-- channel_connections appears in neither list: it has no grant and no policy,
-- because every column that matters on it is a credential.

-- ── FUTURE TABLES ────────────────────────────────────────────────────────────
--
-- Supabase's defaults apply to whatever gets created next, so a new table
-- arrives wide open to anon again. RLS is enabled automatically (Supabase's
-- own rls_auto_enable event trigger does that), but a new table with no policy
-- plus a live anon grant is the shape this migration exists to prevent.
--
-- Stop it at the source rather than remembering to revoke each time.
alter default privileges in schema public revoke all on tables from anon;
