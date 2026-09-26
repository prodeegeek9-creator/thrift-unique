import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../index.js';
import { makeFakeSupabase, installFetch, env } from './fake-supabase.mjs';
import { reconcile, reconcileSweep, RECONCILE_HOUR_UTC } from '../lib/reconcile.js';
import { config } from '../lib/env.js';

// The daily check of our books against Paystack's (lib/reconcile.js): what
// Paystack's record settles is settled, the rest goes to the Money page.

const TENANT = 'aaaaaaaa-0000-0000-0000-00000000000a';
const OWNER = { id: 'user-owner', email: 'owner@platform.test' };
const SUPPORT = { id: 'user-support', email: 'support@platform.test' };
const TOKENS = { 'tok-owner': OWNER, 'tok-support': SUPPORT };
const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

const order = (id, ref, extra = {}) => ({
  id, tenant_id: TENANT, order_code: `VW-${id.toUpperCase()}`, product_id: `prod-${id}`, buyer_id: 'b1',
  amount: 20000, commission: 1600, status: 'paid', escrow_status: 'none', payment_ref: ref,
  paid_at: hoursAgo(5), source_channel: 'direct', ...extra,
});

function seed() {
  return {
    platform_admins: [{ user_id: OWNER.id, level: 'owner' }, { user_id: SUPPORT.id, level: 'support' }],
    tenants: [{ id: TENANT, slug: 'store', name: 'Unique Thrift', status: 'active', commission_pct: 8 }],
    tenant_features: [{ tenant_id: TENANT, flag: 'escrow', enabled: false }],
    buyers: [{ id: 'b1', tenant_id: TENANT, phone: null, name: 'Ada' }],
    products: ['late', 'ok', 'diff', 'missing', 'verified', 'c1'].map((id) => ({
      id: `prod-${id}`, tenant_id: TENANT, title: `Item ${id}`, price: 20000, status: id === 'late' || id === 'c1' ? 'active' : 'sold',
    })),
    orders: [
      // Paid on Paystack; the webhook never came and nobody opened the return page.
      order('late', 'utp_latepayment0000001', { status: 'awaiting_payment', paid_at: null, commission: 0 }),
      order('ok', 'utp_okpayment000000001'),
      order('diff', 'utp_diffpayment0000001'),
      // Recorded as paid here; not in Paystack's list.
      order('missing', 'utp_missingpayment00001'),
      order('verified', 'utp_verifiedpayment0001'),
      order('c1', 'utc_cartpayment000000001_1', { status: 'awaiting_payment', paid_at: null, commission: 0, cart_id: 'cart-1' }),
    ],
    carts: [{ id: 'cart-1', tenant_id: TENANT, buyer_id: 'b1', chat_id: 'x@c.us', payment_ref: 'utc_cartpayment000000001', amount: 20000, status: 'open' }],
    payouts: [
      { id: 'po-a', tenant_id: TENANT, reference: 'PO-VW-A', amount: 18400, status: 'sending', attempts: 1 },
      { id: 'po-b', tenant_id: TENANT, reference: 'PO-VW-B', amount: 18400, status: 'paid', attempts: 1, paid_at: hoursAgo(3) },
      { id: 'po-c', tenant_id: TENANT, reference: 'PO-VW-C', amount: 18400, status: 'paid', attempts: 1, paid_at: hoursAgo(3) },
    ],
    plan_invoices: [],
    bot_conversations: [],
  };
}

const tx = (reference, kobo = 2_000_000, extra = {}) => ({ reference, amount: kobo, status: 'success', ...extra });
const PAYMENTS = [
  tx('utp_latepayment0000001'),
  tx('utp_okpayment000000001'),
  tx('utp_diffpayment0000001', 2_500_000),
  tx('utp_ghostpayment000001'),
  tx('utc_cartpayment000000001', 2_000_000, { metadata: { kind: 'cart' } }),
  tx('DASHBOARD_PAGE_123'),
];
const TRANSFERS = [
  { reference: 'po-vw-a', amount: 1_840_000, status: 'success', transfer_code: 'TRF_a' },
  { reference: 'po-vw-b', amount: 1_840_000, status: 'reversed', transfer_code: 'TRF_b' },
  { reference: 'manual-to-supplier', amount: 5_000_000, status: 'success', transfer_code: 'TRF_m', recipient: { name: 'Supplier Ltd' } },
];

function setup() {
  const sb = makeFakeSupabase(seed());
  const asked = [];
  const restore = installFetch({
    supabase: sb,
    tokens: TOKENS,
    paystackVerify: (ref) => (ref === 'utp_verifiedpayment0001' ? tx(ref) : null),
    paystack: async (url) => {
      const u = new URL(url);
      asked.push(u.pathname + u.search);
      const page = Number(u.searchParams.get('page') ?? 1);
      const ok = (data) => new Response(JSON.stringify({ status: true, data }), { status: 200 });
      if (u.pathname === '/transaction') return ok(page === 1 ? PAYMENTS : []);
      if (u.pathname === '/transfer') return ok(page === 1 ? TRANSFERS : []);
      if (u.pathname.startsWith('/transfer/verify/')) {
        return new Response(JSON.stringify({ status: false, message: 'Transfer not found' }), { status: 404 });
      }
      return ok({});
    },
  });
  return { sb, asked, restore };
}

