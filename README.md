# Unique Thrift — Multi-Tenant WhatsApp Commerce Platform

Many independent seller businesses, one backend, one feature-flagged codebase.
A seller runs their whole store through WhatsApp — listing conversationally to
a bot, auto-posting to their own social channels, taking payment through the
platform — and this dashboard is where they check on it.

It is the merge of two things: the existing single-store Unique Thrift
marketplace (live at `thrift-unique.prodeegeek9.workers.dev`), which becomes
tenant #1, and a WhatsApp-native seller SaaS that did not exist yet.

The dashboard bundle is new. The marketplace's static HTML is still in the repo
root, still serving real buyers, and is deliberately untouched — see
**Cutover**.

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
    FeatureUpsell.jsx  what a locked route renders instead of redirecting
    Login, Onboarding, ConnectChannels, NotFound
  lib/           supabase.js, AuthContext, TenantContext, ToastContext,
                 features.js, money.js, privacy.js, whatsapp.js
  index.css      Tailwind + the design tokens
  App.jsx        Routes
  main.jsx       React root + providers
supabase/
  migrations/    Every schema change, in order
worker/          Cloudflare Worker — not written yet; today's worker.js is the
                 old admin proxy and still runs the live site
*.html, chat.js  The live marketplace. Untouched.
```

## Run it

```
npm install
cp .env.example .env      # fill in VITE_SUPABASE_ANON_KEY
npm run dev               # then open /app.html
```

`/` in dev still serves the legacy marketplace's `index.html`, which is the
point — both halves are reachable while the migration runs.

## The design system

Every colour resolves to a CSS variable. `tailwind.config.js` maps tokens to
`var(--c-*)`, `src/index.css` supplies the values, and **no component carries a
hex literal**. That indirection is not decoration: tenant branding re-points
these at runtime, and a literal is a colour that will not follow.

Colours are space-separated channel triplets (`18 48 30`) rather than hex, so
Tailwind's slash-opacity syntax keeps working — `bg-green/10` compiles because
the value is spliced into `rgb()` with `<alpha-value>` in the alpha slot. The
two tokens that carry their own alpha (`line`, `overlay`) are whole colours
instead, since an alpha already baked in cannot also be varied.

The palette is mostly carried over from the live marketplace — the same cream
page, the same green/amber/red. One token genuinely changes: the live site's
nav is a dark brown (`#2C1810`), and the dashboard mockups are a **dark forest
green** (`--c-sidebar`, `#12301E`) throughout.

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
| Listings | `pending` · `active` · `sold` · `rejected` |
| Disputes | `open` → `under_review` → `resolved` |
| Publishing | `queued` · `posted` · `failed` · `skipped` |
| Staff roles | `owner` · `manager` · `staff` |

Staff roles are a fixed enum rather than a permission matrix, because that is
what the Team screen offers, and an unused matrix is a thing you have to keep
honest forever.

## Tenancy is three layers, and two of them are not in this bundle

`TenantContext` resolves which business you are acting as, once, from
`tenant_members` — **never from a URL parameter**. A tenant id the client
chooses is not tenancy, it is a request, and a request is what an attacker also
gets to make.

1. `src/lib/TenantContext.jsx` picks which of *your own* memberships is in
   front of you. This is presentation.
2. Postgres decides independently: `current_tenant_ids()` in every RLS policy.
3. The Worker decides a third time, in `worker/lib/guard.js`, for the writes
   that run under the service key — where Postgres has stopped checking.

Only the second and third are security. The first is editable by whoever is
holding the laptop.

`current_tenant_ids()` is `SECURITY DEFINER` and that is load-bearing: the
policy on `tenant_members` calls it, and it selects from `tenant_members`.
Under the caller's own rights that is infinite recursion, reported as a policy
error a long way from its cause.

## Feature flags, and why locked things stay visible

`FLAG_MIN_TIER` in `src/lib/features.js` is the source of truth for four
things: whether a nav item renders locked, which badge it carries, whether a
route shows its page or an upsell, and — in the Worker's own copy — whether the
server will actually do the thing. **Only the fourth is security.** Keep the
two copies in step, and never let the UI promise a capability the Worker has
not been taught to grant.

Flags are stored as rows (`tenant_features`), not derived from the tier. The
platform console needs to switch a Business feature on for a Growth customer
mid-negotiation, or off after a chargeback, without moving anybody between
plans. The tier only decides what gets seeded at provisioning.

`RequireFeature` **does not redirect.** This is the one real departure from the
Automate Naija guards it is modelled on. A locked feature is something the
seller could buy, so the route resolves, the URL stays, and the page explains
what the tier unlocks. Hiding locked items would remove the only place most
Starter sellers will ever learn the higher tiers exist. The copy in
`FeatureUpsell.jsx` is worth arguing about — it is the entire pitch, and
"Upgrade to unlock" is not a pitch.

## Money is in naira

Paystack speaks kobo, this application speaks naira, and the conversion happens
exactly once — at the webhook, in the Worker. **Nothing in `src/` divides by
100.** A number that looks a hundred times too big is a bug upstream, and
dividing it here would hide it.

Commission is stored per tenant rather than per tier, because the Business tier
is explicitly negotiable and a tier-derived rate has nowhere to record that.

## Buyer phone numbers are masked everywhere

`+234 80••••21`, on Overview, Orders, the order detail and Contacts. A platform
rule, not a formatting choice made per screen — `maskPhone()` in
`src/lib/privacy.js`.

