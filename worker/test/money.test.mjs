import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../index.js';
import { makeFakeSupabase, installFetch, env } from './fake-supabase.mjs';

// Money problems in the console (lib/problems.js, GET /api/admin/money): what
// used to reach nothing but the Worker's logs now waits in /admin until an
// owner says what was done about it.

const OWNER = { id: 'user-owner', email: 'owner@platform.test' };
const SUPPORT = { id: 'user-support', email: 'support@platform.test' };
const TOKENS = { 'tok-owner': OWNER, 'tok-support': SUPPORT };
const TENANT = 'aaaaaaaa-0000-0000-0000-00000000000a';

function seed() {
  const old = new Date(Date.now() - 2 * 86_400_000).toISOString();
  return {
    platform_admins: [
      { user_id: OWNER.id, level: 'owner' },
      { user_id: SUPPORT.id, level: 'support' },
    ],
    tenants: [{ id: TENANT, slug: 'store', name: 'Unique Thrift', tier: 'starter', status: 'active', commission_pct: 8 }],
    orders: [],
    carts: [],
    plan_invoices: [],
    payouts: [
      { id: 'p-ok', tenant_id: TENANT, amount: 1000, status: 'pending', attempts: 0, failure_reason: null, reference: 'PO-OK' },
      { id: 'p-refused', tenant_id: TENANT, amount: 32200, status: 'pending', attempts: 1, failure_reason: 'Account not found', reference: 'PO-1' },
      { id: 'p-silent', tenant_id: TENANT, amount: 9000, status: 'sending', attempts: 1, sent_at: old, reference: 'PO-2' },
      { id: 'p-paid', tenant_id: TENANT, amount: 5000, status: 'paid', attempts: 1, reference: 'PO-3' },
    ],
    refunds: [
      { id: 'r-failed', tenant_id: TENANT, order_id: 'o-1', paid: 20000, amount: 20000, platform_fee: 400, status: 'failed',
        failure_reason: 'Customer bank details required', requested_via: 'auto', created_at: old },
      { id: 'r-ok', tenant_id: TENANT, order_id: 'o-2', paid: 5000, amount: 4900, status: 'processed', requested_via: 'store' },
    ],
    operator_audit: [],
  };
}

async function signed(body, secret = 'sk_test_secret') {
  const raw = JSON.stringify(body);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  const sig = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return new Request('https://vendwyze.test/api/paystack/webhook', {
    method: 'POST',
    headers: { 'x-paystack-signature': sig, 'cf-connecting-ip': '203.0.113.9' },
    body: raw,
  });
}

