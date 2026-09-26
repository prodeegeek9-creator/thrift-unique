import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../index.js';
import { makeFakeSupabase, installFetch, env } from './fake-supabase.mjs';
import { releaseEscrow } from '../lib/orders.js';

// Refunds: the buyer gets back exactly what they paid, through Paystack. What
// the store gives up depends on whether it had been paid for the sale yet.

const TENANT = 'aaaaaaaa-0000-0000-0000-00000000000a';
const ORDER = 'cccccccc-0000-0000-0000-00000000000c';
const OTHER = 'cccccccc-0000-0000-0000-00000000000d';
const PAYOUT = 'bbbbbbbb-0000-0000-0000-00000000000b';
const PRODUCT = 'dddddddd-0000-0000-0000-00000000000d';

const OWNER = { id: 'user-owner', email: 'owner@store.test' };
const STAFF = { id: 'user-staff', email: 'staff@store.test' };
const OPERATOR = { id: 'user-op', email: 'op@platform.test' };
const SUPPORT = { id: 'user-support', email: 'support@platform.test' };
const TOKENS = { 'tok-owner': OWNER, 'tok-staff': STAFF, 'tok-op': OPERATOR, 'tok-support': SUPPORT };

const paidAt = new Date(Date.now() - 3 * 86_400_000).toISOString();

function order(extra = {}) {
  return {
    id: ORDER, tenant_id: TENANT, order_code: 'VW-ABC234', product_id: PRODUCT, buyer_id: 'buyer-1',
    amount: 35000, commission: 2800, status: 'paid', escrow_status: 'none',
    payment_ref: 'REF-1', paid_at: paidAt, ...extra,
  };
}

// payout: null (none yet), or the status of the payout made for the order.
function seed({ orderExtra = {}, payout = null, withheld = 0, owed = 0, product = 'sold' } = {}) {
  return {
    tenants: [{ id: TENANT, slug: 'store', name: 'Store', status: 'active', commission_pct: 8,
      whatsapp_number: '2348000000000', owed_to_platform: owed }],
    tenant_members: [
      { tenant_id: TENANT, user_id: OWNER.id, role: 'owner' },
      { tenant_id: TENANT, user_id: STAFF.id, role: 'staff' },
    ],
    platform_admins: [{ user_id: OPERATOR.id, level: 'owner' }, { user_id: SUPPORT.id, level: 'support' }],
    orders: [order(orderExtra)],
    products: [{ id: PRODUCT, tenant_id: TENANT, title: 'Leather jacket', status: product, sold_at: paidAt }],
    buyers: [{ id: 'buyer-1', tenant_id: TENANT, name: 'Ada', phone: '2348011111111' }],
    payouts: payout
      ? [{ id: PAYOUT, tenant_id: TENANT, amount: 32200 - withheld, withheld, commission: 2800, status: payout, reference: 'PO-VW-ABC234' }]
      : [],
    payout_items: payout ? [{ payout_id: PAYOUT, order_id: ORDER, amount: 32200 }] : [],
    refunds: [],
    operator_audit: [],
  };
}

function fakePaystack({ fail = null } = {}) {
  const calls = [];
  return {
    calls,
    paystack: async (url, init) => {
      const path = new URL(url).pathname;
      const body = init?.body ? JSON.parse(init.body) : null;
      calls.push({ path, body });
      if (path === '/refund') {
        if (fail) return new Response(JSON.stringify({ status: false, message: fail }), { status: 400 });
        return new Response(JSON.stringify({ status: true, data: { id: 9001, status: 'pending' } }), { status: 200 });
      }
      if (path === '/transfer') {
        return new Response(JSON.stringify({ status: true, data: { transfer_code: 'TRF', status: 'pending' } }), { status: 200 });
      }
      throw new Error(`unexpected paystack ${path}`);
    },
  };
}