const cfgOf = () => ({ ...config(env()), publicOrigin: 'https://vendwyze.test' });
const byKind = (sb) => Object.fromEntries(sb.tables.payment_problems.map((p) => [p.reference ?? p.key, p.kind]));

test('the daily check settles what Paystack paid and nobody applied', async () => {
  const { sb, restore } = setup();
  try {
    const run = await reconcile(cfgOf());
    assert.equal(run.error, null);
    assert.equal(run.payments, PAYMENTS.length);
    assert.equal(run.transfers, TRANSFERS.length);
    assert.equal(run.settled_late, 2, 'the single order and the cart');

    const late = sb.tables.orders.find((o) => o.id === 'late');
    assert.equal(late.status, 'paid');
    assert.equal(late.commission, 1600);
    assert.equal(sb.tables.products.find((p) => p.id === 'prod-late').status, 'sold');
    assert.equal(sb.tables.carts[0].status, 'paid');
    assert.equal(sb.tables.orders.find((o) => o.id === 'c1').status, 'paid');
  } finally { restore(); }
});

test('the daily check brings payouts up to date with Paystack’s transfers', async () => {
  const { sb, restore } = setup();
  try {
    const run = await reconcile(cfgOf());
    assert.equal(run.payouts_updated, 2);
    assert.equal(sb.tables.payouts.find((p) => p.id === 'po-a').status, 'paid', 'the success webhook that never came');
    const b = sb.tables.payouts.find((p) => p.id === 'po-b');
    assert.equal(b.status, 'pending', 'reversed: owed again, and retried');
    assert.match(b.failure_reason, /reversed/);
  } finally { restore(); }
});

test('what it cannot settle goes to the Money page, once each however often it runs', async () => {
  const { sb, restore } = setup();
  try {
    const run = await reconcile(cfgOf());
    assert.deepEqual(byKind(sb), {
      utp_diffpayment0000001: 'amount_mismatch',
      utp_ghostpayment000001: 'unmatched_payment',
      DASHBOARD_PAGE_123: 'unmatched_payment',
      utp_missingpayment00001: 'missing_payment',
      'manual-to-supplier': 'unknown_transfer',
      'PO-VW-C': 'payout_mismatch',
    });
    assert.equal(run.problems, 6);
    // Asked about on its own, and Paystack had it: not a problem.
    assert.equal(byKind(sb).utp_verifiedpayment0001, undefined);
    assert.match(sb.tables.payment_problems.find((p) => p.reference === 'DASHBOARD_PAGE_123').detail, /isn't one Vendwyze makes/);
    assert.match(sb.tables.payment_problems.find((p) => p.reference === 'PO-VW-C').detail, /Paystack has no transfer for it/);

    await reconcile(cfgOf());
    assert.equal(sb.tables.payment_problems.length, 6, 'the same rows, not new ones');
    assert.equal(sb.tables.reconciliation_runs.length, 2);
    assert.equal(sb.tables.orders.find((o) => o.id === 'late').status, 'paid');
  } finally { restore(); }
});

test('a check Paystack does not answer is recorded as failed, not as a clean run', async () => {
  const sb = makeFakeSupabase(seed());
  const restore = installFetch({
    supabase: sb,
    paystack: async () => new Response(JSON.stringify({ status: false, message: 'Invalid key' }), { status: 401 }),
  });
  try {
    const run = await reconcile(cfgOf());
    assert.match(run.error, /Invalid key/);
    assert.equal(sb.tables.reconciliation_runs[0].error, run.error);
    assert.equal(sb.tables.payment_problems.length, 0);
  } finally { restore(); }
});

test('the scheduled run happens once a day, at its hour', async () => {
  const { sb, restore } = setup();
  try {
    const at = (h, m = 0) => new Date(Date.UTC(2026, 8, 27, h, m));
    assert.equal(await reconcileSweep(env(), { now: at(RECONCILE_HOUR_UTC - 1) }), null);
    assert.ok(await reconcileSweep(env(), { now: at(RECONCILE_HOUR_UTC, 1) }));
    // The cron retried within the hour.
    assert.equal(await reconcileSweep(env(), { now: at(RECONCILE_HOUR_UTC, 30) }), null);
    assert.equal(sb.tables.reconciliation_runs.length, 1);
  } finally { restore(); }
});

test('an owner can run the check from the console; the Money page shows the last run', async () => {
  const { sb, restore } = setup();
  try {
    const call = (path, token, method = 'GET') =>
      worker.fetch(new Request(`https://vendwyze.test/api/admin${path}`, { method, headers: { Authorization: `Bearer ${token}` } }), env(), {});

    assert.equal((await call('/reconcile', 'tok-support', 'POST')).status, 403);
    const res = await call('/reconcile', 'tok-owner', 'POST');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.run.settled_late, 2);
    assert.equal(sb.tables.operator_audit.at(-1).action, 'reconcile.run');

    const money = await (await call('/money', 'tok-support')).json();
    assert.equal(money.lastRun.problems, 6);
    assert.equal(money.payments.length, 4, 'money in: amount, unmatched twice, missing');
    assert.equal(money.transfers.length, 2, 'money out: the unknown transfer, the payout Paystack has no transfer for');
  } finally { restore(); }
});