const admin = (path, { token = 'tok-owner', method = 'GET', body } = {}) =>
  new Request(`https://vendwyze.test/api/admin${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });

async function send(req) {
  const res = await worker.fetch(req, env(), {});
  return { status: res.status, body: await res.json() };
}

function setup(extra = {}) {
  const sb = makeFakeSupabase(seed());
  const restore = installFetch({ supabase: sb, tokens: TOKENS, ...extra });
  return { sb, restore };
}

test('a payment with no order is kept for the console, once however often Paystack sends it', async () => {
  const { sb, restore } = setup();
  try {
    const event = { event: 'charge.success', data: { reference: 'utp_nobodyknowsthis01', amount: 4_500_000, channel: 'card' } };
    assert.equal((await send(await signed(event))).body.unmatched, true);
    await send(await signed(event));

    assert.equal(sb.tables.payment_problems.length, 1);
    const p = sb.tables.payment_problems[0];
    assert.equal(p.kind, 'unmatched_payment');
    assert.equal(p.reference, 'utp_nobodyknowsthis01');
    assert.equal(p.amount, 45000);
    assert.match(p.detail, /paid by card, and no order has this reference/);
  } finally { restore(); }
});

test('a cart or plan fee payment nobody can match is kept too', async () => {
  const { sb, restore } = setup({ paystackAmountKobo: 1_000_000 });
  try {
    await send(await signed({ event: 'charge.success', data: { reference: 'utc_nosuchcart000000001', amount: 1_000_000, metadata: { kind: 'cart' } } }));
    await send(await signed({ event: 'charge.success', data: { reference: 'utb_nosuchinvoice01', amount: 1_000_000, metadata: { kind: 'plan' } } }));
    const kinds = sb.tables.payment_problems.map((p) => [p.kind, p.reference]);
    assert.deepEqual(kinds, [
      ['unmatched_payment', 'utc_nosuchcart000000001'],
      ['unmatched_payment', 'utb_nosuchinvoice01'],
    ]);
    assert.match(sb.tables.payment_problems[0].detail, /no WhatsApp cart with this reference/);
  } finally { restore(); }
});

test('webhooks Paystack did not sign are counted as one problem a day', async () => {
  const { sb, restore } = setup();
  try {
    const forged = await signed({ event: 'charge.success', data: { reference: 'x' } }, 'sk_wrong');
    assert.equal((await send(forged)).status, 401);
    assert.equal((await send(await signed({ event: 'charge.success', data: {} }, 'sk_wrong'))).status, 401);

    assert.equal(sb.tables.payment_problems.length, 1);
    const p = sb.tables.payment_problems[0];
    assert.equal(p.kind, 'bad_signature');
    assert.match(p.key, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(p.detail, /203\.0\.113\.9/);
  } finally { restore(); }
});

test('the overview counts money problems, and the Money page lists each', async () => {
  const { sb, restore } = setup();
  try {
    await send(await signed({ event: 'charge.success', data: { reference: 'utp_nobodyknowsthis01', amount: 4_500_000 } }));
    await send(await signed({ event: 'charge.success', data: {} }, 'sk_wrong'));

    const { body: overview } = await send(admin('/overview'));
    assert.deepEqual(overview.money, { unmatched: 1, transfers: 0, refundsFailed: 1, badSignatureDays: 1, lastCheckAt: null, lastCheckFailed: false });
    assert.equal(overview.payouts.stuck, 2, 'refused, and sent two days ago with no word from Paystack');

    const { status, body } = await send(admin('/money', { token: 'tok-support' }));
    assert.equal(status, 200, 'support can look');
    assert.deepEqual(body.payments.map((p) => p.reference), ['utp_nobodyknowsthis01']);
    assert.equal(body.badSignatures.length, 1);
    assert.deepEqual(body.payouts.map((p) => p.id).sort(), ['p-refused', 'p-silent']);
    assert.equal(body.payouts[0].tenant_name, 'Unique Thrift');
    assert.deepEqual(body.refunds.map((r) => r.id), ['r-failed']);
    assert.equal(body.refunds[0].tenant_name, 'Unique Thrift');
    assert.equal(sb.tables.payment_problems.length, 2);
  } finally { restore(); }
});

test('an owner marks a problem sorted, saying what was done; it opens again if seen again', async () => {
  const { sb, restore } = setup();
  try {
    const event = { event: 'charge.success', data: { reference: 'utp_nobodyknowsthis01', amount: 4_500_000 } };
    await send(await signed(event));
    const id = 'dddddddd-0000-0000-0000-00000000000d';
    sb.tables.payment_problems[0].id = id;

    const bySupport = await send(admin(`/problems/${id}/resolve`, { token: 'tok-support', method: 'POST', body: { note: 'Refunded by hand' } }));
    assert.equal(bySupport.status, 403, 'money decisions are an owner’s');

    const noNote = await send(admin(`/problems/${id}/resolve`, { method: 'POST', body: { note: '' } }));
    assert.equal(noNote.status, 400);

    const ok = await send(admin(`/problems/${id}/resolve`, { method: 'POST', body: { note: 'Refunded by hand on Paystack' } }));
    assert.equal(ok.status, 200);
    const p = sb.tables.payment_problems[0];
    assert.ok(p.resolved_at);
    assert.equal(p.resolved_by, OWNER.id);
    assert.equal(p.resolution, 'Refunded by hand on Paystack');
    assert.equal(sb.tables.operator_audit.at(-1).action, 'problem.resolve');
    assert.equal(sb.tables.operator_audit.at(-1).subject, 'utp_nobodyknowsthis01');

    assert.equal((await send(admin('/money'))).body.payments.length, 0);
    assert.equal((await send(admin(`/problems/${id}/resolve`, { method: 'POST', body: { note: 'again' } }))).status, 409);

    // Paystack sends it again: it is back.
    await send(await signed(event));
    assert.equal(sb.tables.payment_problems.length, 1);
    assert.equal(sb.tables.payment_problems[0].resolved_at, null);
  } finally { restore(); }
});

// ── a payment for the wrong amount ───────────────────────────────────────────

function priced() {
  const s = seed();
  s.tenant_features = [{ tenant_id: TENANT, flag: 'escrow', enabled: false }];
  s.products = [{ id: 'prod-1', tenant_id: TENANT, public_code: 'JBU4PE', title: 'Jacket', price: 35000, status: 'active' }];
  s.buyers = [{ id: 'b1', tenant_id: TENANT, phone: null, name: 'Ada' }];
  s.orders = [{
    id: 'o-1', tenant_id: TENANT, order_code: 'VW-AMT1', product_id: 'prod-1', buyer_id: 'b1', amount: 35000,
    commission: 0, status: 'awaiting_payment', escrow_status: 'none', payment_ref: 'utp_amountcheck000001',
  }];
  s.payouts = [];
  s.refunds = [];
  s.carts = [{ id: 'cart-1', tenant_id: TENANT, buyer_id: 'b1', chat_id: 'x@c.us', payment_ref: 'utc_amountcheckcart00001', amount: 20000, status: 'open' }];
  return s;
}

function priceSetup(verify) {
  const sb = makeFakeSupabase(priced());
  const restore = installFetch({ supabase: sb, tokens: TOKENS, paystackVerify: verify });
  return { sb, restore };
}

test('a payment for less than the price is not a sale: nothing sold, nothing owed, one problem', async () => {
  const { sb, restore } = priceSetup((ref) => ({ reference: ref, amount: 3_000_000, status: 'success' }));
  try {
    const res = await send(await signed({ event: 'charge.success', data: { reference: 'utp_amountcheck000001', amount: 3_000_000 } }));
    assert.equal(res.body.ignored, 'amount mismatch');

    assert.equal(sb.tables.orders[0].status, 'awaiting_payment');
    assert.equal(sb.tables.products[0].status, 'active');
    assert.equal(sb.tables.payouts.length, 0);

    assert.equal(sb.tables.payment_problems.length, 1, 'recorded once, not also as unsettled');
    const p = sb.tables.payment_problems[0];
    assert.equal(p.kind, 'amount_mismatch');
    assert.equal(p.amount, 30000);
    assert.match(p.detail, /took ₦30,000 for order VW-AMT1, whose price is ₦35,000/);
  } finally { restore(); }
});

test('with Paystack’s fee passed to the buyer, the requested amount is the price, and it settles', async () => {
  const { sb, restore } = priceSetup((ref) => ({ reference: ref, amount: 3_562_500, requested_amount: 3_500_000, status: 'success' }));
  try {
    await send(await signed({ event: 'charge.success', data: { reference: 'utp_amountcheck000001', amount: 3_562_500 } }));
    const order = sb.tables.orders[0];
    assert.equal(order.status, 'paid');
    assert.equal(order.amount, 35000, 'the price, not the price plus the fee');
    assert.equal(sb.tables.products[0].status, 'sold');
    assert.equal(sb.tables.payment_problems.length, 0);
  } finally { restore(); }
});

test('a cart paid for the wrong amount is not settled either', async () => {
  const { sb, restore } = priceSetup((ref) => ({ reference: ref, amount: 2_500_000, status: 'success' }));
  try {
    await send(await signed({ event: 'charge.success', data: { reference: 'utc_amountcheckcart00001', amount: 2_500_000, metadata: { kind: 'cart' } } }));
    assert.equal(sb.tables.carts[0].status, 'open');
    assert.deepEqual(sb.tables.payment_problems.map((p) => p.kind), ['amount_mismatch']);
    assert.match(sb.tables.payment_problems[0].detail, /₦25,000 for a WhatsApp cart, whose price is ₦20,000/);
  } finally { restore(); }
});
