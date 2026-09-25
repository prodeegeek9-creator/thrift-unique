import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../index.js';
import { koboToNaira, nairaToKobo, split } from '../lib/money.js';
import { sign, verify } from '../lib/sign.js';
import { verifyWebhook, timingSafeEqual } from '../lib/paystack.js';
import { mintConfirmToken } from '../routes/confirm.js';
import { releaseExpiredHolds } from '../routes/escrow.js';
import { makeFakeSupabase, installFetch, env, SUPABASE_URL } from './fake-supabase.mjs';

const TENANT = 'tenant-1';

function seed({ escrow = true, commission_pct = 8, order = {} } = {}) {
  return {
    tenants: [{ id: TENANT, slug: 'store', name: 'Store', commission_pct }],
    tenant_features: [{ tenant_id: TENANT, flag: 'escrow', enabled: escrow }],
    products: [{ id: 'prod-1', title: 'Jacket', images: [], condition: 'good' }],
    orders: [
      {
        id: 'order-1',
        tenant_id: TENANT,
        order_code: 'UT-1001',
        product_id: 'prod-1',
        buyer_id: 'buyer-1',
        amount: 0,
        commission: 0,
        status: 'awaiting_payment',
        escrow_status: 'none',
        payment_ref: 'REF-1',
        confirmed_at: null,
        ...order,
      },
    ],
    payouts: [],
    payout_items: [],
  };
}

async function signedWebhook(body, secret = 'sk_test_secret') {
  const raw = JSON.stringify(body);
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  const sig = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { raw, sig };
}

function post(path, raw, sig) {
  return new Request(`https://example.com${path}`, {
    method: 'POST',
    headers: sig ? { 'x-paystack-signature': sig } : {},
    body: raw,
  });
}

// ── money ────────────────────────────────────────────────────────────────────

test('kobo converts once, and rejects what should never arrive', () => {
  assert.equal(koboToNaira(3500000), 35000);
  assert.equal(nairaToKobo(35000), 3500000);
  assert.throws(() => koboToNaira(-1), RangeError);
  assert.throws(() => koboToNaira(150.5), RangeError);
  assert.throws(() => koboToNaira('abc'), RangeError);
});

test('commission and net always re-add to exactly the gross', () => {
  // The rounding case: 8% of 1234.56 does not land on a whole naira, and the
  // seller's share is taken as the remainder so nothing is lost or paid twice.
  for (const gross of [0, 1, 999, 1234.56, 35000, 1_000_003]) {
    for (const pct of [0, 5, 7.5, 8, 100]) {
      const s = split(gross, pct);
      assert.equal(s.commission + s.net, s.gross, `${gross} @ ${pct}%`);
      assert.ok(s.commission >= 0 && s.net >= 0, `${gross} @ ${pct}% went negative`);
    }
  }
});

// ── signing ──────────────────────────────────────────────────────────────────

test('confirm tokens round-trip, and refuse tampering or expiry', async () => {
  const secret = 's3cret';
  const token = await sign(secret, { o: 'order-1', t: TENANT }, 60);

  const claims = await verify(secret, token);
  assert.equal(claims.o, 'order-1');

  assert.equal(await verify('wrong-secret', token), null, 'wrong key accepted');

  const [payload, sigPart] = token.split('.');
  const swapped = `${payload.slice(0, -2)}XY.${sigPart}`;
  assert.equal(await verify(secret, swapped), null, 'tampered payload accepted');

  const expired = await sign(secret, { o: 'x' }, -10);
  assert.equal(await verify(secret, expired), null, 'expired token accepted');

  for (const junk of ['', 'no-dot', 'a.b', null, undefined, 'x'.repeat(500)]) {
    assert.equal(await verify(secret, junk), null, `junk accepted: ${junk}`);
  }
});

test('signature comparison does not short-circuit on length-equal input', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'ab'), false);
  assert.equal(timingSafeEqual(null, 'abc'), false);
});

