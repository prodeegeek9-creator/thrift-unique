# Unique Thrift — Multi-Tenant WhatsApp Commerce Platform

Many independent seller businesses, one backend, one feature-flagged codebase.
A seller runs their whole store through WhatsApp — listing conversationally to
a bot, auto-posting to their own social channels, taking payment through the
platform — and this dashboard is where they check on it.

This is a fresh build. The old single-store marketplace that used to live in
this repo (`index.html`, `sell.html`, `dashboard.html`, `chat.js` and the
admin-proxy `worker.js`) has been removed, and the database is a new, empty
Supabase project rather than the one that site ran on. Nothing is carried
over. The old code is in git history if it is ever wanted.

## Structure

```
src/
  components/
    layout/      Sidebar, TopBar, BottomTabBar, SellerShell, TenantSwitcher,
                 navItems.js — the nav as data, each item carrying its flag
    ui/          Icon, TierBadge, StatusPill, BrandMark, PageHeader, LogoLoader
    Require*.jsx Auth, Feature, StaffRole — the route guards
  pages/
    seller/      Overview, Listings, Orders, OrderDetail, Payouts, Contacts,
                 Disputes, Analytics, Team, Channels, Billing, Settings, Help
    public/      Product, ConfirmReceipt — the only two public documents
    FeatureUpsell.jsx  what a locked route renders instead of redirecting
    Login, Onboarding, ConnectChannels, NotFound
  lib/           supabase.js, AuthContext, TenantContext, ToastContext,
                 features.js, money.js, privacy.js, whatsapp.js
  index.css      Tailwind + the design tokens
  App.jsx        Routes
  main.jsx       React root + providers
worker/          Cloudflare Worker — the one origin that holds secrets.
                 Shell only; routes land in phase 3.
supabase/
  migrations/    The schema, from nothing, in order
```

## Run it

```
npm install
cp .env.example .env      # fill in the new project's URL and anon key
npm run dev
```

## There is no storefront, and that is a decision

The spec sells this as running a store *"without needing to build or maintain a
website"*. Buyers discover an item on WhatsApp Status, Instagram, Facebook or
TikTok, message the seller or the bot, and pay through the platform. The thing
that scales across tiers is distribution channels, not web presence. A
cross-seller marketplace would also compete with the sellers paying for reach,
and re-centralise the audience they were just promised they would keep.

So: no catalogue, no cart, no browse, no search.

Two public pages exist anyway, because "no storefront" is not "no buyer-facing
URL":

- **`/p/:code`** — one item, reached by a link somebody was sent. Instagram
  will not make a caption clickable; a forwarded link has to render as a photo
  and a price rather than bare text; and the bot needs to know *which* item a
  buyer means rather than parsing "the brown jacket". The button carries the
  product code into the opening WhatsApp message.
- **`/confirm/:token`** — how escrow actually releases. The spec says funds are
  held until the buyer confirms receipt but never says how. Doing it purely
  in-bot is fragile exactly where it matters: sessions drop, the message
  scrolls away, and somebody is releasing tens of thousands of naira by typing
  a word with no record either side can point at later.

A seller's *catalogue* page — link-in-bio, the standard answer to Instagram's
no-links rule — is storefront-lite. It is genuinely valuable and worth selling
later as a Growth+ feature, because it is *their* page rather than a
marketplace. It should be a deliberate decision, not something that arrives
because the product page grew a sibling.

## The design system

Every colour resolves to a CSS variable. `tailwind.config.js` maps tokens to
`var(--c-*)`, `src/index.css` supplies the values, and **no component carries a
hex literal**. That indirection is not decoration: tenant branding re-points
these at runtime, and a literal is a colour that will not follow.

Colours are space-separated channel triplets (`18 48 30`) rather than hex, so
Tailwind's slash-opacity syntax keeps working — `bg-green/10` compiles because
the value is spliced into `rgb()` with `<alpha-value>` in the alpha slot. The
two tokens carrying their own alpha (`line`, `overlay`) are whole colours
instead, since an alpha already baked in cannot also be varied.

Two pairs look similar and must not be confused:

- `--c-gold` is the active nav pill. `--c-amber` is the "processing" status.
- Tier badges have their own tokens. A "Growth+" pill beside a locked nav item
  must not read as a success state.

Fraunces is the wordmark and headings, Inter is everything else.

**There is no dark theme.** Every mockup is light, and a dark palette nobody
designed would be a guess shipped as a feature. Adding one later is a second
block in `index.css`, a context to flip an attribute on `<html>`, and no
component touched — which is exactly what the indirection buys.

## Status is three colours

Green for settled, amber for in flight, red for wrong. `StatusPill.jsx` is the
only component that chooses between them, and a screen that invents a fourth
has invented a state nobody designed. The keys are the database enums, so a
status renders straight from a row:

| | |
|---|---|
| Orders | `awaiting_payment` → `processing` → `escrow` → `paid` → `completed` |
| Escrow | `none` · `held` · `released` · `refunded` |
| Listings | `draft` · `active` · `sold` · `archived` |
| Offers | `pending` · `accepted` · `declined` · `countered` · `expired` |
| Disputes | `open` → `under_review` → `resolved` |
| Publishing | `queued` · `posted` · `failed` · `skipped` |
| Staff roles | `owner` · `manager` · `staff` |

`escrow_status = 'none'` is a real state, not a null: Starter takes no hold at
all.

## Tenancy is three layers, and two of them are not in this bundle

`TenantContext` resolves which business you are acting as, once, from
`tenant_members` — **never from a URL parameter**. A tenant id the client
chooses is not tenancy, it is a request, and a request is what an attacker also
gets to make.

1. `src/lib/TenantContext.jsx` picks which of *your own* memberships is in
   front of you. This is presentation.
2. Postgres decides independently: `current_tenant_ids()` in every RLS policy.
3. The Worker decides a third time, in `worker/`, for the writes that run under
   the service key — where Postgres has stopped checking.

Only the second and third are security. The first is editable by whoever is
holding the laptop.

`current_tenant_ids()` is `SECURITY DEFINER` and that is load-bearing: the
policy on `tenant_members` calls it, and it selects from `tenant_members`.
Under the caller's own rights that is infinite recursion, reported as a policy
error a long way from its cause.

Role boundaries follow the Team screen. Staff can read and write listings and
nothing else — not the customer list, not orders, not payouts. Buyers, orders,
offers and payouts stop at manager.

## Feature flags, and why locked things stay visible

`FLAG_MIN_TIER` in `src/lib/features.js` is the source of truth for four
things: whether a nav item renders locked, which badge it carries, whether a
route shows its page or an upsell, and — in the Worker's own copy — whether the
server will actually do the thing. **Only the fourth is security.** Keep the
two copies in step, and never let the UI promise a capability the Worker has
not been taught to grant. `seed_tenant_features()` in `0001` is the third copy;
it decides what a tenant is given at provisioning.

Flags are stored as rows (`tenant_features`), not derived from the tier. The
platform console needs to switch a Business feature on for a Growth customer
mid-negotiation, or off after a chargeback, without moving anybody between
plans.

`RequireFeature` **does not redirect.** This is the one real departure from the
guards it is modelled on. A locked feature is something the seller could buy,
so the route resolves, the URL stays, and the page explains what the tier
unlocks. Hiding locked items would remove the only place most Starter sellers
will ever learn the higher tiers exist. The copy in `FeatureUpsell.jsx` is
worth arguing about — it is the entire pitch, and "Upgrade to unlock" is not a
pitch.

## Money is in naira

Paystack speaks kobo, this application speaks naira, and the conversion happens
exactly once — at the webhook, in the Worker. **Nothing in `src/` divides by
100.** A number that looks a hundred times too big is a bug upstream, and
dividing it here would hide it.

Commission is stored per tenant rather than per tier, because the Business tier
is explicitly negotiable and a tier-derived rate has nowhere to record that.

## Buyers belong to their seller

`buyers` is scoped per tenant, so the same person buying from two sellers is
two rows. Each seller owns their own customer relationship — that is what they
are paying for, and a shared buyer table would quietly make the platform the
one with the customer list.

Phone numbers are masked wherever they are displayed — `+234 80••••21`, on
Overview, Orders, the order detail and Contacts, via `maskPhone()` in
`src/lib/privacy.js`. That is presentation, not protection; what actually keeps
staff out of the customer list is the role check in the RLS policy.

## Channel attribution lands before anything reads it

`orders.source_channel` is written from the first order, though nothing reads
it until Analytics in phase 6. It is a Business-tier read fed by a
Starter-tier write: ship orders without it and the first Business customer gets
an empty chart with no way to backfill, because the information never existed.

## Listing is WhatsApp-first

"Open WhatsApp" is the primary green button; "Add manually" is the secondary
outline below it. The conversational flow is the product and the web form is
the fallback for a seller already at a desk — `listingDeepLink()` in
`src/lib/whatsapp.js`.

The deep link tags the store slug so a seller with two shops lands in the right
one, but that tag is a **hint**: the Worker resolves the real tenant from the
sender's number against `tenants.whatsapp_number`, and a tag that disagrees
loses.

## The database

Project `vhmyzawgtstjtavwzpzn`, built from nothing, in order:

| | |
|---|---|
| `0001_tenancy.sql` | tenants, members, feature flags, scope helpers, RLS |
| `0002_catalog_and_orders.sql` | products, buyers, orders, offers, the Contacts view, `public_product()` |
| `0003_channels_payouts_disputes.sql` | publishing, OAuth connections, payouts, disputes |
| `0004_function_grants.sql` | revoke the default PUBLIC `EXECUTE` on every function |
| `0005_revoke_anon_execute.sql` | and the *explicit* `anon` grant, which 0004 missed |
| `0006_table_grants.sql` | table privileges cut back to match the policies |

