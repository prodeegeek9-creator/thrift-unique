import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../index.js';
import { makeFakeSupabase, installFetch, env } from './fake-supabase.mjs';
import { releaseEscrow } from '../lib/orders.js';

// Refunds: only while Vendwyze still holds the payment, and the buyer gets
// back what they paid less Paystack's processing fee, which Paystack keeps.
// A refund never takes money back from a store.

const TENANT = 'aaaaaaaa-0000-0000-0000-00000000000a';
const ORDER = 'cccccccc-0000-0000-0000-00000000000c';
const PAYOUT = 'bbbbbbbb-0000-0000-0000-00000000000b';
const PRODUCT = 'dddddddd-0000-0000-0000-00000000000d';
const DISPUTE = 'ffffffff-0000-0000-0000-00000000000f';

const OWNER = { id: 'user-owner', email: 'owner@store.test' };
const STAFF = { id: 'user-staff', email: 'staff@store.test' };
const OPERATOR = { id: 'user-op', email: 'op@platform.test' };
const SUPPORT = { id: 'user-support', email: 'support@platform.test' };
const TOKENS = { 'tok-owner': OWNER, 'tok-staff': STAFF, 'tok-op': OPERATOR, 'tok-support': SUPPORT };

// ₦35,000 paid; Paystack's fee on it ₦625.
const PAID_KOBO = 3_500_000;
const FEE_KOBO = 62_500;

const paidAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
const CFG = { supabaseUrl: 'https://test.supabase.co', serviceKey: 'service-key-for-tests' };

const HELD = { status: 'escrow', escrow_status: 'held' };
const RELEASED = { status: 'completed', escrow_status: 'released' };

function order(extra = {}) {
  return {
    id: ORDER, tenant_id: TENANT, order_code: 'VW-ABC234', product_id: PRODUCT, buyer_id: 'buyer-1',
    amount: 35000, commission: 2800, status: 'paid', escrow_status: 'none',
    payment_ref: 'REF-1', paid_at: paidAt, ...extra,
  };
}

// payout: null (none), or the status of the payout made for the order.
function seed({ orderExtra = {}, payout = null, product = 'sold' } = {}) {
  return {
    tenants: [{ id: TENANT, slug: 'store', name: 'Store', status: 'active', commission_pct: 8, whatsapp_number: '2348000000000' }],
    tenant_members: [
      { tenant_id: TENANT, user_id: OWNER.id, role: 'owner' },
      { tenant_id: TENANT, user_id: STAFF.id, role: 'staff' },
    ],
    platform_admins: [{ user_id: OPERATOR.id, level: 'owner' }, { user_id: SUPPORT.id, level: 'support' }],
    orders: [order(orderExtra)],
    products: [{ id: PRODUCT, tenant_id: TENANT, title: 'Leather jacket', status: product, sold_at: paidAt }],
    buyers: [{ id: 'buyer-1', tenant_id: TENANT, name: 'Ada', phone: '2348011111111' }],
    payouts: payout ? [{ id: PAYOUT, tenant_id: TENANT, amount: 32200, commission: 2800, status: payout, reference: 'PO-VW-ABC234' }] : [],
    payout_items: payout ? [{ payout_id: PAYOUT, order_id: ORDER, amount: 32200 }] : [],
    disputes: [{ id: DISPUTE, tenant_id: TENANT, order_id: ORDER, reason: 'Not as described', status: 'open' }],
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
      throw new Error(`unexpected paystack ${path}`);
    },
  };
}

