import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../index.js';
import { makeFakeSupabase, installFetch, env } from './fake-supabase.mjs';
import { runBilling } from '../routes/escrow.js';
import { startTrial, addMonth, priceFor } from '../lib/billing.js';
import { config } from '../lib/env.js';

// The monthly plan fee: the free trial, invoices and reminders, auto-renew,
// pausing an unpaid store, and paying from the pay page.

const TENANT = 'aaaaaaaa-0000-0000-0000-00000000000a';
const OWNER = { id: 'user-owner', email: 'owner@store.test' };
const STAFF = { id: 'user-staff', email: 'staff@store.test' };
const OP = { id: 'user-op', email: 'op@platform.test' };
const TOKENS = { 'tok-owner': OWNER, 'tok-staff': STAFF, 'tok-op': OP };
const WAHA_URL = 'https://waha.test';
const OWNER_CHAT = '2348022222222@c.us';
const DAY = 86_400_000;
const NOW = new Date('2026-10-10T09:00:00Z');

function seed(tenant = {}, extra = {}) {
  return {
    tenants: [{ id: TENANT, slug: 'ada-thrift', name: 'Ada Thrift', tier: 'growth', status: 'active', commission_pct: 7,
      whatsapp_number: '2348022222222', billing_status: 'trial', paid_until: null, plan_price: null, auto_renew: false, ...tenant }],
    tenant_members: [
      { tenant_id: TENANT, user_id: OWNER.id, role: 'owner', email: OWNER.email },
      { tenant_id: TENANT, user_id: STAFF.id, role: 'staff' },
    ],
    platform_admins: [{ user_id: OP.id, level: 'owner' }],
    operator_audit: [],
    bot_conversations: [],
    bot_messages: [],
    submissions: [],
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

function fakePaystack({ charge = 'success' } = {}) {
  const calls = [];
  return { calls, paystack: async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ path: new URL(url).pathname, body });
    const ok = (data) => new Response(JSON.stringify({ status: true, data }), { status: 200 });
    if (url.endsWith('/transaction/initialize')) return ok({ authorization_url: `https://checkout.paystack.test/${body.reference}` });
    if (url.endsWith('/transaction/charge_authorization')) return ok({ status: charge, gateway_response: charge === 'success' ? 'Approved' : 'Insufficient Funds' });
    return new Response('?', { status: 404 });
  } };
}

const E = (extra = {}) => env({ WAHA_URL, WAHA_API_KEY: 'k', WAHA_SESSION: 'ut-platform', PUBLIC_ORIGIN: 'https://uniquethrift.ng', WAHA_TYPING_MS: '0', WAHA_WEBHOOK_SECRET: 's', ...extra });
const iso = (d) => new Date(d).toISOString();

async function signed(body, secret = 'sk_test_secret') {
  const raw = JSON.stringify(body);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  const sig = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return new Request('https://uniquethrift.ng/api/paystack/webhook', { method: 'POST', headers: { 'x-paystack-signature': sig }, body: raw });
}

test('prices, months and the free period', async () => {
  assert.equal(priceFor({ tier: 'starter' }), 10000);
  assert.equal(priceFor({ tier: 'growth' }), 25000);
  assert.equal(priceFor({ tier: 'business' }), 75000);
  assert.equal(priceFor({ tier: 'business', plan_price: 50000 }), 50000);
  assert.equal(priceFor({ tier: 'growth', plan_price: 0 }), 0);
  assert.equal(addMonth('2026-01-31T10:00:00Z').toISOString(), '2026-02-28T10:00:00.000Z');

  const supabase = makeFakeSupabase(seed({ status: 'onboarding' }));
  const restore = installFetch({ supabase });
  try {
    await startTrial(config(E()), TENANT, NOW);
    assert.equal(supabase.tables.tenants[0].paid_until, iso(NOW.getTime() + 14 * DAY));
    // Only once.
    await startTrial(config(E()), TENANT, new Date(NOW.getTime() + 30 * DAY));
    assert.equal(supabase.tables.tenants[0].paid_until, iso(NOW.getTime() + 14 * DAY));
  } finally { restore(); }
});