function setup(opts = {}, psOpts = {}) {
  const sb = makeFakeSupabase(seed(opts));
  const ps = fakePaystack(psOpts);
  const restore = installFetch({ supabase: sb, paystack: ps.paystack, tokens: TOKENS });
  return { sb, ps, restore };
}

const post = (path, body, token) =>
  new Request(`https://vendwyze.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

const storeRefund = (body = {}, token = 'tok-owner') =>
  worker.fetch(post('/api/orders/refund', { tenant: TENANT, order: ORDER, ...body }, token), env(), {});

async function signed(body, secret = 'sk_test_secret') {
  const raw = JSON.stringify(body);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  const sig = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return new Request('https://vendwyze.test/api/paystack/webhook', { method: 'POST', headers: { 'x-paystack-signature': sig }, body: raw });
}

// ── who ──────────────────────────────────────────────────────────────────────

test('staff and strangers cannot refund; nothing moves', async () => {
  const { sb, ps, restore } = setup({ payout: 'paid' });
  try {
    // null, not undefined: undefined would fall back to the owner's token.
    for (const token of [null, 'nonsense', 'tok-staff']) {
      const res = await storeRefund({}, token);
      assert.equal(res.status, 403, `token ${token}`);
    }
    assert.equal(sb.tables.refunds.length, 0);
    assert.equal(ps.calls.length, 0);
  } finally {
    restore();
  }
});

// ── where the money is ───────────────────────────────────────────────────────

test('money held in escrow: the buyer is refunded and the store owes nothing', async () => {
  const { sb, ps, restore } = setup({ orderExtra: { status: 'escrow', escrow_status: 'held' } });
  try {
    const res = await storeRefund({ reason: 'Item was damaged' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.refund.status, 'pending');
    assert.equal(body.refund.store_debt, 0);

    const o = sb.tables.orders[0];
    assert.equal(o.status, 'refunded');
    assert.equal(o.escrow_status, 'refunded');

    assert.deepEqual(ps.calls.map((c) => c.path), ['/refund']);
    assert.equal(ps.calls[0].body.transaction, 'REF-1');
    assert.equal(ps.calls[0].body.customer_note, 'Item was damaged');
    assert.equal(sb.tables.refunds[0].paystack_refund_id, '9001');
    assert.equal(sb.tables.refunds[0].requested_via, 'store');
    assert.equal(sb.tables.tenants[0].owed_to_platform, 0);

    // Escrow can no longer release it to the store.
    const { released } = await releaseEscrow({ supabaseUrl: 'https://test.supabase.co', serviceKey: 'service-key-for-tests' }, o, { reason: 'deadline' });
    assert.equal(released, false);
    assert.equal(sb.tables.payouts.length, 0);
  } finally {
    restore();
  }
});

test("payout not sent yet: it is cancelled, and the store owes nothing", async () => {
  const { sb, restore } = setup({ payout: 'pending' });
  try {
    const res = await storeRefund();
    assert.equal(res.status, 200);
    assert.equal(sb.tables.payouts[0].status, 'cancelled');
    assert.equal(sb.tables.refunds[0].store_debt, 0);
    assert.equal(sb.tables.tenants[0].owed_to_platform, 0);
  } finally {
    restore();
  }
});

test('a cancelled payout that had repaid an older debt puts that debt back', async () => {
  const { sb, restore } = setup({ payout: 'pending', withheld: 5000, owed: 1000 });
  try {
    await storeRefund();
    assert.equal(sb.tables.payouts[0].status, 'cancelled');
    assert.equal(sb.tables.tenants[0].owed_to_platform, 6000);
  } finally {
    restore();
  }
});

test('already paid to the store: it owes back what it received, taken from its next payout', async () => {
  const { sb, restore } = setup({ payout: 'paid' });
  try {
    const preview = await (await storeRefund({ preview: true })).json();
    assert.deepEqual(preview, { refundable: true, amount: 35000, store_debt: 32200 });
    assert.equal(sb.tables.refunds.length, 0, 'a preview changed something');

    const res = await storeRefund();
    assert.equal(res.status, 200);
    assert.equal(sb.tables.payouts[0].status, 'paid', 'a sent payout cannot be cancelled');
    assert.equal(sb.tables.refunds[0].store_debt, 32200);
    assert.equal(sb.tables.tenants[0].owed_to_platform, 32200);

    // The next sale: ₦23,000 net, all of it kept toward the ₦32,200.
    sb.tables.orders.push({
      id: OTHER, tenant_id: TENANT, order_code: 'VW-NEXT01', product_id: 'p2', buyer_id: 'b2',
      amount: 25000, commission: 2000, status: 'escrow', escrow_status: 'held', payment_ref: 'REF-2', paid_at: paidAt,
    });
    const cfg = { supabaseUrl: 'https://test.supabase.co', serviceKey: 'service-key-for-tests', paystackKey: 'sk_test_secret' };
    await releaseEscrow(cfg, sb.tables.orders.at(-1), { reason: 'buyer_confirmed' });
    const next = sb.tables.payouts.find((p) => p.reference === 'PO-VW-NEXT01');
    assert.equal(next.withheld, 23000);
    assert.equal(next.amount, 0);
    assert.equal(next.status, 'paid', 'nothing left to transfer');
    assert.equal(sb.tables.tenants[0].owed_to_platform, 9200);
  } finally {
    restore();
  }
});

test('a later payout only has what is left of the debt taken from it', async () => {
  const { sb, ps, restore } = setup({ owed: 5000 });
  try {
    sb.tables.orders = [{
      id: OTHER, tenant_id: TENANT, order_code: 'VW-NEXT02', product_id: 'p2', buyer_id: 'b2',
      amount: 25000, commission: 2000, status: 'escrow', escrow_status: 'held', payment_ref: 'REF-3', paid_at: paidAt,
    }];
    sb.tables.payout_accounts = [{ tenant_id: TENANT, recipient_code: 'RCP_1', bank_name: 'GTBank', account_last4: '1234' }];
    const cfg = { supabaseUrl: 'https://test.supabase.co', serviceKey: 'service-key-for-tests', paystackKey: 'sk_test_secret' };
    await releaseEscrow(cfg, sb.tables.orders[0], { reason: 'buyer_confirmed' });
    const p = sb.tables.payouts[0];
    assert.equal(p.withheld, 5000);
    assert.equal(p.amount, 18000);
    assert.equal(sb.tables.tenants[0].owed_to_platform, 0);
    const transfer = ps.calls.find((c) => c.path === '/transfer');
    assert.equal(transfer.body.amount, 1_800_000, 'the transfer is the reduced amount, in kobo');
  } finally {
    restore();
  }
});

// ── once, and only for paid orders ──────────────────────────────────────────

test('an order is refunded once', async () => {
  const { sb, ps, restore } = setup({ payout: 'paid' });
  try {
    assert.equal((await storeRefund()).status, 200);
    const again = await storeRefund();
    assert.equal(again.status, 409);
    assert.equal(sb.tables.refunds.length, 1);
    assert.equal(ps.calls.length, 1);
    assert.equal(sb.tables.tenants[0].owed_to_platform, 32200, 'the debt was counted twice');
  } finally {
    restore();
  }
});

test('an unpaid order cannot be refunded', async () => {
  const { sb, restore } = setup({ orderExtra: { status: 'awaiting_payment', paid_at: null, payment_ref: null } });
  try {
    const res = await storeRefund();
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /hasn't been paid/);
    assert.equal(sb.tables.refunds.length, 0);
  } finally {
    restore();
  }
});

test('relist puts the item back on sale', async () => {
  const { sb, restore } = setup({ payout: 'pending' });
  try {
    await storeRefund({ relist: true });
    assert.equal(sb.tables.products[0].status, 'active');
    assert.equal(sb.tables.products[0].sold_at, null);
  } finally {
    restore();
  }
});

// ── when Paystack says no ────────────────────────────────────────────────────

test('a refund Paystack refuses stays decided, is marked failed, and an owner can retry it', async () => {
  const { sb, ps, restore } = setup({ payout: 'pending' }, { fail: 'Insufficient balance' });
  try {
    const res = await storeRefund();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.refund.status, 'failed');
    assert.match(body.refund.failure_reason, /Insufficient balance/);
    assert.equal(sb.tables.orders[0].status, 'refunded', 'the decision was undone');

    const id = sb.tables.refunds[0].id;
    // The id in the fake is not a uuid; give it one the route accepts.
    const uuid = 'eeeeeeee-0000-0000-0000-00000000000e';
    sb.tables.refunds[0].id = uuid;

    const support = await worker.fetch(post(`/api/admin/refunds/${uuid}/retry`, {}, 'tok-support'), env(), {});
    assert.equal(support.status, 403);

    // Balance topped up.
    ps.calls.length = 0;
    restore();
    const ok = fakePaystack();
    const restore2 = installFetch({ supabase: sb, paystack: ok.paystack, tokens: TOKENS });
    try {
      const retry = await worker.fetch(post(`/api/admin/refunds/${uuid}/retry`, {}, 'tok-op'), env(), {});
      assert.equal(retry.status, 200);
      assert.equal((await retry.json()).status, 'pending');
      assert.equal(sb.tables.refunds[0].status, 'pending');
      assert.equal(sb.tables.operator_audit.at(-1).action, 'refund.retry');
      assert.ok(id);
    } finally {
      restore2();
    }
  } catch (err) {
    restore();
    throw err;
  }
});

// ── Paystack's word ──────────────────────────────────────────────────────────

test('refund.processed marks it done; refund.failed marks it for a person', async () => {
  const { sb, restore } = setup({ payout: 'pending' });
  try {
    await storeRefund();
    const res = await worker.fetch(
      await signed({ event: 'refund.processed', data: { status: 'processed', transaction_reference: 'REF-1', amount: 3_500_000 } }),
      env(),
      {}
    );
    assert.equal(res.status, 200);
    assert.equal(sb.tables.refunds[0].status, 'processed');
    assert.ok(sb.tables.refunds[0].processed_at);

    // A late failure cannot undo a processed refund.
    await worker.fetch(await signed({ event: 'refund.failed', data: { transaction_reference: 'REF-1' } }), env(), {});
    assert.equal(sb.tables.refunds[0].status, 'processed');
  } finally {
    restore();
  }
});

test('an unsigned refund event changes nothing', async () => {
  const { sb, restore } = setup({ payout: 'pending' });
  try {
    await storeRefund();
    const res = await worker.fetch(
      new Request('https://vendwyze.test/api/paystack/webhook', {
        method: 'POST',
        headers: { 'x-paystack-signature': 'nope' },
        body: JSON.stringify({ event: 'refund.processed', data: { transaction_reference: 'REF-1' } }),
      }),
      env(),
      {}
    );
    assert.equal(res.status, 401);
    assert.equal(sb.tables.refunds[0].status, 'pending');
  } finally {
    restore();
  }
});

// ── from the console ─────────────────────────────────────────────────────────

test('an owner-level operator can refund a held payment from the console, with a reason', async () => {
  const { sb, restore } = setup({ orderExtra: { status: 'escrow', escrow_status: 'held' } });
  try {
    const none = await worker.fetch(post(`/api/admin/orders/${ORDER}/refund`, {}, 'tok-op'), env(), {});
    assert.equal(none.status, 400);

    const res = await worker.fetch(post(`/api/admin/orders/${ORDER}/refund`, { reason: 'Store closed' }, 'tok-op'), env(), {});
    assert.equal(res.status, 200);
    assert.equal(sb.tables.refunds[0].requested_via, 'operator');
    assert.equal(sb.tables.operator_audit.at(-1).action, 'refund.create');
  } finally {
    restore();
  }
});