function setup(opts = {}, { fail = null, fees = FEE_KOBO, verify = true } = {}) {
  const sb = makeFakeSupabase(seed(opts));
  const ps = fakePaystack({ fail });
  const restore = installFetch({
    supabase: sb,
    paystack: ps.paystack,
    tokens: TOKENS,
    paystackAmountKobo: verify ? PAID_KOBO : null,
    paystackFeesKobo: fees,
  });
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
  const { sb, ps, restore } = setup({ orderExtra: HELD });
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

// ── while the money is held ──────────────────────────────────────────────────

test('held in escrow: the buyer gets back what they paid less Paystack’s fee', async () => {
  const { sb, ps, restore } = setup({ orderExtra: HELD });
  try {
    const preview = await (await storeRefund({ preview: true })).json();
    assert.deepEqual(preview, { refundable: true, paid: 35000, fee: 625, amount: 34375 });
    assert.equal(sb.tables.refunds.length, 0, 'a preview changed something');

    const res = await storeRefund({ reason: 'Item was damaged' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      { status: body.refund.status, paid: body.refund.paid, fee: body.refund.fee, amount: body.refund.amount },
      { status: 'pending', paid: 35000, fee: 625, amount: 34375 }
    );

    const o = sb.tables.orders[0];
    assert.equal(o.status, 'refunded');
    assert.equal(o.escrow_status, 'refunded');

    assert.deepEqual(ps.calls.map((c) => c.path), ['/refund']);
    assert.equal(ps.calls[0].body.transaction, 'REF-1');
    assert.equal(ps.calls[0].body.amount, 3_437_500, 'the refund is paid less the fee, in kobo');
    assert.equal(ps.calls[0].body.customer_note, 'Item was damaged');

    const row = sb.tables.refunds[0];
    assert.equal(row.paystack_refund_id, '9001');
    assert.equal(row.requested_via, 'store');
    assert.equal(row.fee, 625);

    // Escrow can no longer release it to the store.
    const { released } = await releaseEscrow(CFG, o, { reason: 'deadline' });
    assert.equal(released, false);
    assert.equal(sb.tables.payouts.length, 0);
  } finally {
    restore();
  }
});

test('no escrow, payout not sent yet: it is cancelled and the buyer is refunded', async () => {
  const { sb, restore } = setup({ payout: 'pending' });
  try {
    const res = await storeRefund();
    assert.equal(res.status, 200);
    assert.equal(sb.tables.payouts[0].status, 'cancelled');
    assert.equal(sb.tables.orders[0].status, 'refunded');
  } finally {
    restore();
  }
});

// ── after release: no refunds ────────────────────────────────────────────────

test('once the payment is released to the store, there is no refund', async () => {
  const { sb, ps, restore } = setup({ orderExtra: RELEASED, payout: 'paid' });
  try {
    const preview = await (await storeRefund({ preview: true })).json();
    assert.equal(preview.refundable, false);
    assert.match(preview.reason, /already been released/);

    const res = await storeRefund();
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /open a dispute/);
    assert.equal(sb.tables.refunds.length, 0);
    assert.equal(sb.tables.orders[0].status, 'completed');
    assert.equal(ps.calls.length, 0);
  } finally {
    restore();
  }
});

test('no escrow and the store has been paid (or is being paid): no refund', async () => {
  for (const status of ['paid', 'sending']) {
    const { sb, restore } = setup({ payout: status });
    try {
      const res = await storeRefund();
      assert.equal(res.status, 409, `payout ${status}`);
      assert.match((await res.json()).error, /already been paid/);
      assert.equal(sb.tables.payouts[0].status, status);
      assert.equal(sb.tables.orders[0].status, 'paid');
    } finally {
      restore();
    }
  }
});

test('a payout that goes out mid-refund puts the order back and refuses', async () => {
  const { sb, restore } = setup({ payout: 'pending' });
  try {
    // The sweep claims the payout between the refund's checks and its cancel.
    let flipped = false;
    const real = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!flipped && init?.method === 'PATCH' && url.includes('/rest/v1/orders?')) {
        flipped = true;
        sb.tables.payouts[0].status = 'sending';
      }
      return real(input, init);
    };
    try {
      const res = await storeRefund();
      assert.equal(res.status, 409);
      assert.match((await res.json()).error, /just gone out/);
      assert.equal(sb.tables.orders[0].status, 'paid', 'the order was left refunded');
      assert.equal(sb.tables.refunds.length, 0);
    } finally {
      globalThis.fetch = real;
    }
  } finally {
    restore();
  }
});

// ── once, and only for paid orders ──────────────────────────────────────────

