import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../index.js';
import { makeFakeSupabase, installFetch, env, requestUrl } from './fake-supabase.mjs';

// The operator console is the one place in the system that reads across
// tenants. Every RLS policy is strictly tenant-scoped with no admin exception,
// so requireOperator() is the entire privilege boundary — which makes these
// the most load-bearing tests in the repo.

const OWNER = { id: 'user-owner', email: 'owner@platform.test' };
const SUPPORT = { id: 'user-support', email: 'support@platform.test' };
const SELLER = { id: 'user-seller', email: 'seller@store.test' };

const TOKENS = {
  'tok-owner': OWNER,
  'tok-support': SUPPORT,
  'tok-seller': SELLER,
};

const TENANT = 'aaaaaaaa-0000-0000-0000-00000000000a';
const ORDER = 'bbbbbbbb-0000-0000-0000-00000000000b';
const DISPUTE = 'cccccccc-0000-0000-0000-00000000000c';

function seed() {
  return {
    platform_admins: [
      { user_id: OWNER.id, level: 'owner' },
      { user_id: SUPPORT.id, level: 'support' },
      // SELLER is deliberately absent.
    ],
    tenants: [
      { id: TENANT, slug: 'store', name: 'Store', tier: 'growth', status: 'active', commission_pct: 8 },
    ],
    tenant_features: [{ tenant_id: TENANT, flag: 'analytics', enabled: false }],
    tenant_members: [],
    products: [],
    buyers: [],
    orders: [
      { id: ORDER, tenant_id: TENANT, order_code: 'UT-2001', amount: 35000, commission: 2800,
        status: 'escrow', escrow_status: 'held', confirmed_at: null, payment_ref: 'REF-9',
        confirm_deadline: new Date(Date.now() + 86_400_000).toISOString() },
    ],
    disputes: [
      { id: DISPUTE, tenant_id: TENANT, order_id: ORDER, reason: 'Item not as described',
        status: 'open', outcome: null, created_at: new Date().toISOString() },
    ],
    payouts: [],
    payout_items: [],
    operator_audit: [],
  };
}

