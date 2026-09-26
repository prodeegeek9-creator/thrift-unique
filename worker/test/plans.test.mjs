import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../index.js';
import { makeFakeSupabase, installFetch, env } from './fake-supabase.mjs';
import { runBilling } from '../routes/escrow.js';
import { quoteChange } from '../lib/planChange.js';
import { pickNudge, NUDGE_LISTINGS } from '../lib/nudges.js';

// Stores changing their own plan, and the nudges to move up.

const TENANT = 'aaaaaaaa-0000-0000-0000-00000000000a';
const OWNER = { id: 'user-owner', email: 'owner@store.test' };
const MANAGER = { id: 'user-manager', email: 'manager@store.test' };
const TOKENS = { 'tok-owner': OWNER, 'tok-manager': MANAGER };
const WAHA_URL = 'https://waha.test';
const DAY = 86_400_000;
const NOW = new Date();
const iso = (ms) => new Date(ms).toISOString();

function seed(tenant = {}, extra = {}) {
  return {
    tenants: [{
      id: TENANT, slug: 'ada', name: 'Ada Thrift', tier: 'starter', status: 'active', commission_pct: 8,
      whatsapp_number: '2348022222222', billing_status: 'active', paid_until: iso(NOW.getTime() + 15 * DAY),
      plan_price: null, auto_renew: false, next_tier: null, next_tier_at: null, ...tenant,
    }],
    tenant_members: [
      { tenant_id: TENANT, user_id: OWNER.id, role: 'owner', email: OWNER.email },
      { tenant_id: TENANT, user_id: MANAGER.id, role: 'manager' },
    ],
    tenant_features: [],
    plan_invoices: [],
    products: [],
    orders: [],
    nudge_events: [],
    ...extra,
  };
}

function fakeWaha() {
  const sent = [];
  return { sent, waha: { url: WAHA_URL, handler: async (url, init) => {
    if (new URL(url).pathname === '/api/sendText') sent.push(JSON.parse(init.body));
    return new Response('{}', { status: 200 });
  } } };
}

const E = (extra = {}) =>
  env({ WAHA_URL, WAHA_API_KEY: 'k', WAHA_SESSION: 'ut-platform', PUBLIC_ORIGIN: 'https://vendwyze.test', WAHA_TYPING_MS: '0', ...extra });

const post = (path, body, token = 'tok-owner') =>
  new Request(`https://vendwyze.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const get = (path, token = 'tok-owner') =>
  new Request(`https://vendwyze.test${path}`, { headers: { Authorization: `Bearer ${token}` } });

async function signed(body, secret = 'sk_test_secret') {
  const raw = JSON.stringify(body);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  const sig = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return new Request('https://vendwyze.test/api/paystack/webhook', { method: 'POST', headers: { 'x-paystack-signature': sig }, body: raw });
}

const change = (tier, token) => worker.fetch(post('/api/billing/change-plan', { tenant: TENANT, tier }, token), E(), {});
const tenantRow = (sb) => sb.tables.tenants[0];
const flag = (sb, name) => sb.tables.tenant_features.find((f) => f.flag === name)?.enabled;

// ── what a change would do ───────────────────────────────────────────────────

test('the quote: the difference for the days left, free on trial, down at period end', () => {
  const paying = { tier: 'starter', status: 'active', billing_status: 'active', plan_price: null, paid_until: iso(NOW.getTime() + 15 * DAY) };
  const up = quoteChange(paying, 'growth', NOW);
  assert.equal(up.kind, 'upgrade');
  assert.equal(up.when, 'now');
  assert.equal(up.amount, 7500, '₦15,000 more a month, for half a month');

  assert.equal(quoteChange({ ...paying, billing_status: 'trial' }, 'business', NOW).amount, 0);
  assert.equal(quoteChange({ ...paying, paid_until: iso(NOW.getTime() + 3600_000) }, 'growth', NOW).amount, 0, 'under ₦100 is not worth a payment');

  const down = quoteChange({ ...paying, tier: 'growth' }, 'starter', NOW);
  assert.equal(down.when, 'next_period');
  assert.equal(down.effective_at, paying.paid_until);
  assert.equal(quoteChange({ ...paying, tier: 'growth', billing_status: 'trial' }, 'starter', NOW).when, 'now');

  assert.match(quoteChange({ ...paying, plan_price: 0 }, 'growth', NOW).blocked, /agreed with Vendwyze/);
  assert.match(quoteChange({ ...paying, billing_status: 'past_due' }, 'growth', NOW).blocked, /overdue/);
  assert.equal(quoteChange(paying, 'starter', NOW).kind, 'keep');
});

// ── changing ────────────────────────────────────────────────────────────────

test('only the owner can change the plan', async () => {
  const sb = makeFakeSupabase(seed({ billing_status: 'trial' }));
  const restore = installFetch({ supabase: sb, tokens: TOKENS });
  try {
    assert.equal((await change('growth', 'tok-manager')).status, 403);
    assert.equal(tenantRow(sb).tier, 'starter');
  } finally { restore(); }
});

test('on the free trial an upgrade is immediate: plan, features and standard commission', async () => {
  const sb = makeFakeSupabase(seed({ billing_status: 'trial' }));
  const restore = installFetch({ supabase: sb, tokens: TOKENS });
  try {
    const res = await change('growth');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).done, 'changed');
    assert.equal(tenantRow(sb).tier, 'growth');
    assert.equal(tenantRow(sb).commission_pct, 7);
    assert.equal(flag(sb, 'escrow'), true);
    assert.equal(flag(sb, 'analytics'), false);
  } finally { restore(); }
});