test('an order is refunded once', async () => {
  const { sb, ps, restore } = setup({ orderExtra: HELD });
  try {
    assert.equal((await storeRefund()).status, 200);
    const again = await storeRefund();
    assert.equal(again.status, 409);
    assert.equal(sb.tables.refunds.length, 1);
    assert.equal(ps.calls.length, 1);
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
  const { sb, restore } = setup({ orderExtra: HELD });
  try {
    await storeRefund({ relist: true });
    assert.equal(sb.tables.products[0].status, 'active');
    assert.equal(sb.tables.products[0].sold_at, null);
  } finally {
    restore();
  }
});

// ── when Paystack says no ────────────────────────────────────────────────────

test("if Paystack's fee can't be read, the refund waits for a retry rather than guessing", async () => {
  const { sb, ps, restore } = setup({ orderExtra: HELD }, { verify: false });
  try {
    const body = await (await storeRefund()).json();
    assert.equal(body.refund.status, 'failed');
    assert.match(body.refund.failure_reason, /fee/);
    assert.equal(ps.calls.length, 0, 'refunded without knowing the fee');
  } finally {
    restore();
  }
});

test('a refund Paystack refuses stays decided, is marked failed, and an owner can retry it', async () => {
  const { sb, restore } = setup({ orderExtra: HELD }, { fail: 'Insufficient balance' });
  const uuid = 'eeeeeeee-0000-0000-0000-00000000000e';
  try {
    const body = await (await storeRefund()).json();
    assert.equal(body.refund.status, 'failed');
    assert.match(body.refund.failure_reason, /Insufficient balance/);
    assert.equal(sb.tables.orders[0].status, 'refunded', 'the decision was undone');
    // The fake's ids are not uuids; give it one the route accepts.
    sb.tables.refunds[0].id = uuid;

    const support = await worker.fetch(post(`/api/admin/refunds/${uuid}/retry`, {}, 'tok-support'), env(), {});
    assert.equal(support.status, 403);
  } finally {
    restore();
  }

  // Balance topped up.
  const ok = fakePaystack();
  const restore2 = installFetch({ supabase: sb, paystack: ok.paystack, tokens: TOKENS, paystackAmountKobo: PAID_KOBO, paystackFeesKobo: FEE_KOBO });
  try {
    const retry = await worker.fetch(post(`/api/admin/refunds/${uuid}/retry`, {}, 'tok-op'), env(), {});
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).status, 'pending');
    assert.equal(sb.tables.refunds[0].status, 'pending');
    assert.equal(ok.calls[0].body.amount, 3_437_500);
    assert.equal(sb.tables.operator_audit.at(-1).action, 'refund.retry');
  } finally {
    restore2();
  }
});

// ── Paystack's word ──────────────────────────────────────────────────────────

test('refund.processed marks it done; a late refund.failed cannot undo that', async () => {
  const { sb, restore } = setup({ orderExtra: HELD });
  try {
    await storeRefund();
    const res = await worker.fetch(
      await signed({ event: 'refund.processed', data: { status: 'processed', transaction_reference: 'REF-1', amount: 3_437_500 } }),
      env(),
      {}
    );
    assert.equal(res.status, 200);
    assert.equal(sb.tables.refunds[0].status, 'processed');
    assert.ok(sb.tables.refunds[0].processed_at);

    await worker.fetch(await signed({ event: 'refund.failed', data: { transaction_reference: 'REF-1' } }), env(), {});
    assert.equal(sb.tables.refunds[0].status, 'processed');
  } finally {
    restore();
  }
});

test('an unsigned refund event changes nothing', async () => {
  const { sb, restore } = setup({ orderExtra: HELD });
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

test('an owner-level operator can refund a held payment from the release queue, with a reason', async () => {
  const { sb, restore } = setup({ orderExtra: HELD });
  try {
    const none = await worker.fetch(post(`/api/admin/orders/${ORDER}/refund`, {}, 'tok-op'), env(), {});
    assert.equal(none.status, 400);

    const res = await worker.fetch(post(`/api/admin/orders/${ORDER}/refund`, { reason: 'Store closed' }, 'tok-op'), env(), {});
    assert.equal(res.status, 200);
    assert.equal(sb.tables.refunds[0].requested_via, 'operator');
    assert.equal(sb.tables.operator_audit.at(-1).action, 'refund.create');
    assert.equal(sb.tables.operator_audit.at(-1).detail.fee, 625);
  } finally {
    restore();
  }
});

test('a dispute on a released payment is resolved for the buyer without a refund', async () => {
  const { sb, ps, restore } = setup({ orderExtra: RELEASED, payout: 'paid' });
  try {
    const res = await worker.fetch(
      post(`/api/admin/disputes/${DISPUTE}/resolve`, { outcome: 'refunded', resolution: 'Store agreed to swap it' }, 'tok-op'),
      env(),
      {}
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).moved, 'recorded');
    assert.equal(sb.tables.disputes[0].status, 'resolved');
    assert.equal(sb.tables.refunds.length, 0);
    assert.equal(sb.tables.orders[0].status, 'completed');
    assert.equal(ps.calls.length, 0);
  } finally {
    restore();
  }
});