test('paystack signatures are checked against the RAW body', async () => {
  const body = { event: 'charge.success', data: { reference: 'R', amount: 100 } };
  const { raw, sig } = await signedWebhook(body);

  assert.equal(await verifyWebhook('sk_test_secret', raw, sig), true);
  assert.equal(await verifyWebhook('sk_wrong', raw, sig), false);

  // Re-serialising with different key order is the mistake this guards.
  const reordered = JSON.stringify({ data: body.data, event: body.event });
  assert.equal(await verifyWebhook('sk_test_secret', reordered, sig), false);
});

// ── the webhook ──────────────────────────────────────────────────────────────

test('an unsigned webhook is refused and nothing is written', async () => {
  const sb = makeFakeSupabase(seed());
  const restore = installFetch({ supabase: sb });
  try {
    const res = await worker.fetch(
      post('/api/paystack/webhook', JSON.stringify({ event: 'charge.success' }), 'deadbeef'),
      env(), {}
    );
    assert.equal(res.status, 401);
    assert.equal(sb.tables.orders[0].status, 'awaiting_payment');
    assert.equal(sb.tables.payouts.length, 0);
  } finally { restore(); }
});

test('a paid order on an escrow tenant is held, not paid out', async () => {
  const sb = makeFakeSupabase(seed({ escrow: true, commission_pct: 8 }));
  const restore = installFetch({ supabase: sb, paystackAmountKobo: 3_500_000 });
  try {
    const body = { event: 'charge.success', data: { reference: 'REF-1', amount: 3_500_000 } };
    const { raw, sig } = await signedWebhook(body);

    const res = await worker.fetch(post('/api/paystack/webhook', raw, sig), env(), {});
    assert.equal(res.status, 200);

    const order = sb.tables.orders[0];
    assert.equal(order.status, 'escrow');
    assert.equal(order.escrow_status, 'held');
    assert.equal(order.amount, 35000);
    assert.equal(order.commission, 2800, '8% of 35000');
    assert.ok(order.confirm_deadline, 'held funds need a deadline or they never release');

    assert.equal(sb.tables.payouts.length, 0, 'escrow must not pay out on payment');
  } finally { restore(); }
});

test('a paid order on a Starter tenant pays out immediately', async () => {
  const sb = makeFakeSupabase(seed({ escrow: false, commission_pct: 8 }));
  const restore = installFetch({ supabase: sb, paystackAmountKobo: 3_500_000 });
  try {
    const { raw, sig } = await signedWebhook({
      event: 'charge.success', data: { reference: 'REF-1', amount: 3_500_000 },
    });
    await worker.fetch(post('/api/paystack/webhook', raw, sig), env(), {});

    const order = sb.tables.orders[0];
    assert.equal(order.status, 'paid');
    assert.equal(order.escrow_status, 'none');

    assert.equal(sb.tables.payouts.length, 1);
    assert.equal(sb.tables.payouts[0].amount, 32200, '35000 less 8%');
    assert.equal(sb.tables.payout_items.length, 1);
  } finally { restore(); }
});

test('a replayed webhook does not pay twice', async () => {
  const sb = makeFakeSupabase(seed({ escrow: false }));
  const restore = installFetch({ supabase: sb, paystackAmountKobo: 3_500_000 });
  try {
    const { raw, sig } = await signedWebhook({
      event: 'charge.success', data: { reference: 'REF-1', amount: 3_500_000 },
    });

    // Paystack retries on timeout; three deliveries of the same event.
    for (let i = 0; i < 3; i++) {
      const res = await worker.fetch(post('/api/paystack/webhook', raw, sig), env(), {});
      assert.equal(res.status, 200);
    }

    assert.equal(sb.tables.payouts.length, 1, 'replay created a second payout');
    assert.equal(sb.tables.payout_items.length, 1);
  } finally { restore(); }
});

test('a payment with no matching order is acknowledged, never invented', async () => {
  const sb = makeFakeSupabase(seed());
  const restore = installFetch({ supabase: sb, paystackAmountKobo: 100 });
  try {
    const { raw, sig } = await signedWebhook({
      event: 'charge.success', data: { reference: 'UNKNOWN-REF', amount: 100 },
    });
    const res = await worker.fetch(post('/api/paystack/webhook', raw, sig), env(), {});

    assert.equal(res.status, 200, 'must not make Paystack retry forever');
    assert.equal((await res.json()).unmatched, true);
    assert.equal(sb.tables.orders.length, 1, 'an order was conjured from the payload');
  } finally { restore(); }
});