Masking is presentation, not protection: the unmasked number is in the row the
client already has. What actually keeps a Starter tenant from reading buyer
contact details is the column grant in the RLS policy.

## Channel attribution lands before anything needs it

`orders.source_channel` and the usage counters exist now, in phase 1, though
nothing reads them until Analytics and Billing in phase 6.

They are Business-tier *reads* fed by Starter-tier *writes*. The Analytics
donut — WhatsApp 42%, Instagram 30% — is only possible if every order has
recorded its channel from the first one onward. Ship orders without it and the
first Business customer gets an empty chart with no way to backfill, because
the information never existed.

## Listing is WhatsApp-first

"Open WhatsApp" is the primary green button; "Add manually" is the secondary
outline below it. The conversational flow is the product and the web form is
the fallback for a seller already at a desk. Every listing surface should lead
there first — `listingDeepLink()` in `src/lib/whatsapp.js`.

The deep link tags the store slug so a seller with two shops lands in the right
one, but that tag is a **hint**: the Worker resolves the real tenant from the
sender's number against `tenants.whatsapp_number`, and a tag that disagrees
loses.

## The database

Migrations run in filename order. Three exist:

| | |
|---|---|
| `20260919_tenancy.sql` | tenants, members, feature flags, scope helpers. All new objects — safe on the live database. |
| `20260919b_tenant_scope_existing.sql` | `tenant_id` on the marketplace tables, tenant #1, backfill. **Additive only.** |
| `20260919c_channels_and_attribution.sql` | publishing, attribution, payouts, disputes. New tables, RLS on from the start. |

`20260919b` deliberately **does not enable RLS on any existing table**. The
marketplace is serving real buyers right now through the anon key against those
exact tables; tenant-scoped RLS would take it down the moment it ran, because
an anonymous visitor belongs to no tenant. The lockdown is a fourth migration,
`20260919d_tenant_rls.sql`, written and run at cutover. It is not written yet.

The column lists in `20260919b` were **reconstructed from the live front-end
code, not from the database** — the Supabase credentials available when it was
written could not reach the thrift project (it sits in a different org from the
one the tooling had access to). Every statement is guarded so a missing table
is skipped rather than aborting the run, but verify against the real schema
before relying on it.

## Cutover

The Vite entry is `app.html`, not `index.html`, and that is deliberate:
`index.html` at the repo root is the live marketplace, and `wrangler.jsonc`
serves the whole root as static assets. Naming the bundle's entry `index.html`
would overwrite the running site the moment anyone deployed.

When the dashboard is what people actually use:

1. Rename `app.html` → `index.html`.
2. Point `wrangler.jsonc`'s `assets.directory` at `./dist` — it currently
   serves `./`, which will start publishing `src/` once a build exists.
3. Teach the build to copy whatever legacy pages still need to answer.
4. Add an SPA fallback in the Worker so `/dashboard/*` serves the bundle.
5. Run `20260919d_tenant_rls.sql`.

This is the one step that changes what a live URL serves, so it does not happen
as part of a scaffold.

## Two consoles, not one

The ten screens in the spec are all seller-facing, but `dashboard.html` today
is the *platform owner's* console, and multi-tenancy splits it in two. Sellers
get `/dashboard/*`. The platform gets `/admin/*` — tenant provisioning, WAHA
session-pool health, the escrow release queue, dispute routing, commission
reconciliation, feature-flag overrides, an audit log. It is a whole route tree
and its own lazy chunk, and it is not designed yet.

## Status

- Vite + React + Tailwind scaffold, building clean ✅
- Design tokens ported and extended; no hex literals in components ✅
- Sidebar / TopBar / BottomTabBar / SellerShell, matching the mockups ✅
- Tenant switcher in the sidebar footer ✅
- `TenantContext` resolving memberships and flags ✅
- `FLAG_MIN_TIER`, `TierBadge`, and locked-but-visible navigation ✅
- `RequireAuth` / `RequireFeature` / `RequireStaffRole` ✅
- `FeatureUpsell` with per-feature copy for all eleven flags ✅
- `StatusPill` covering every enum ✅
- `maskPhone`, naira formatting, WhatsApp deep links ✅
- Login against Supabase auth ✅
- Tenancy migrations written — **not yet run against the database**
- Every seller page is a scaffold. No data layer yet.
- `worker/` does not exist. `worker.js` is still the old admin proxy.
- No storefront. Whether one ships at all is undecided — see below.

## Next steps

1. Verify the three migrations against the real schema, then run them.
2. Phase 2 — the data layer: `lib/products.js`, `lib/orders.js`,
   `lib/payouts.js`, one module per domain, no `supabase.from()` in a page.
3. Phase 3 — refactor `worker.js` into `worker/`: signed sessions, the Paystack
   webhook, commission, escrow hold/release.
4. Submit the Meta App Review and the TikTok audit. Both are one-time
   platform-level gates with multi-week lead times, and both block phase 5.
5. Phase 4 — WAHA session layer and `infra/waha/`.

## Open decisions

1. **Is there a buyer-facing web storefront at all?** Every mockup is
   seller-facing. If buyers live entirely in WhatsApp and social, the existing
   cart/browse/checkout retires with tenant #1's old site and the edge
   OG-rendering work disappears from the plan. If not, it needs designing.
2. **Incremental or clean cut?** The scaffold assumes incremental — both halves
   served side by side until the cutover above.
3. **Storefront addressing**, only if one exists: path-based (`/s/:slug`)
   to start, custom domains as a Business feature later.