test('an agreed commission is not touched by a plan change', async () => {
  const sb = makeFakeSupabase(seed({ billing_status: 'trial', commission_pct: 5 }));
  const restore = installFetch({ supabase: sb, tokens: TOKENS });
  try {
    await change('growth');
    assert.equal(tenantRow(sb).commission_pct, 5);
  } finally { restore(); }
});

test('a paying store upgrades once the difference is paid, and keeps its renewal date', async () => {
  const sb = makeFakeSupabase(seed());
  const paidUntil = tenantRow(sb).paid_until;
  const { waha, sent } = fakeWaha();
  const restore = installFetch({ supabase: sb, tokens: TOKENS, waha });
  try {
    const res = await change('growth');
    const body = await res.json();
    assert.equal(body.done, 'pay');
    assert.equal(body.amount, 7500);
    assert.match(body.pay_url, /^https:\/\/vendwyze\.test\/billing\/pay\/utb_/);
    assert.equal(tenantRow(sb).tier, 'starter', 'upgraded before paying');

    const invoice = sb.tables.plan_invoices.find((i) => i.kind === 'upgrade');
    assert.equal(invoice.from_tier, 'starter');
    assert.equal(invoice.tier, 'growth');

    // Paystack confirms the payment.
    const hook = await worker.fetch(
      await signed({ event: 'charge.success', data: { reference: `${invoice.payment_ref}_ab12cd`, amount: 750_000, metadata: { kind: 'plan', invoice_ref: invoice.payment_ref } } }),
      E({ PAYSTACK_SECRET_KEY: 'sk_test_secret' }),
      {}
    );
    assert.equal(hook.status, 200);
    assert.equal(invoice.status, 'paid');
    assert.equal(tenantRow(sb).tier, 'growth');
    assert.equal(flag(sb, 'escrow'), true);
    assert.equal(tenantRow(sb).paid_until, paidUntil, 'the renewal date moved');
    assert.match(sent.at(-1).text, /on \*Growth\* now/);
  } finally { restore(); }
});

test('asking again replaces an unpaid upgrade rather than stacking them', async () => {
  const sb = makeFakeSupabase(seed());
  const restore = installFetch({ supabase: sb, tokens: TOKENS });
  try {
    await change('growth');
    await change('business');
    const open = sb.tables.plan_invoices.filter((i) => i.kind === 'upgrade' && i.status === 'open');
    assert.equal(open.length, 1);
    assert.equal(open[0].tier, 'business');
  } finally { restore(); }
});

test('a downgrade waits for the end of the paid month, bills the lower price, then switches', async () => {
  const sb = makeFakeSupabase(seed({ tier: 'growth', commission_pct: 7, paid_until: iso(NOW.getTime() + 2 * DAY) }));
  const restore = installFetch({ supabase: sb, tokens: TOKENS });
  try {
    const body = await (await change('starter')).json();
    assert.equal(body.done, 'scheduled');
    assert.equal(tenantRow(sb).tier, 'growth', 'downgraded before the paid month ended');
    assert.equal(tenantRow(sb).next_tier, 'starter');

    // The next month's invoice (raised three days ahead) is at Starter's price.
    await runBilling(E(), { now: NOW });
    const next = sb.tables.plan_invoices.find((i) => (i.kind ?? 'period') === 'period');
    assert.equal(next.tier, 'starter');
    assert.equal(next.amount, 10000);

    // After the paid month: on Starter.
    await runBilling(E(), { now: new Date(NOW.getTime() + 3 * DAY) });
    assert.equal(tenantRow(sb).tier, 'starter');
    assert.equal(tenantRow(sb).commission_pct, 8);
    assert.equal(tenantRow(sb).next_tier, null);
  } finally { restore(); }
});