test('the invoice opens three days ahead, with a pay link sent once', async () => {
  const supabase = makeFakeSupabase(seed({ paid_until: iso(NOW.getTime() + 2 * DAY) }));
  const { waha, sent } = fakeWaha();
  const restore = installFetch({ supabase, waha });
  try {
    await runBilling(E(), { now: new Date(NOW.getTime() - 3 * DAY) });
    assert.equal(supabase.tables.plan_invoices.length, 0, 'too early');

    await runBilling(E(), { now: NOW });
    const invoice = supabase.tables.plan_invoices[0];
    assert.equal(invoice.amount, 25000);
    assert.equal(invoice.tier, 'growth');
    assert.equal(invoice.period_start, iso(NOW.getTime() + 2 * DAY));
    assert.match(invoice.payment_ref, /^utb_[a-z0-9]{20}$/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, OWNER_CHAT);
    assert.match(sent[0].text, /free trial ends/);
    assert.match(sent[0].text, new RegExp(`/billing/pay/${invoice.payment_ref}`));

    await runBilling(E(), { now: new Date(NOW.getTime() + 3600_000) });
    assert.equal(supabase.tables.plan_invoices.length, 1);
    assert.equal(sent.length, 1, 'reminded twice');
  } finally { restore(); }
});

test('unpaid: past due on the day, paused after the grace period, and the store goes quiet', async () => {
  const supabase = makeFakeSupabase(seed({ paid_until: iso(NOW) }));
  const { waha, sent } = fakeWaha();
  const restore = installFetch({ supabase, waha });
  try {
    await runBilling(E(), { now: new Date(NOW.getTime() + DAY) });
    assert.equal(supabase.tables.tenants[0].billing_status, 'past_due');
    assert.match(sent.at(-1).text, /due today/);

    await runBilling(E(), { now: new Date(NOW.getTime() + 8 * DAY) });
    assert.equal(supabase.tables.tenants[0].billing_status, 'paused');
    assert.match(sent.at(-1).text, /is paused/);

    // The owner messaging the platform gets the way back, not the menu.
    await worker.fetch(new Request('https://uniquethrift.ng/api/waha/webhook', {
      method: 'POST', headers: { 'X-Thrift-Secret': 's' },
      body: JSON.stringify({ event: 'message', session: 'ut-platform', payload: { id: 'm1', from: OWNER_CHAT, body: 'hi', timestamp: 1 } }),
    }), E(), {});
    assert.match(sent.at(-1).text, /paused until the plan fee is paid/);
    assert.match(sent.at(-1).text, /\/billing\/pay\/utb_/);
  } finally { restore(); }
});

test('auto-renew charges the saved card on the day, and nobody is asked for anything', async () => {
  const supabase = makeFakeSupabase(seed({ paid_until: iso(NOW), auto_renew: true, billing_status: 'active' }, {
    billing_cards: [{ tenant_id: TENANT, authorization_code: 'AUTH_x', email: OWNER.email, card_brand: 'visa', card_last4: '4081' }],
  }));
  const { waha, sent } = fakeWaha();
  const { paystack, calls } = fakePaystack();
  const restore = installFetch({ supabase, waha, paystack });
  try {
    await runBilling(E(), { now: new Date(NOW.getTime() + 3600_000) });
    const charge = calls.find((c) => c.path === '/transaction/charge_authorization').body;
    assert.equal(charge.authorization_code, 'AUTH_x');
    assert.equal(charge.amount, 2_500_000);
    assert.equal(charge.metadata.kind, 'plan');

    const invoice = supabase.tables.plan_invoices[0];
    assert.equal(invoice.status, 'paid');
    assert.equal(invoice.paid_via, 'card');
    const t = supabase.tables.tenants[0];
    assert.equal(t.billing_status, 'active');
    assert.equal(t.paid_until, invoice.period_end);
    assert.match(sent.at(-1).text, /Plan paid: ₦25,000 for \*Growth\*/);
  } finally { restore(); }
});