Three of those six exist because of a trap worth knowing about. A new function
in `public` ends up with **two** separate `EXECUTE` grants: the `PUBLIC` one
Postgres adds, and an explicit one Supabase's default privileges give `anon`.
`revoke ... from public` removes only the first. So 0004 looked right, passed a
local test, and changed nothing that mattered — `seed_tenant_features()` stayed
callable without signing in, and it is `SECURITY DEFINER`, it writes, and it
takes the plan tier as an argument.

The local test passed precisely *because* it was local: a stub database with
hand-made `anon` and `authenticated` roles has only the PUBLIC grant. The
explicit ones exist only on a real project. Supabase's database linter is what
caught it — run `get_advisors` after every schema change, not just at the end.

0006 then cut the table grants back to match the policies, because Supabase's
defaults hand `anon` SELECT **and INSERT** on every table and leave RLS as the
only thing in the way. Two layers instead of one: a grant that does not exist
cannot be reached by a policy mistake.

### The first tenant

A tenant is provisioned by the Worker after the bot collects a business name
and a tier, and there is deliberately no self-serve tenant creation from the
browser — so with no Worker yet, the first one goes in by hand.
`supabase/seed/first_tenant.sql` does it: the owner's auth user, the store, the
membership and the flags in one pass. It is not a migration and does not live
in `migrations/`, because it is one person's account with one password and
should run exactly once.

### Advisor findings that are meant to stay

- `public_product()` executable by `anon` — the entire point of it; a shared
  product link has no session behind it.
- `channel_status()`, `current_tenant_ids()`, `has_tenant_role()` executable by
  `authenticated` — the last two are named inside every RLS policy, and a
  policy is evaluated with the caller's own privileges. Revoke them and every
  screen fails with `permission denied for function`.
- `channel_connections` has RLS on and no policy — deliberate. Every column on
  it that matters is a credential; the dashboard reads `channel_status()`.
- `rls_auto_enable()` is Supabase's own event-trigger function, not ours.

Two tables from the old site are deliberately absent. No `cart`, because there
is no storefront to put one on. No web `chat_messages`, because the
conversation happens in WhatsApp, which is the premise.

Anonymous access is one function, not a policy. `public_product(code)` returns
one row by its code; a plain anon `SELECT` on `products` would let anybody walk
every tenant's catalogue. `channel_connections` has RLS on with no policy at
all — every column that matters is a credential — and the Channels screen reads
`channel_status()` instead.

## Two consoles, not one

The ten screens in the spec are all seller-facing, but multi-tenancy needs a
second console. Sellers get `/dashboard/*`. The platform gets `/admin/*` —
tenant provisioning, WAHA session-pool health, the escrow release queue,
dispute routing, commission reconciliation, feature-flag overrides, an audit
log. It is a whole route tree and its own lazy chunk, and it is not designed
yet.

## Status

- Vite + React + Tailwind, building clean ✅
- Legacy single-store site removed; repo is the new plan only ✅
- Design tokens; no hex literals in components ✅
- Sidebar / TopBar / BottomTabBar / SellerShell, matching the mockups ✅
- Tenant switcher, `TenantContext`, memberships and flags ✅
- `FLAG_MIN_TIER`, `TierBadge`, locked-but-visible navigation ✅
- `RequireAuth` / `RequireFeature` / `RequireStaffRole` ✅
- `FeatureUpsell` with per-feature copy for all eleven flags ✅
- `StatusPill` covering every enum ✅
- Login against Supabase auth ✅
- `/p/:code` reads `public_product()` and deep-links into the bot ✅
- Full schema **applied** to project `vhmyzawgtstjtavwzpzn` ✅
- Tenant isolation verified end to end against real `auth.uid()`: a seller sees
  only their own rows, cannot write into another tenant, and cannot insert a
  payout to themselves ✅
- Grants cut back to match the policies; advisors clean apart from the
  deliberate findings listed above ✅
- Tenant #1 seeded: `unique-thrift`, Business tier, 0% commission, owner
  account confirmed and signing in ✅
- Every seller page is a scaffold. No data layer yet.
- `worker/` is a shell: static assets and the SPA fallback, no routes.
- `/confirm/:token` is a placeholder.

## Next steps

1. Fill `.env` with the publishable key and open the dashboard. Every screen is
   a scaffold, so what this proves is the chain underneath: sign-in →
   `TenantContext` → RLS → the right store.
2. Phase 2 — the data layer: `lib/products.js`, `lib/orders.js`,
   `lib/payouts.js`, one module per domain, no `supabase.from()` in a page.
3. Phase 3 — `worker/` for real: signed sessions, the Paystack webhook,
   commission, escrow hold/release, and the signed confirm-receipt link.
4. Submit the Meta App Review and the TikTok audit. One-time platform-level
   gates with multi-week lead times, and both block phase 5.
5. Phase 4 — WAHA session layer and `infra/waha/`.