test('choosing the current plan again calls off a scheduled downgrade', async () => {
  const sb = makeFakeSupabase(seed({ tier: 'growth', commission_pct: 7 }));
  const restore = installFetch({ supabase: sb, tokens: TOKENS });
  try {
    await change('starter');
    assert.equal(tenantRow(sb).next_tier, 'starter');
    assert.equal((await (await change('growth')).json()).done, 'kept');
    assert.equal(tenantRow(sb).next_tier, null);
  } finally { restore(); }
});

test('an agreed price or an overdue fee means no self-serve change', async () => {
  for (const extra of [{ plan_price: 0 }, { billing_status: 'past_due' }]) {
    const sb = makeFakeSupabase(seed(extra));
    const restore = installFetch({ supabase: sb, tokens: TOKENS });
    try {
      const res = await change('growth');
      assert.equal(res.status, 409, JSON.stringify(extra));
      assert.equal(tenantRow(sb).tier, 'starter');
    } finally { restore(); }
  }
});

// ── nudges ───────────────────────────────────────────────────────────────────

test('which nudge: a locked screen, then a big sale, then sales, then listings', () => {
  const t = { tier: 'starter', billing_status: 'active', plan_price: null };
  const quiet = { locked: [], biggest: 0, sales: 0, listings: 0 };
  assert.equal(pickNudge(t, quiet), null);
  assert.equal(pickNudge(t, { ...quiet, listings: NUDGE_LISTINGS.starter }).reason, 'listings');
  assert.equal(pickNudge(t, { ...quiet, listings: 20, sales: 300_000 }).reason, 'sales');
  assert.equal(pickNudge(t, { ...quiet, sales: 300_000, biggest: 60_000 }).reason, 'big_ticket');
  const locked = pickNudge(t, { ...quiet, biggest: 60_000, locked: ['analytics'] });
  assert.equal(locked.reason, 'locked');
  assert.equal(locked.tier, 'business', 'a Business screen points at Business');

  // Never: on the top plan, an agreed price, overdue, or already moving down.
  const busy = { ...quiet, listings: 100 };
  assert.equal(pickNudge({ ...t, tier: 'business' }, busy), null);
  assert.equal(pickNudge({ ...t, plan_price: 0 }, busy), null);
  assert.equal(pickNudge({ ...t, billing_status: 'paused' }, busy), null);
  assert.equal(pickNudge({ ...t, tier: 'growth', next_tier: 'starter' }, busy), null);
});

test('the dashboard card reads this month, and a locked screen is remembered once a day', async () => {
  const products = Array.from({ length: 16 }, (_, i) => ({ id: `p${i}`, tenant_id: TENANT, created_at: NOW.toISOString() }));
  const sb = makeFakeSupabase(seed({}, { products }));
  const restore = installFetch({ supabase: sb, tokens: TOKENS });
  try {
    let body = await (await worker.fetch(get(`/api/billing/nudge?tenant=${TENANT}`, 'tok-manager'), E(), {})).json();
    assert.equal(body.nudge.reason, 'listings');
    assert.equal(body.nudge.tier, 'growth');

    for (let i = 0; i < 2; i++) {
      await worker.fetch(post('/api/billing/locked', { tenant: TENANT, flag: 'contacts' }, 'tok-manager'), E(), {});
    }
    assert.equal(sb.tables.nudge_events.filter((e) => e.kind === 'locked').length, 1);
    body = await (await worker.fetch(get(`/api/billing/nudge?tenant=${TENANT}`), E(), {})).json();
    assert.equal(body.nudge.reason, 'locked');
  } finally { restore(); }
});

test('WhatsApp nudges go at 9am Lagos time, at most once a fortnight, with a full link', async () => {
  const products = Array.from({ length: 16 }, (_, i) => ({ id: `p${i}`, tenant_id: TENANT, created_at: NOW.toISOString() }));
  const sb = makeFakeSupabase(seed({}, { products }));
  const { waha, sent } = fakeWaha();
  const restore = installFetch({ supabase: sb, tokens: TOKENS, waha });
  const at = (h) => { const d = new Date(NOW); d.setUTCHours(h, 5, 0, 0); return d; };
  try {
    await runBilling(E(), { now: at(14) });
    assert.equal(sent.filter((m) => /💡/.test(m.text)).length, 0, 'sent outside the morning run');

    await runBilling(E(), { now: at(8) });
    const nudges = sent.filter((m) => /💡/.test(m.text));
    assert.equal(nudges.length, 1);
    assert.equal(nudges[0].chatId, '2348022222222@c.us');
    assert.match(nudges[0].text, /listed 16 items this month/);
    assert.match(nudges[0].text, /https:\/\/vendwyze\.test\/dashboard\/billing\?plan=growth/);

    await runBilling(E(), { now: new Date(at(8).getTime() + 3 * DAY) });
    assert.equal(sent.filter((m) => /💡/.test(m.text)).length, 1, 'sent again within a fortnight');
  } finally { restore(); }
});