function call(path, { token, method = 'GET', body } = {}) {
  return new Request(`https://example.com${path}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

function ctx(extra = {}) {
  const sb = makeFakeSupabase(seed());
  const restore = installFetch({ supabase: sb, tokens: TOKENS, ...extra });
  return { sb, restore };
}

// ── the boundary ─────────────────────────────────────────────────────────────

test('no token, a forged token, and a real seller are all refused', async () => {
  const { sb, restore } = ctx();
  try {
    for (const token of [undefined, 'nonsense', 'tok-seller']) {
      const res = await worker.fetch(call('/api/admin/overview', { token }), env(), {});
      assert.equal(res.status, 403, `token ${token} got through`);

      const body = await res.json();
      // Same wording every time: an answer that distinguishes "bad token" from
      // "not an operator" tells an attacker which half to work on.
      assert.equal(body.error, 'Not authorised');
    }
  } finally { restore(); }
});

test('a signed-in seller cannot reach the console even with a valid token', async () => {
  const { sb, restore } = ctx();
  try {
    const res = await worker.fetch(call('/api/admin/tenants', { token: 'tok-seller' }), env(), {});
    assert.equal(res.status, 403);
  } finally { restore(); }
});

test('support can look, but cannot move money or change a plan', async () => {
  const { sb, restore } = ctx();
  try {
    const look = await worker.fetch(call('/api/admin/overview', { token: 'tok-support' }), env(), {});
    assert.equal(look.status, 200, 'support should be able to read');

    // Owner-level: releasing funds.
    const release = await worker.fetch(
      call(`/api/admin/escrow/${ORDER}/release`, { token: 'tok-support', method: 'POST', body: {} }),
      env(), {}
    );
    assert.equal(release.status, 403);
    assert.equal(sb.tables.orders[0].escrow_status, 'held', 'support released a hold');
    assert.equal(sb.tables.payouts.length, 0);

    // Owner-level: changing what a tenant gets.
    const flag = await worker.fetch(
      call(`/api/admin/tenants/${TENANT}/flags`, {
        token: 'tok-support', method: 'POST', body: { flag: 'analytics', enabled: true },
      }),
      env(), {}
    );
    assert.equal(flag.status, 403);
    assert.equal(sb.tables.tenant_features[0].enabled, false, 'support changed a flag');
  } finally { restore(); }
});

test('support CAN resolve a dispute — that is the level\'s job', async () => {
  const { sb, restore } = ctx();
  try {
    const res = await worker.fetch(
      call(`/api/admin/disputes/${DISPUTE}/resolve`, {
        token: 'tok-support', method: 'POST', body: { outcome: 'no_action', resolution: 'Buyer withdrew' },
      }),
      env(), {}
    );
    assert.equal(res.status, 200);
    assert.equal(sb.tables.disputes[0].status, 'resolved');
    assert.equal(sb.tables.disputes[0].resolved_by, SUPPORT.id);
  } finally { restore(); }
});

// ── owner actions ────────────────────────────────────────────────────────────

test('an owner can flip a flag, and it is audited', async () => {
  const { sb, restore } = ctx();
  try {
    const res = await worker.fetch(
      call(`/api/admin/tenants/${TENANT}/flags`, {
        token: 'tok-owner', method: 'POST', body: { flag: 'analytics', enabled: true },
      }),
      env(), {}
    );
    assert.equal(res.status, 200);
    assert.equal(sb.tables.tenant_features[0].enabled, true);

    const entry = sb.tables.operator_audit.at(-1);
    assert.equal(entry.action, 'flag.set');
    assert.equal(entry.actor, OWNER.id);
    assert.equal(entry.subject, 'analytics');
    assert.deepEqual(entry.detail, { enabled: true });
  } finally { restore(); }
});

test('a flag that has no row yet is created rather than silently ignored', async () => {
  const { sb, restore } = ctx();
  try {
    await worker.fetch(
      call(`/api/admin/tenants/${TENANT}/flags`, {
        token: 'tok-owner', method: 'POST', body: { flag: 'ai_match', enabled: true },
      }),
      env(), {}
    );
    const row = sb.tables.tenant_features.find((f) => f.flag === 'ai_match');
    assert.ok(row, 'no row was inserted');
    assert.equal(row.enabled, true);
  } finally { restore(); }
});

test('a malformed flag request changes nothing', async () => {
  const { sb, restore } = ctx();
  try {
    for (const body of [{}, { flag: 'analytics' }, { flag: 5, enabled: true }, { flag: 'x', enabled: 'yes' }]) {
      const res = await worker.fetch(
        call(`/api/admin/tenants/${TENANT}/flags`, { token: 'tok-owner', method: 'POST', body }),
        env(), {}
      );
      assert.equal(res.status, 400, `accepted ${JSON.stringify(body)}`);
    }
    assert.equal(sb.tables.tenant_features[0].enabled, false);
    assert.equal(sb.tables.operator_audit.length, 0, 'a rejected request was audited');
  } finally { restore(); }
});

test('suspending a tenant is recorded, and a bogus status is refused', async () => {
  const { sb, restore } = ctx();
  try {
    const bad = await worker.fetch(
      call(`/api/admin/tenants/${TENANT}/status`, {
        token: 'tok-owner', method: 'POST', body: { status: 'deleted' },
      }),
      env(), {}
    );
    assert.equal(bad.status, 400);
    assert.equal(sb.tables.tenants[0].status, 'active');

    const ok = await worker.fetch(
      call(`/api/admin/tenants/${TENANT}/status`, {
        token: 'tok-owner', method: 'POST', body: { status: 'suspended' },
      }),
      env(), {}
    );
    assert.equal(ok.status, 200);
    assert.equal(sb.tables.tenants[0].status, 'suspended');
    assert.equal(sb.tables.operator_audit.at(-1).action, 'tenant.status');
  } finally { restore(); }
});

test('forcing a release pays once, and a second press pays nothing', async () => {
  const { sb, restore } = ctx();
  try {
    const first = await worker.fetch(
      call(`/api/admin/escrow/${ORDER}/release`, {
        token: 'tok-owner', method: 'POST', body: { reason: 'Buyer confirmed by phone' },
      }),
      env(), {}
    );
    assert.equal((await first.json()).released, true);
    assert.equal(sb.tables.orders[0].escrow_status, 'released');
    assert.equal(sb.tables.payouts.length, 1);
    assert.equal(sb.tables.payouts[0].amount, 32200, '35000 less the 2800 charged');

    const second = await worker.fetch(
      call(`/api/admin/escrow/${ORDER}/release`, { token: 'tok-owner', method: 'POST', body: {} }),
      env(), {}
    );
    assert.equal((await second.json()).already, true);
    assert.equal(sb.tables.payouts.length, 1, 'a second release paid again');

    const entry = sb.tables.operator_audit.find((e) => e.action === 'escrow.release');
    assert.equal(entry.detail.reason, 'Buyer confirmed by phone');
    assert.equal(entry.subject, 'UT-2001');
  } finally { restore(); }
});

// ── disputes ─────────────────────────────────────────────────────────────────

test('resolving for the seller releases the hold', async () => {
  const { sb, restore } = ctx();
  try {
    await worker.fetch(
      call(`/api/admin/disputes/${DISPUTE}/resolve`, {
        token: 'tok-owner', method: 'POST', body: { outcome: 'released', resolution: 'Tracking shows delivered' },
      }),
      env(), {}
    );

    assert.equal(sb.tables.orders[0].escrow_status, 'released');
    assert.equal(sb.tables.payouts.length, 1);
    assert.equal(sb.tables.disputes[0].outcome, 'released');
  } finally { restore(); }
});

test('resolving for the buyer reverses the hold and pays nobody', async () => {
  const { sb, restore } = ctx();
  try {
    await worker.fetch(
      call(`/api/admin/disputes/${DISPUTE}/resolve`, {
        token: 'tok-owner', method: 'POST', body: { outcome: 'refunded', resolution: 'Never arrived' },
      }),
      env(), {}
    );

    assert.equal(sb.tables.orders[0].escrow_status, 'refunded');
    assert.equal(sb.tables.orders[0].status, 'refunded');
    assert.equal(sb.tables.payouts.length, 0, 'a refund paid the seller');

    // The payment reference is carried into the audit row, because returning
    // the money to the card is a separate deliberate step and whoever does it
    // needs the reference.
    const entry = sb.tables.operator_audit.at(-1);
    assert.equal(entry.detail.payment_ref, 'REF-9');
    assert.equal(entry.detail.moved, 'refunded');
  } finally { restore(); }
});

test('an already-resolved dispute is not resolved twice', async () => {
  const { sb, restore } = ctx();
  try {
    const body = { outcome: 'released', resolution: 'first' };
    await worker.fetch(
      call(`/api/admin/disputes/${DISPUTE}/resolve`, { token: 'tok-owner', method: 'POST', body }),
      env(), {}
    );
    const again = await worker.fetch(
      call(`/api/admin/disputes/${DISPUTE}/resolve`, {
        token: 'tok-owner', method: 'POST', body: { outcome: 'refunded', resolution: 'second' },
      }),
      env(), {}
    );

    assert.equal((await again.json()).already, true);
    assert.equal(sb.tables.disputes[0].outcome, 'released', 'outcome was overwritten');
    assert.equal(sb.tables.payouts.length, 1);
  } finally { restore(); }
});

test('a bogus outcome is refused', async () => {
  const { sb, restore } = ctx();
  try {
    const res = await worker.fetch(
      call(`/api/admin/disputes/${DISPUTE}/resolve`, {
        token: 'tok-owner', method: 'POST', body: { outcome: 'pay_me' },
      }),
      env(), {}
    );
    assert.equal(res.status, 400);
    assert.equal(sb.tables.disputes[0].status, 'open');
  } finally { restore(); }
});

// ── reads ────────────────────────────────────────────────────────────────────

test('the overview counts overdue holds, which is how a stuck sweep shows up', async () => {
  const sb = makeFakeSupabase({
    ...seed(),
    orders: [
      { id: 'o1', tenant_id: TENANT, amount: 1000, commission: 80, status: 'completed', escrow_status: 'released' },
      { id: 'o2', tenant_id: TENANT, amount: 2000, commission: 160, status: 'escrow', escrow_status: 'held',
        confirm_deadline: new Date(Date.now() - 86_400_000).toISOString() },
      { id: 'o3', tenant_id: TENANT, amount: 3000, commission: 240, status: 'escrow', escrow_status: 'held',
        confirm_deadline: new Date(Date.now() + 86_400_000).toISOString() },
    ],
  });
  const restore = installFetch({ supabase: sb, tokens: TOKENS });
  try {
    const res = await worker.fetch(call('/api/admin/overview', { token: 'tok-owner' }), env(), {});
    const body = await res.json();

    assert.equal(body.escrow.held, 2);
    assert.equal(body.escrow.amount, 5000);
    assert.equal(body.escrow.overdue, 1, 'an overdue hold went uncounted');
    assert.equal(body.gmv, 1000, 'only settled orders count toward GMV');

    // Settled commission only. A hold can still be refunded, and counting it
    // as revenue would make the platform's earnings drop when a dispute is
    // resolved — a number nobody can reconcile against a bank statement.
    assert.equal(body.commission, 80, 'escrow commission counted as earned');
    assert.equal(body.escrow.commissionPending, 400, 'pending commission not reported');
  } finally { restore(); }
});

test('a tenant view never returns the Paystack subaccount', async () => {
  const sb = makeFakeSupabase({
    ...seed(),
    tenants: [{ id: TENANT, slug: 'store', name: 'Store', tier: 'growth', status: 'active',
                commission_pct: 8, paystack_subaccount: 'ACCT_secret' }],
  });
  const restore = installFetch({ supabase: sb, tokens: TOKENS });
  try {
    const res = await worker.fetch(
      call(`/api/admin/tenants/${TENANT}`, { token: 'tok-owner' }), env(), {}
    );
    const text = await res.text();
    assert.equal(text.includes('ACCT_secret'), false, 'a credential reached the console');
  } finally { restore(); }
});

test('/me reports the level the console should draw for', async () => {
  const { restore } = ctx();
  try {
    for (const [token, level] of [['tok-owner', 'owner'], ['tok-support', 'support']]) {
      const res = await worker.fetch(call('/api/admin/me', { token }), env(), {});
      assert.equal((await res.json()).level, level);
    }
  } finally { restore(); }
});

// ── approving a store that signed up over WhatsApp ───────────────────────────

const PENDING = 'dddddddd-0000-0000-0000-00000000000d';
const PENDING_PHONE = '2349999999999';
const PENDING_CHAT = '99887766554433@lid';

// A store waiting on approval, plus the two things approval reaches that the
// PostgREST fake does not: GoTrue's link generator, and WAHA.
function approvalCtx({ accounts = {}, generateStatus = 200, wahaStatus = 200 } = {}) {
  const sb = makeFakeSupabase({
    ...seed(),
    tenants: [
      ...seed().tenants,
      { id: PENDING, slug: 'ada-stores', name: 'Ada Stores', tier: 'starter',
        status: 'onboarding', commission_pct: 8, whatsapp_number: PENDING_PHONE },
    ],
    signups: [
      { phone: PENDING_PHONE, chat_id: PENDING_CHAT, state: 'pending',
        business_name: 'Ada Stores', email: 'ada@example.com' },
    ],
  });

  const generated = [];
  const sent = [];
  const waha = {
    url: 'https://waha.test',
    handler: async (url, init) => {
      if (new URL(url).pathname !== '/api/sendText') return new Response('?', { status: 500 });
      if (wahaStatus !== 200) return new Response('down', { status: wahaStatus });
      sent.push(JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    },
  };

  const restore = installFetch({ supabase: sb, tokens: TOKENS, waha });
  const routed = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = requestUrl(input);
    if (url.includes('/rest/v1/rpc/user_id_for_email')) {
      const { addr } = JSON.parse(init.body);
      return new Response(JSON.stringify(accounts[addr] ?? null), { status: 200 });
    }
    if (url.includes('/auth/v1/admin/generate_link')) {
      if (generateStatus !== 200) return new Response('{}', { status: generateStatus });
      const body = JSON.parse(init.body);
      generated.push({ ...body, url });
      return new Response(
        JSON.stringify({
          user: { id: 'user-new-owner', email: body.email },
          properties: { action_link: 'https://project.supabase.co/auth/v1/verify?token=owner' },
        }),
        { status: 200 }
      );
    }
    return routed(input, init);
  };

  return { sb, generated, sent, restore };
}

function approve(status = 'active') {
  return worker.fetch(
    call(`/api/admin/tenants/${PENDING}/status`, { token: 'tok-owner', method: 'POST', body: { status } }),
    env({
      WAHA_URL: 'https://waha.test',
      WAHA_API_KEY: 'k',
      WAHA_SESSION: 'ut-platform',
      PUBLIC_ORIGIN: 'https://uniquethrift.ng',
    }),
    {}
  );
}

const pending = (sb) => sb.tables.tenants.find((t) => t.id === PENDING);

test('approving a sign-up makes the owner and tells them on WhatsApp', async () => {
  const { sb, generated, sent, restore } = approvalCtx();
  try {
    const res = await approve();
    assert.equal(res.status, 200);
    assert.deepEqual(
      { notified: true, link: null },
      (({ notified, link }) => ({ notified, link }))(await res.json())
    );

    assert.equal(pending(sb).status, 'active');
    assert.equal(generated.length, 1);
    assert.equal(generated[0].type, 'invite');
    assert.equal(generated[0].email, 'ada@example.com');
    assert.match(generated[0].url, /redirect_to=https%3A%2F%2Funiquethrift\.ng%2Fdashboard/);

    const owner = sb.tables.tenant_members.find((m) => m.tenant_id === PENDING);
    assert.equal(owner.user_id, 'user-new-owner');
    assert.equal(owner.role, 'owner');

    // Back to the chat they signed up from, with their set-password link.
    assert.equal(sent.length, 1);
    assert.equal(sent[0].session, 'ut-platform');
    assert.equal(sent[0].chatId, PENDING_CHAT);
    assert.match(sent[0].text, /Ada Stores\* is approved/);
    assert.match(sent[0].text, /verify\?token=owner/);
    // And the address of their store's own page, live from now.
    assert.match(sent[0].text, /\/s\/ada-stores/);

    assert.equal(sb.tables.signups.length, 0);
    // Reseeded for the plan they chose, not a fixed one.
    const reseed = sb.calls.find((c) => c.rpc === 'seed_tenant_features');
    assert.deepEqual(reseed?.args, { target: PENDING, plan: 'starter' });
    assert.equal(sb.tables.operator_audit.at(-1).action, 'tenant.approve');
  } finally { restore(); }
});

test('an email that already has an account is linked, and no login link goes out', async () => {
  // Otherwise typing somebody else's email into the bot, and waiting for an
  // approval, would hand over a login to their account.
  const { sb, generated, sent, restore } = approvalCtx({
    accounts: { 'ada@example.com': 'user-existing' },
  });
  try {
    const res = await approve();
    assert.equal(res.status, 200);
    assert.equal(generated.length, 0);

    const owner = sb.tables.tenant_members.find((m) => m.tenant_id === PENDING);
    assert.equal(owner.user_id, 'user-existing');
    assert.match(sent[0].text, /existing account \(ada@example\.com\)/);
    assert.doesNotMatch(sent[0].text, /verify/);
  } finally { restore(); }
});

test('when WhatsApp cannot deliver the approval, the operator is handed the link', async () => {
  const { sb, restore } = approvalCtx({ wahaStatus: 500 });
  try {
    const body = await (await approve()).json();
    assert.equal(body.notified, false);
    assert.equal(body.link, 'https://project.supabase.co/auth/v1/verify?token=owner');
    assert.equal(pending(sb).status, 'active');
  } finally { restore(); }
});

test('an approval that cannot make the account changes nothing', async () => {
  const { sb, sent, restore } = approvalCtx({ generateStatus: 500 });
  try {
    const res = await approve();
    assert.equal(res.status, 502);
    assert.equal(pending(sb).status, 'onboarding');
    assert.equal(sb.tables.signups.length, 1, 'kept, so approving again can finish it');
    assert.equal(sent.length, 0);
  } finally { restore(); }
});

test('turning a sign-up down creates nobody and says nothing', async () => {
  const { sb, generated, sent, restore } = approvalCtx();
  try {
    const res = await approve('suspended');
    assert.equal(res.status, 200);
    assert.equal(pending(sb).status, 'suspended');
    assert.equal(generated.length, 0);
    assert.equal(sent.length, 0);
    assert.equal(sb.tables.tenant_members.filter((m) => m.tenant_id === PENDING).length, 0);
  } finally { restore(); }
});

test('an operator sees who is asking for a pending store', async () => {
  const { restore } = approvalCtx();
  try {
    const res = await worker.fetch(call(`/api/admin/tenants/${PENDING}`, { token: 'tok-support' }), env(), {});
    const body = await res.json();
    assert.equal(body.signup.email, 'ada@example.com');
    assert.equal(body.tenant.whatsapp_number, PENDING_PHONE);
  } finally { restore(); }
});

// ── managing stores ──────────────────────────────────────────────────────────

test('an owner moves a store to another plan: tier, commission and features, audited', async () => {
  const { sb, restore } = ctx();
  // An override set by hand, which the plan change is meant to replace.
  sb.tables.tenant_features.push({ tenant_id: TENANT, flag: 'contacts', enabled: false });
  try {
    const res = await worker.fetch(
      call(`/api/admin/tenants/${TENANT}/plan`, {
        token: 'tok-owner', method: 'POST', body: { tier: 'business', commission_pct: 6.5 },
      }),
      env(), {}
    );
    assert.equal(res.status, 200);

    const t = sb.tables.tenants[0];
    assert.equal(t.tier, 'business');
    assert.equal(t.commission_pct, 6.5);

    const flag = (f) => sb.tables.tenant_features.find((r) => r.tenant_id === TENANT && r.flag === f)?.enabled;
    assert.equal(flag('analytics'), true);
    assert.equal(flag('contacts'), true);
    assert.equal(flag('team'), true);
    // One row per flag, updated in place.
    assert.equal(sb.tables.tenant_features.filter((r) => r.flag === 'contacts').length, 1);

    const row = sb.tables.operator_audit.at(-1);
    assert.equal(row.action, 'tenant.plan');
    assert.deepEqual(row.detail.from, { tier: 'growth', commission_pct: 8, plan_price: null });
    assert.deepEqual(row.detail.to, { tier: 'business', commission_pct: 6.5 });

    // And back down: Business features switch off again.
    await worker.fetch(
      call(`/api/admin/tenants/${TENANT}/plan`, {
        token: 'tok-owner', method: 'POST', body: { tier: 'starter', commission_pct: 8 },
      }),
      env(), {}
    );
    assert.equal(flag('analytics'), false);
    assert.equal(flag('contacts'), false);
  } finally { restore(); }
});

test('a plan change needs an owner and a sensible plan and commission', async () => {
  const { sb, restore } = ctx();
  try {
    const support = await worker.fetch(
      call(`/api/admin/tenants/${TENANT}/plan`, {
        token: 'tok-support', method: 'POST', body: { tier: 'business', commission_pct: 5 },
      }),
      env(), {}
    );
    assert.equal(support.status, 403);

    for (const body of [{ tier: 'platinum', commission_pct: 5 }, { tier: 'growth', commission_pct: 150 }, { tier: 'growth' }]) {
      const res = await worker.fetch(
        call(`/api/admin/tenants/${TENANT}/plan`, { token: 'tok-owner', method: 'POST', body }),
        env(), {}
      );
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(sb.tables.tenants[0].tier, 'growth');
    assert.equal(sb.tables.tenants[0].commission_pct, 8);
  } finally { restore(); }
});

test("an owner corrects a store's details, and the number is normalised", async () => {
  const { sb, restore } = ctx();
  try {
    const res = await worker.fetch(
      call(`/api/admin/tenants/${TENANT}/details`, {
        token: 'tok-owner', method: 'POST',
        body: { name: '  Ada   Thrift ', whatsapp_number: '0801 234 5678', store_type: 'brand', category: 'fashion' },
      }),
      env(), {}
    );
    assert.equal(res.status, 200);
    const t = sb.tables.tenants[0];
    assert.equal(t.name, 'Ada Thrift');
    assert.equal(t.whatsapp_number, '2348012345678');
    assert.equal(t.store_type, 'brand');
    assert.equal(t.category, 'fashion');
    // The slug is untouched: it is in every link already shared.
    assert.equal(t.slug, 'store');
    assert.equal(sb.tables.operator_audit.at(-1).action, 'tenant.details');
  } finally { restore(); }
});

test('bad details are refused, and a number another store has is a 409', async () => {
  const { sb, restore } = ctx();
  sb.tables.tenants.push({ id: 'eeeeeeee-0000-0000-0000-00000000000e', slug: 'other', name: 'Other', whatsapp_number: '2348011111111' });
  try {
    for (const body of [{ name: 'x' }, { whatsapp_number: '12' }, { store_type: 'shop' }, { category: 'cars' }, {}]) {
      const res = await worker.fetch(
        call(`/api/admin/tenants/${TENANT}/details`, { token: 'tok-owner', method: 'POST', body }),
        env(), {}
      );
      assert.equal(res.status, 400, JSON.stringify(body));
    }

    const taken = await worker.fetch(
      call(`/api/admin/tenants/${TENANT}/details`, {
        token: 'tok-owner', method: 'POST', body: { whatsapp_number: '08011111111' },
      }),
      env(), {}
    );
    assert.equal(taken.status, 409);
    assert.match((await taken.json()).error, /another store/);
  } finally { restore(); }
});

test("a pending store's new number carries its sign-up with it", async () => {
  const { sb, restore } = approvalCtx();
  try {
    const res = await worker.fetch(
      call(`/api/admin/tenants/${PENDING}/details`, {
        token: 'tok-owner', method: 'POST', body: { whatsapp_number: '2348022222222' },
      }),
      env(), {}
    );
    assert.equal(res.status, 200);
    assert.equal(pending(sb).whatsapp_number, '2348022222222');
    assert.equal(sb.tables.signups[0].phone, '2348022222222');
  } finally { restore(); }
});

test("a store view shows what it has listed and what is waiting on it", async () => {
  const { sb, restore } = ctx();
  sb.tables.products.push(
    { id: 'p1', tenant_id: TENANT, public_code: 'AA11', title: 'Bag', price: 10000, status: 'active', images: [] },
    { id: 'p2', tenant_id: TENANT, public_code: 'BB22', title: 'Shoe', price: 5000, status: 'sold', images: [] },
    { id: 'p3', tenant_id: 'someone-else', public_code: 'CC33', title: 'Not theirs', price: 1, status: 'active', images: [] },
  );
  sb.tables.submissions.push(
    { id: 's1', tenant_id: TENANT, title: 'Dress', asking_price: 8000, status: 'pending', images: [] },
    { id: 's2', tenant_id: TENANT, title: 'Hat', asking_price: 2000, status: 'declined', images: [] },
  );
  sb.tables.tenant_members.push({ tenant_id: TENANT, user_id: 'u1', role: 'owner', email: 'ada@example.com' });
  try {
    const res = await worker.fetch(call(`/api/admin/tenants/${TENANT}`, { token: 'tok-support' }), env(), {});
    const body = await res.json();
    assert.deepEqual(body.listings.counts, { active: 1, sold: 1 });
    assert.deepEqual(body.listings.recent.map((p) => p.public_code).sort(), ['AA11', 'BB22']);
    assert.deepEqual(body.submissions.counts, { pending: 1, declined: 1 });
    assert.deepEqual(body.submissions.pending.map((x) => x.title), ['Dress']);
    assert.equal(body.members[0].email, 'ada@example.com');
  } finally { restore(); }
});

test('the overview reports the platform number: what WAHA says and when we last heard', async () => {
  const sb = makeFakeSupabase({
    ...seed(),
    webhook_activity: [{ session: 'ut-platform', last_event_at: '2026-09-26T10:00:00Z', last_message_at: '2026-09-26T09:59:00Z' }],
  });
  const waha = {
    url: 'https://waha.test',
    handler: async (url) => {
      if (new URL(url).pathname === '/api/sessions/ut-platform') {
        return new Response(JSON.stringify({
          name: 'ut-platform', status: 'WORKING',
          me: { id: '2348154765611@c.us', pushName: 'Unique Thrift' },
          config: { webhooks: [{ url: 'https://uniquethrift.ng/api/waha/webhook' }] },
        }), { status: 200 });
      }
      return new Response('?', { status: 404 });
    },
  };
  const restore = installFetch({ supabase: sb, tokens: TOKENS, waha });
  try {
    const res = await worker.fetch(
      call('/api/admin/overview', { token: 'tok-support' }),
      env({ WAHA_URL: 'https://waha.test', WAHA_API_KEY: 'k', WAHA_SESSION: 'ut-platform', PUBLIC_ORIGIN: 'https://uniquethrift.ng' }),
      {}
    );
    const { platform } = await res.json();
    assert.equal(platform.status, 'WORKING');
    assert.equal(platform.number, '2348154765611');
    assert.equal(platform.webhookOk, true);
    assert.equal(platform.lastMessageAt, '2026-09-26T09:59:00Z');
  } finally { restore(); }

  // WAHA unreachable is reported, not thrown.
  const sb2 = makeFakeSupabase(seed());
  const restore2 = installFetch({
    supabase: sb2, tokens: TOKENS,
    waha: { url: 'https://waha.test', handler: async () => new Response('down', { status: 502 }) },
  });
  try {
    const res = await worker.fetch(
      call('/api/admin/overview', { token: 'tok-support' }),
      env({ WAHA_URL: 'https://waha.test', WAHA_API_KEY: 'k', WAHA_SESSION: 'ut-platform' }),
      {}
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).platform.status, 'UNREACHABLE');
  } finally { restore2(); }
});