test('a transaction Paystack reports as failed is not treated as paid', async () => {
  const sb = makeFakeSupabase(seed());
  const restore = installFetch({
    supabase: sb, paystackAmountKobo: 3_500_000, paystackStatus: 'failed',
  });
  try {
    const { raw, sig } = await signedWebhook({
      event: 'charge.success', data: { reference: 'REF-1', amount: 3_500_000 },
    });
    await worker.fetch(post('/api/paystack/webhook', raw, sig), env(), {});

    assert.equal(sb.tables.orders[0].status, 'awaiting_payment');
    assert.equal(sb.tables.payouts.length, 0);
  } finally { restore(); }
});

// ── confirming receipt ───────────────────────────────────────────────────────

test('confirming releases the hold exactly once', async () => {
  const sb = makeFakeSupabase(
    seed({ order: { status: 'escrow', escrow_status: 'held', amount: 35000, commission: 2800 } })
  );
  const restore = installFetch({ supabase: sb });
  try {
    const token = await mintConfirmToken(env(), { id: 'order-1', tenant_id: TENANT });

    const first = await worker.fetch(
      new Request(`https://example.com/api/confirm/${token}`, { method: 'POST' }), env(), {}
    );
    assert.equal((await first.json()).released, true);
    assert.equal(sb.tables.orders[0].escrow_status, 'released');
    assert.equal(sb.tables.orders[0].status, 'completed');
    assert.equal(sb.tables.payouts.length, 1);
    assert.equal(sb.tables.payouts[0].amount, 32200);

    // A forwarded link, pressed again.
    const second = await worker.fetch(
      new Request(`https://example.com/api/confirm/${token}`, { method: 'POST' }), env(), {}
    );
    assert.equal((await second.json()).already, true);
    assert.equal(sb.tables.payouts.length, 1, 'second press paid again');
  } finally { restore(); }
});

test('a forged confirm token releases nothing', async () => {
  const sb = makeFakeSupabase(
    seed({ order: { status: 'escrow', escrow_status: 'held', amount: 35000 } })
  );
  const restore = installFetch({ supabase: sb });
  try {
    const good = await mintConfirmToken(env(), { id: 'order-1', tenant_id: TENANT });
    const forged = `${good.split('.')[0]}.AAAA`;

    const res = await worker.fetch(
      new Request(`https://example.com/api/confirm/${forged}`, { method: 'POST' }), env(), {}
    );
    assert.equal(res.status, 401);
    assert.equal(sb.tables.orders[0].escrow_status, 'held');
    assert.equal(sb.tables.payouts.length, 0);
  } finally { restore(); }
});

test('the confirm view does not leak the rest of the order', async () => {
  const sb = makeFakeSupabase(
    seed({ order: { status: 'escrow', escrow_status: 'held', amount: 35000, commission: 2800 } })
  );
  const restore = installFetch({ supabase: sb });
  try {
    const token = await mintConfirmToken(env(), { id: 'order-1', tenant_id: TENANT });
    const res = await worker.fetch(
      new Request(`https://example.com/api/confirm/${token}`), env(), {}
    );
    const body = await res.json();

    assert.equal(body.order_code, 'UT-1001');
    assert.equal(body.amount, 35000);
    for (const leaked of ['commission', 'buyer_id', 'payment_ref', 'tenant_id']) {
      assert.equal(leaked in body, false, `confirm view exposed ${leaked}`);
    }
  } finally { restore(); }
});

// ── the deadline sweep ───────────────────────────────────────────────────────