test('a declined card falls back to the pay link', async () => {
  const supabase = makeFakeSupabase(seed({ paid_until: iso(NOW), auto_renew: true, billing_status: 'active' }, {
    billing_cards: [{ tenant_id: TENANT, authorization_code: 'AUTH_x', email: OWNER.email }],
  }));
  const { waha, sent } = fakeWaha();
  const { paystack } = fakePaystack({ charge: 'failed' });
  const restore = installFetch({ supabase, waha, paystack });
  try {
    await runBilling(E(), { now: new Date(NOW.getTime() + 3600_000) });
    assert.equal(supabase.tables.plan_invoices[0].status, 'open');
    assert.match(sent.at(-1).text, /due today/);
  } finally { restore(); }
});

test('paying from the pay page settles the month, restores a paused store and saves the card if asked', async () => {
  const invoice = { id: 'inv1', tenant_id: TENANT, tier: 'growth', amount: 25000, period_start: iso(NOW), period_end: iso(addMonth(NOW)),
    status: 'open', payment_ref: 'utb_abcdefghijkmnpqrstu', reminder_stage: 4 };
  const supabase = makeFakeSupabase(seed({ paid_until: iso(NOW.getTime() - 10 * DAY), billing_status: 'paused' }, { plan_invoices: [invoice] }));
  const { waha, sent } = fakeWaha();
  const { paystack, calls } = fakePaystack();
  const restore = installFetch({ supabase, waha, paystack });
  try {
    const page = await (await worker.fetch(new Request(`https://uniquethrift.ng/api/billing/pay/${invoice.payment_ref}`), E(), {})).json();
    assert.equal(page.amount, 25000);
    assert.equal(page.store, 'Ada Thrift');
    assert.equal(page.paused, true);

    const start = await worker.fetch(new Request(`https://uniquethrift.ng/api/billing/pay/${invoice.payment_ref}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auto_renew: true }),
    }), E(), {});
    assert.equal(start.status, 200);
    const init = calls.find((c) => c.path === '/transaction/initialize').body;
    assert.equal(init.amount, 2_500_000);
    assert.equal(init.email, OWNER.email);
    assert.ok(init.reference.startsWith(`${invoice.payment_ref}_`));
    assert.deepEqual(init.metadata, { kind: 'plan', invoice_ref: invoice.payment_ref, auto_renew: true, email: OWNER.email });

    // Paystack's webhook.
    const res = await worker.fetch(await signed({ event: 'charge.success', data: {
      reference: init.reference, amount: 2_500_000, metadata: init.metadata, customer: { email: OWNER.email },
      authorization: { authorization_code: 'AUTH_new', reusable: true, card_type: 'visa', last4: '4081', exp_month: '12', exp_year: '2030' },
    } }), E(), {});
    assert.equal(res.status, 200);

    assert.equal(supabase.tables.plan_invoices[0].status, 'paid');
    const t = supabase.tables.tenants[0];
    assert.equal(t.billing_status, 'active');
    // Paused, so a full month from the day it paid.
    assert.ok(new Date(t.paid_until) > new Date(Date.now() + 27 * DAY));
    assert.equal(t.auto_renew, true);
    assert.equal(supabase.tables.billing_cards[0].authorization_code, 'AUTH_new');
    assert.match(sent.at(-1).text, /live again/);

    // A replay changes nothing and says nothing more.
    const before = sent.length;
    await worker.fetch(await signed({ event: 'charge.success', data: { reference: init.reference, amount: 2_500_000, metadata: init.metadata } }), E(), {});
    assert.equal(sent.length, before);
  } finally { restore(); }
});

test('a short payment settles nothing', async () => {
  const invoice = { id: 'inv1', tenant_id: TENANT, tier: 'growth', amount: 25000, period_start: iso(NOW), period_end: iso(addMonth(NOW)),
    status: 'open', payment_ref: 'utb_abcdefghijkmnpqrstu' };
  const supabase = makeFakeSupabase(seed({ paid_until: iso(NOW) }, { plan_invoices: [invoice] }));
  const restore = installFetch({ supabase });
  try {
    await worker.fetch(await signed({ event: 'charge.success', data: { reference: 'utb_abcdefghijkmnpqrstu_x', amount: 100, metadata: { kind: 'plan', invoice_ref: invoice.payment_ref } } }), E(), {});
    assert.equal(supabase.tables.plan_invoices[0].status, 'open');
  } finally { restore(); }
});

test('a free store is never invoiced', async () => {
  const supabase = makeFakeSupabase(seed({ paid_until: iso(NOW), plan_price: 0, billing_status: 'active' }));
  const { waha, sent } = fakeWaha();
  const restore = installFetch({ supabase, waha });
  try {
    await runBilling(E(), { now: new Date(NOW.getTime() + 30 * DAY) });
    assert.equal(supabase.tables.plan_invoices.length, 0);
    assert.equal(sent.length, 0);
    assert.equal(supabase.tables.tenants[0].billing_status, 'active');
  } finally { restore(); }
});

test('the Billing page summary, and who may see it and change auto-renew', async () => {
  const supabase = makeFakeSupabase(seed({ paid_until: iso(NOW), billing_status: 'active', auto_renew: true }, {
    billing_cards: [{ tenant_id: TENANT, authorization_code: 'AUTH_secret', email: OWNER.email, card_brand: 'visa', card_last4: '4081', exp_month: '12', exp_year: '2030' }],
  }));
  const restore = installFetch({ supabase, tokens: TOKENS });
  const get = (token) => new Request(`https://uniquethrift.ng/api/billing?tenant=${TENANT}`, { headers: { Authorization: `Bearer ${token}` } });
  try {
    assert.equal((await worker.fetch(get('tok-staff'), E(), {})).status, 403);
    const res = await worker.fetch(get('tok-owner'), E(), {});
    const text = await res.text();
    assert.equal(text.includes('AUTH_secret'), false, 'the card authorization reached the browser');
    const body = JSON.parse(text);
    assert.equal(body.price, 25000);
    assert.equal(body.status, 'active');
    assert.deepEqual(body.card, { brand: 'visa', last4: '4081', exp: '12/2030' });
    assert.equal(body.auto_renew, true);

    const off = await worker.fetch(new Request('https://uniquethrift.ng/api/billing/auto-renew', {
      method: 'POST', headers: { Authorization: 'Bearer tok-owner', 'Content-Type': 'application/json' }, body: JSON.stringify({ tenant: TENANT, on: false }),
    }), E(), {});
    assert.equal(off.status, 200);
    assert.equal(supabase.tables.tenants[0].auto_renew, false);
    assert.equal(supabase.tables.billing_cards.length, 0, 'turning auto-renew off forgets the card');
  } finally { restore(); }
});

test('an operator records a fee paid another way, and sets a store its own price', async () => {
  const supabase = makeFakeSupabase(seed({ paid_until: iso(NOW.getTime() - 9 * DAY), billing_status: 'paused', tier: 'business' }));
  const { waha, sent } = fakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });
  const post = (path, body) => new Request(`https://uniquethrift.ng${path}`, {
    method: 'POST', headers: { Authorization: 'Bearer tok-op', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    await worker.fetch(post(`/api/admin/tenants/${TENANT}/plan`, { tier: 'business', commission_pct: 5, plan_price: 50000 }), E(), {});
    assert.equal(supabase.tables.tenants[0].plan_price, 50000);

    const res = await worker.fetch(post(`/api/admin/tenants/${TENANT}/billing/record`, { note: 'Transfer to GTB' }), E(), {});
    assert.equal((await res.json()).ok, true);
    const invoice = supabase.tables.plan_invoices[0];
    assert.equal(invoice.amount, 50000);
    assert.equal(invoice.paid_via, 'manual');
    assert.equal(supabase.tables.tenants[0].billing_status, 'active');
    assert.equal(supabase.tables.operator_audit.at(-1).action, 'billing.record');
    assert.match(sent.at(-1).text, /live again/);
  } finally { restore(); }
});
