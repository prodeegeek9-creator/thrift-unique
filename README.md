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
                 products.js, orders.js, payouts.js, contacts.js, disputes.js,
                 analytics.js, staff.js, channels.js, billing.js,
                 dashboard.js, tenants.js, queryKeys.js — the data layer
  index.css      Tailwind + the design tokens
  App.jsx        Routes
  main.jsx       React root + providers
    admin/       AdminRoutes (lazy), Overview, Tenants, TenantDetail,
                 Escrow, Disputes, Audit — the platform console
worker/          Cloudflare Worker — the one origin that holds secrets
  lib/           env, supabase (service key), money, sign, paystack, orders,
                 operator — the cross-tenant privilege boundary
  routes/        paystack webhook, confirm, escrow sweep, storefront OG, admin
  test/          `npm test` — node:test, no network, no wrangler
supabase/
  migrations/    The schema, from nothing, in order
```

## Run it

```
npm install
npm run dev
```

`.env.production` already carries the Supabase URL and publishable key, so a
clone builds with no setup. Both are public by construction — Vite inlines them
into the bundle, so anyone who opens the dashboard has them already, and RLS is
what protects the data behind the key rather than its secrecy. Put a `.env` next
to it to point at a different project locally; it is gitignored.

The service-role key is not in either file and never will be. It belongs on the
Worker, via `wrangler secret put`, where the browser cannot reach it.

## Deploying

Cloudflare Workers Builds, from `main`. `wrangler.jsonc` carries the build
command, because the old setup served the repo root and needed no build at all
while this one serves `dist/`.

Two things there are easy to get wrong, and both are commented in the file:

- **The Worker's `name` must stay `thrift-unique`.** Changing it does not
  rename anything — it points the deploy at a different Worker, which is how a
  green build ends up serving nothing at the URL people actually use.
- **`VITE_*` variables are read at build time**, so they belong in the
  Cloudflare project's *build* environment variables, not in Worker secrets,
  which are only readable at request time. Setting them there overrides
  `.env.production`, which is how a branch would point at a different Supabase
  project.

A build missing either variable fails outright rather than producing a bundle
that points every request at `undefined` — that failure mode ships a dashboard
which loads, looks perfectly normal and never shows a row.

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

## The data layer

One module per domain under `src/lib/`, and **no `supabase.from()` in a page**.
A screen asks `fetchOrders(tenantId, { filter })`; it does not know what a
column is called.

| | |
|---|---|
| `products.js` | listings, counts, per-channel publish state |
| `orders.js` | orders, order detail, and the escrow timeline |
| `payouts.js` | available balance, pending escrow, payout history |
| `contacts.js` | buyers, via the `buyer_summary` view |
| `disputes.js` | raise and list |
| `analytics.js` | sales trend and channel attribution |
| `staff.js` | the three roles |
| `channels.js` | connection state via `channel_status()` |
| `billing.js` | usage counters, plan feature columns |
| `dashboard.js` | Overview tiles, recent orders, the upgrade nudge |
| `tenants.js` | store settings, share links, tenant branding |
| `queryKeys.js` | every TanStack Query key, tenant-scoped |

Three rules hold across all of them.

**Every query filters `tenant_id` explicitly**, and that is required for
correctness, not just defence. RLS returns rows for *every* tenant the signed-in
person belongs to, so a seller running two stores would otherwise see both
catalogues merged into one grid. The policy decides what they may see; the
filter decides which store they are looking at.

**Never `select('*')`.** Each module names its columns, and the list for a grid
is not the list for an editor — descriptions are the longest column on
`products` and no card displays one.

**Totals are computed from rows, never stored.** A balance kept on the tenant
drifts the first time something is deleted or a webhook is replayed, and the
only person who notices is a seller disputing a payout.

Query keys are tenant-scoped from the first segment, so switching stores in the
sidebar cannot show the previous store's listings for a frame — the cache
simply has no entry to show.

## Charts

Series colours are a **separate ramp from the status colours**, defined as
`--c-series-*` in `index.css`. Green, amber and red already mean settled / in
flight / wrong everywhere else in the product, so a channel that happened to be
"series 4" wearing red would read as a failure.

The ramp was validated rather than chosen: worst adjacent pair is
Facebook↔Instagram at ΔE 13.0 under deuteranopia (target ≥8) and 16.3 for
normal vision (floor ≥15), with all five clearing 3:1 contrast on the cream
surface. **Re-run the check before changing any of them** — the first two
palettes tried looked fine and failed.

Channel attribution is a **stacked bar, not the donut in the mockups**. A donut
asks the reader to compare arc lengths around a circle, which is the comparison
people are worst at, and Instagram at 30% against Facebook at 19% is close
enough to be a coin flip. One straight axis, numbers written out beside every
channel, and the legend doubles as the table so identity never rests on colour
alone.

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

## The Worker

Everything the browser cannot be trusted with. It holds the service key, so it
writes the rows no client may write — commission, escrow release, payouts — and
Postgres has stopped checking tenant scope for it, which is why every query in
`worker/lib/orders.js` names `tenant_id` even where the primary key alone would
be unique.

**The webhook order of operations is the whole thing.** Read the *raw* body,
verify the signature before parsing, re-read the transaction from Paystack
rather than trusting the amount, convert kobo to naira exactly once, and update
only an order still `awaiting_payment`. Paystack signs with your **secret key** —
there is no separate webhook secret — and it retries on any non-2xx, so every
outcome we have actually handled answers 200. A 500 buys a retry storm.

**Idempotency is in the WHERE clause, not in a flag.** `markPaid` matches
`status=eq.awaiting_payment` and `releaseEscrow` matches `escrow_status=eq.held`,
so a replayed delivery updates zero rows and the payout is never written twice.
The test suite delivers the same webhook three times and asserts one payout.

**A payment with no matching order is acknowledged, never invented.** An order
exists because somebody was quoted a price; conjuring one from event metadata
would mean the amount, the product and the tenant all came from a payload.

**Escrow releases on a deadline.** `confirm_deadline` plus an hourly cron, because
a buyer who simply stops replying would otherwise freeze the seller's money — and
a seller who has had that happen once goes back to asking for bank transfers,
which is the behaviour this platform exists to replace.

**Commission is floored, not rounded.** A test found this: gross amounts are not
always whole naira (kobo/100 gives ₦3500.50 readily), and rounding 100% of
₦1234.56 to nearest gives ₦1235 — more than the sale, so the payout went
negative. Flooring keeps commission ≤ gross at any rate and puts the sub-naira
remainder on the seller's side, which is the right direction for a fee to round.

### Not built

WAHA and the Meta/TikTok OAuth flows answer `501`. Both need credentials and a
real external account to test against, and writing them blind would produce code
that looks finished and has never once run. The routes are named in
`worker/index.js` so the boundary is visible rather than a 404 that reads like a
typo.

## Two consoles, not one

The ten screens in the spec are all seller-facing. Multi-tenancy needs a second
console: sellers get `/dashboard/*`, the platform gets `/admin/*`.

**The authorisation model is the interesting part.** Every RLS policy in the
database is strictly tenant-scoped, and none of them has an
`or is_platform_admin()` escape hatch — deliberately. An admin exception in a
policy is a hole in *every* policy at once, and one mistake in that predicate
would open the whole platform to any seller.

So cross-tenant reading does not happen through RLS at all. It happens in the
Worker, under the service key, behind a single check in `worker/lib/operator.js`
which:

1. resolves the caller by asking Supabase who their token belongs to — not by
   decoding the JWT here, which would mean trusting a signature we never verified
2. looks them up in `platform_admins`, a table with RLS on and **no policy at
   all**, so no client role can read it

The browser is never asked whether it is an admin. It is told what it may see,
and a client that lies about step 1 fails step 1. `RequireOperator` in the
bundle only avoids drawing a console to somebody whose every request would 403 —
editing it in devtools gets you an empty shell.

**Two levels.** `support` can look and can resolve disputes; `owner` can also
move money and change what a tenant pays. "Can read every customer's orders" and
"can release forty thousand naira" should not be the same grant.

**Everything an operator changes is audited**, and `operator_audit` rejects
UPDATE and DELETE at the database — even under the service key. A record that
can be tidied afterwards is not evidence of anything.

**Refunds stop at the state change.** Resolving a dispute for the buyer reverses
the hold and records the decision; returning money to their card is a separate
deliberate step, because a refund is irreversible and should not fire from a
console click. The payment reference is carried into the audit row so whoever
does it has it to hand.

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
- Data layer complete: one module per domain, verified against the live schema ✅
- All 14 seller screens built and rendered against a mocked API ✅
- Analytics code-split: Recharts is ~40% of the bundle and a Business-tier
  screen, so a Starter seller never downloads it ✅
- Worker: Paystack webhook, escrow hold/release, the signed confirm link and
  edge-rendered link previews, with 17 tests covering the money paths ✅
- WAHA and the Meta/TikTok OAuth flows answer 501 — they need credentials and a
  real account to test against.
- Platform console at `/admin`: overview, stores, release queue, disputes,
  audit log — 16 tests over the privilege boundary ✅

## Next steps

1. Fill `.env` with the publishable key and open the dashboard. Every screen is
   a scaffold, so what this proves is the chain underneath: sign-in →
   `TenantContext` → RLS → the right store.
2. Phase 2 — the data layer: `lib/products.js`, `lib/orders.js`,
   `lib/payouts.js`, one module per domain, no `supabase.from()` in a page.
3. Set the Worker's secrets: `SUPABASE_SERVICE_KEY`, `TOKEN_SECRET`,
   `PAYSTACK_SECRET_KEY`, via `wrangler secret put`. Point Paystack's webhook at
   `/api/paystack/webhook`.
4. Submit the Meta App Review and the TikTok audit. One-time platform-level
   gates with multi-week lead times, and both block phase 5.
5. Phase 4 — WAHA session layer and `infra/waha/`.