test('the sweep releases only holds past their deadline', async () => {
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const future = new Date(Date.now() + 86_400_000).toISOString();

  const sb = makeFakeSupabase({
    tenants: [{ id: TENANT, commission_pct: 8 }],
    tenant_features: [],
    orders: [
      { id: 'due', tenant_id: TENANT, order_code: 'UT-D', amount: 10000, commission: 800,
        escrow_status: 'held', status: 'escrow', confirm_deadline: past, confirmed_at: null },
      { id: 'notdue', tenant_id: TENANT, order_code: 'UT-N', amount: 10000, commission: 800,
        escrow_status: 'held', status: 'escrow', confirm_deadline: future, confirmed_at: null },
    ],
    payouts: [], payout_items: [],
  });

  const restore = installFetch({ supabase: sb });
  try {
    const result = await releaseExpiredHolds(env());
    assert.equal(result.checked, 1);
    assert.equal(result.released, 1);

    assert.equal(sb.tables.orders.find((o) => o.id === 'due').escrow_status, 'released');
    assert.equal(sb.tables.orders.find((o) => o.id === 'notdue').escrow_status, 'held');
    assert.equal(sb.tables.payouts.length, 1);
  } finally { restore(); }
});

// ── the shared product link ──────────────────────────────────────────────────

test('an unconfigured Worker still serves the page rather than failing', async () => {
  const sb = makeFakeSupabase(seed());
  const restore = installFetch({ supabase: sb });
  try {
    const res = await worker.fetch(
      new Request('https://example.com/p/ABC123'),
      { ASSETS: env().ASSETS }, // no Supabase config at all
      {}
    );
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<div id="root">/);
  } finally { restore(); }
});

// ── the homepage ─────────────────────────────────────────────────────────────

test('the homepage is indexable and previews as the platform', async () => {
  const restore = installFetch({ supabase: makeFakeSupabase(seed()) });
  try {
    const res = await worker.fetch(new Request('https://example.com/'), env(), {});
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /content="index, follow"/);
    assert.doesNotMatch(html, /noindex/);
    assert.match(html, /<title>Unique Thrift: run your thrift business from WhatsApp<\/title>/);
    assert.match(html, /og:url" content="https:\/\/example\.com\/"/);
    assert.match(html, /<div id="root">/);
  } finally { restore(); }
});

// ── a store's own page ───────────────────────────────────────────────────────

test("a store's page previews as the store, and an unknown one is just the page", async () => {
  const stores = {
    'ada-thrift': {
      name: 'Ada <Thrift>',
      slug: 'ada-thrift',
      logo_url: null,
      products: [{ public_code: 'PC1', title: 'Jacket', price: 35000, image: 't/a.jpg' }],
    },
  };
  const sb = makeFakeSupabase(seed(), {
    rpcs: { public_store: ({ store_slug }) => stores[store_slug] ?? null },
  });
  const restore = installFetch({ supabase: sb });
  try {
    const res = await worker.fetch(new Request('https://example.com/s/Ada-Thrift'), env(), {});
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.equal(sb.calls.find((c) => c.rpc === 'public_store')?.args.store_slug, 'ada-thrift');
    assert.match(html, /<title>Ada &lt;Thrift&gt;<\/title>/);
    assert.match(html, /og:url" content="https:\/\/example\.com\/s\/ada-thrift"/);
    assert.match(html, /1 item for sale/);
    assert.match(html, new RegExp(`og:image" content="${SUPABASE_URL}/storage/v1/object/public/product-images/t/a\\.jpg"`));
    assert.match(html, /content="index, follow"/);

    const missing = await worker.fetch(new Request('https://example.com/s/nobody'), env(), {});
    assert.equal(missing.status, 200);
    const plain = await missing.text();
    assert.match(plain, /<div id="root">/);
    assert.match(plain, /noindex/);
  } finally { restore(); }
});

test('unknown API routes 404 and unbuilt ones say so', async () => {
  const restore = installFetch({ supabase: makeFakeSupabase(seed()) });
  try {
    const missing = await worker.fetch(new Request('https://example.com/api/nope'), env(), {});
    assert.equal(missing.status, 404);

    // WAHA is built now, so an unknown path under it is an ordinary 404
    // rather than a promise.
    const unknownWaha = await worker.fetch(new Request('https://example.com/api/waha/inbound'), env(), {});
    assert.equal(unknownWaha.status, 404);

    // The OAuth channels still are not: they need an app review and an audit
    // before they can be tested against anything real, and saying so is
    // better than a 404 that reads like a typo.
    const later = await worker.fetch(
      new Request('https://example.com/api/oauth/instagram/start'),
      env(),
      {}
    );
    assert.equal(later.status, 501);
  } finally { restore(); }
});
