import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../index.js';
import { makeFakeSupabase, installFetch, env } from './fake-supabase.mjs';

// Buying on the platform: the order made before money moves, the Paystack
// checkout it opens, and what happens once Paystack says it was paid.

const TENANT = 'aaaaaaaa-0000-0000-0000-00000000000a';
const PRODUCT = 'pppppppp-0000-0000-0000-00000000000p'.replace(/p/g, '1');
const OWNER_PHONE = '2348156740439';
const OWNER = { id: 'user-owner', email: 'owner@store.test' };
const STRANGER = { id: 'user-stranger', email: 'x@example.test' };
const TOKENS = { 'tok-owner': OWNER, 'tok-stranger': STRANGER };
const WAHA_URL = 'https://waha.test';

function seed({ tenant = {}, product = {}, escrow = false } = {}) {
  return {
    tenants: [
      {
        id: TENANT, slug: 'unique-thrift', name: 'Unique Thrift', status: 'active', commission_pct: 8,
        whatsapp_number: OWNER_PHONE, waha_session: 'ut-unique-thrift', waha_status: 'WORKING', ...tenant,
      },
    ],
    tenant_features: [{ tenant_id: TENANT, flag: 'escrow', enabled: escrow }],
    tenant_members: [{ tenant_id: TENANT, user_id: OWNER.id, role: 'owner' }],
    products: [
      {
        id: PRODUCT, tenant_id: TENANT, public_code: 'JBU4PE', title: 'Leather Jacket', price: 35000,
        condition: 'excellent', images: ['t/j.jpg'], status: 'active', ...product,
      },
    ],
    buyers: [],
    orders: [],
    payouts: [],
    payout_items: [],
  };
}

function fakeWaha() {
  const sent = [];
  return {
    sent,
    waha: {
      url: WAHA_URL,
      handler: async (url, init) => {
        const path = new URL(url).pathname;
        if (path === '/api/sendText') sent.push(JSON.parse(init.body));
        return new Response('{}', { status: 200 });
      },
    },
  };
}

function fakePaystack({ fail = false } = {}) {
  const initialized = [];
  return {
    initialized,
    paystack: async (url, init) => {
      if (url === 'https://api.paystack.co/transaction/initialize') {
        const body = JSON.parse(init.body);
        initialized.push(body);
        if (fail) return new Response(JSON.stringify({ status: false, message: 'nope' }), { status: 400 });
        return new Response(JSON.stringify({
          status: true,
          data: { authorization_url: `https://checkout.paystack.test/${body.reference}`, reference: body.reference },
        }), { status: 200 });
      }
      return new Response('?', { status: 404 });
    },
  };
}

const E = (extra = {}) =>
  env({ WAHA_URL, WAHA_API_KEY: 'k', WAHA_SESSION: 'ut-platform', PUBLIC_ORIGIN: 'https://uniquethrift.ng', WAHA_TYPING_MS: '0', ...extra });

function post(path, body, token) {
  return new Request(`https://uniquethrift.ng${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}
const get = (path) => new Request(`https://uniquethrift.ng${path}`);

const BUYER = { name: 'Ada Obi', phone: '0803 123 4567', address: '12 Allen Avenue, Ikeja, Lagos', note: 'Call first' };

test('checkout says whether it is set up', async () => {
  const restore = installFetch({ supabase: makeFakeSupabase(seed()) });
  try {
    assert.deepEqual(await (await worker.fetch(get('/api/checkout/enabled'), E(), {})).json(), { enabled: true });
    const off = await worker.fetch(get('/api/checkout/enabled'), E({ PAYSTACK_SECRET_KEY: '' }), {});
    assert.deepEqual(await off.json(), { enabled: false });
  } finally { restore(); }
});

test('buying from a product page makes the order first, then opens Paystack', async () => {
  const supabase = makeFakeSupabase(seed());
  const { paystack, initialized } = fakePaystack();
  const restore = installFetch({ supabase, paystack });
  try {
    const res = await worker.fetch(post('/api/checkout', { code: 'jbu4pe', ...BUYER }), E(), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.url, /^https:\/\/checkout\.paystack\.test\/utp_/);

    const buyer = supabase.tables.buyers[0];
    assert.equal(buyer.phone, '2348031234567');
    assert.equal(buyer.name, 'Ada Obi');

    const order = supabase.tables.orders[0];
    assert.equal(order.status, 'awaiting_payment');
    assert.equal(order.amount, 35000);
    assert.equal(order.product_id, PRODUCT);
    assert.equal(order.buyer_id, buyer.id);
    assert.equal(order.delivery_address, BUYER.address);
    assert.equal(order.buyer_note, 'Call first');
    assert.equal(order.source_channel, 'direct');
    assert.match(order.order_code, /^VW-[A-Z2-9]{6}$/);

    const init = initialized[0];
    assert.equal(init.amount, 3_500_000);
    assert.equal(init.reference, order.payment_ref);
    assert.equal(init.currency, 'NGN');
    assert.equal(init.callback_url, `https://uniquethrift.ng/order/${order.payment_ref}`);
    assert.equal(init.email, 'buyer-2348031234567@uniquethrift.ng');
  } finally { restore(); }
});

test('checkout refuses what it cannot sell, and says why', async () => {
  const cases = [
    [seed({ product: { status: 'sold' } }), BUYER, 409, /sold/],
    [seed({ tenant: { status: 'onboarding' } }), BUYER, 409, /isn't taking orders/],
    [seed(), { ...BUYER, phone: '123' }, 400, /WhatsApp number/],
    [seed(), { ...BUYER, address: '' }, 400, /delivery address/],
    [seed(), { ...BUYER, name: '' }, 400, /name/],
  ];
  for (const [s, buyer, status, message] of cases) {
    const supabase = makeFakeSupabase(s);
    const { paystack, initialized } = fakePaystack();
    const restore = installFetch({ supabase, paystack });
    try {
      const res = await worker.fetch(post('/api/checkout', { code: 'JBU4PE', ...buyer }), E(), {});
      assert.equal(res.status, status, String(message));
      assert.match((await res.json()).error, message);
      assert.equal(initialized.length, 0);
      assert.equal(supabase.tables.orders.length, 0);
    } finally { restore(); }
  }

  const restore = installFetch({ supabase: makeFakeSupabase(seed()) });
  try {
    const off = await worker.fetch(post('/api/checkout', { code: 'JBU4PE', ...BUYER }), E({ PAYSTACK_SECRET_KEY: '' }), {});
    assert.equal(off.status, 503);
  } finally { restore(); }
});

test('a Paystack failure cancels the order it made', async () => {
  const supabase = makeFakeSupabase(seed());
  const { paystack } = fakePaystack({ fail: true });
  const restore = installFetch({ supabase, paystack });
  try {
    const res = await worker.fetch(post('/api/checkout', { code: 'JBU4PE', ...BUYER }), E(), {});
    assert.equal(res.status, 502);
    assert.equal(supabase.tables.orders[0].status, 'cancelled');
  } finally { restore(); }
});

test('a store makes a payment link at an agreed price, and the buyer pays exactly that', async () => {
  const supabase = makeFakeSupabase(seed());
  const { paystack, initialized } = fakePaystack();
  const restore = installFetch({ supabase, paystack, tokens: TOKENS });
  try {
    const refused = await worker.fetch(post('/api/listings/payment-link', { tenant: TENANT, id: PRODUCT, price: '30k' }, 'tok-stranger'), E(), {});
    assert.equal(refused.status, 403);

    const made = await worker.fetch(post('/api/listings/payment-link', { tenant: TENANT, id: PRODUCT, price: '30k' }, 'tok-owner'), E(), {});
    assert.equal(made.status, 200);
    const { url, price } = await made.json();
    assert.equal(price, 30000);
    const token = url.match(/^https:\/\/uniquethrift\.ng\/pay\/(.+)$/)[1];

    const view = await (await worker.fetch(get(`/api/checkout/link/${token}`), E(), {})).json();
    assert.equal(view.price, 30000);
    assert.equal(view.title, 'Leather Jacket');
    assert.equal(view.store.name, 'Unique Thrift');

    const res = await worker.fetch(post('/api/checkout', { token, ...BUYER }), E(), {});
    assert.equal(res.status, 200);
    assert.equal(supabase.tables.orders[0].amount, 30000);
    assert.equal(supabase.tables.orders[0].source_channel, 'whatsapp');
    assert.equal(initialized[0].amount, 3_000_000);

    // An edited price breaks the signature.
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ k: 'pay', p: PRODUCT, a: 100, exp: 9999999999 })).toString('base64url');
    const bad = await worker.fetch(post('/api/checkout', { token: `${forged}.${sig}`, ...BUYER }), E(), {});
    assert.equal(bad.status, 410);
    assert.ok(payload);
  } finally { restore(); }
});

async function paidOrder({ escrow = false, alreadySold = false } = {}) {
  const supabase = makeFakeSupabase(seed({ escrow, product: alreadySold ? { status: 'sold' } : {} }));
  supabase.tables.buyers.push({ id: 'b1', tenant_id: TENANT, phone: '2348031234567', name: 'Ada Obi' });
  supabase.tables.orders.push({
    id: 'o1', tenant_id: TENANT, order_code: 'UT-ABC234', product_id: PRODUCT, buyer_id: 'b1',
    amount: 35000, commission: 0, status: 'awaiting_payment', escrow_status: 'none',
    payment_ref: 'utp_testreference0001', source_channel: 'direct',
    delivery_address: '12 Allen Avenue, Ikeja', buyer_note: null,
  });
  const { waha, sent } = fakeWaha();
  const restore = installFetch({ supabase, waha, paystackAmountKobo: 3_500_000 });
  const res = await worker.fetch(get('/api/checkout/utp_testreference0001'), E(), {});
  return { supabase, sent, restore, res };
}

test('a paid order takes the item off sale, owes the store and tells both sides', async () => {
  const { supabase, sent, restore, res } = await paidOrder();
  try {
    const body = await res.json();
    assert.equal(body.status, 'paid');
    assert.equal(body.order_code, 'UT-ABC234');

    assert.equal(supabase.tables.products[0].status, 'sold');
    assert.equal(supabase.tables.orders[0].commission, 2800);
    assert.equal(supabase.tables.payouts.length, 1);
    assert.equal(supabase.tables.payouts[0].amount, 32200);

    const toOwner = sent.find((m) => m.chatId === `${OWNER_PHONE}@c.us`);
    assert.equal(toOwner.session, 'ut-platform');
    assert.match(toOwner.text, /New order UT-ABC234/);
    assert.match(toOwner.text, /Deliver to: 12 Allen Avenue, Ikeja/);
    assert.match(toOwner.text, /Ada Obi \(\+2348031234567\)/);

    const toBuyer = sent.find((m) => m.chatId === '2348031234567@c.us');
    assert.equal(toBuyer.session, 'ut-unique-thrift');
    assert.match(toBuyer.text, /Payment received/);
    assert.doesNotMatch(toBuyer.text, /confirm/);

    // The page asking again changes nothing.
    await worker.fetch(get('/api/checkout/utp_testreference0001'), E(), {});
    assert.equal(supabase.tables.payouts.length, 1);
    assert.equal(sent.length, 2);
  } finally { restore(); }
});

test('an escrow order sends the buyer the link that releases the money', async () => {
  const { supabase, sent, restore } = await paidOrder({ escrow: true });
  try {
    assert.equal(supabase.tables.orders[0].escrow_status, 'held');
    assert.equal(supabase.tables.payouts.length, 0);
    const toBuyer = sent.find((m) => m.chatId === '2348031234567@c.us');
    assert.match(toBuyer.text, /https:\/\/uniquethrift\.ng\/confirm\//);
    const toOwner = sent.find((m) => m.chatId === `${OWNER_PHONE}@c.us`);
    assert.match(toOwner.text, /held until the buyer confirms/);
  } finally { restore(); }
});

// A payment for an item that had already sold: a Paystack page left open past
// its hold. Nobody is paid for it and the buyer gets everything back.
async function lateSale({ escrow = false, refundStatus = 200 } = {}) {
  const supabase = makeFakeSupabase(seed({ escrow, product: { status: 'sold' } }));
  supabase.tables.buyers.push({ id: 'b1', tenant_id: TENANT, phone: '2348031234567', name: 'Ada Obi' });
  supabase.tables.orders.push({
    id: 'o1', tenant_id: TENANT, order_code: 'UT-ABC234', product_id: PRODUCT, buyer_id: 'b1',
    amount: 35000, commission: 0, status: 'awaiting_payment', escrow_status: 'none',
    payment_ref: 'utp_testreference0001', source_channel: 'direct',
    delivery_address: '12 Allen Avenue, Ikeja', buyer_note: null,
  });
  supabase.tables.payout_accounts = [{ tenant_id: TENANT, bank_name: 'GTBank', account_last4: '1234', recipient_code: 'RCP_1' }];
  const { waha, sent } = fakeWaha();
  const refunds = [];
  const transfers = [];
  const restore = installFetch({
    supabase,
    waha,
    paystackAmountKobo: 3_500_000,
    paystackFeesKobo: 62_500,
    paystack: async (url, init) => {
      const path = new URL(url).pathname;
      if (path === '/refund') {
        refunds.push(JSON.parse(init.body));
        return refundStatus === 200
          ? new Response(JSON.stringify({ status: true, data: { id: 91, status: 'pending' } }), { status: 200 })
          : new Response(JSON.stringify({ status: false, message: 'Customer bank details required' }), { status: 400 });
      }
      if (path === '/transfer') transfers.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ status: true, data: { transfer_code: 'TRF', status: 'pending' } }), { status: 200 });
    },
  });
  const res = await worker.fetch(get('/api/checkout/utp_testreference0001'), E(), {});
  return { supabase, sent, refunds, transfers, restore, res };
}

test('a payment for an item already sold is refunded in full, and the store is not paid for it', async () => {
  const { supabase, sent, refunds, transfers, restore } = await lateSale();
  try {
    const order = supabase.tables.orders[0];
    assert.equal(order.status, 'refunded');
    assert.equal(order.commission, 0, 'no commission on a sale that did not happen');
    assert.equal(supabase.tables.payouts.length, 0, 'nothing owed to the store');
    assert.equal(transfers.length, 0, 'nothing sent to the store');

    // Everything back: Vendwyze carries Paystack's ₦625 fee.
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0].transaction, 'utp_testreference0001');
    assert.equal(refunds[0].amount, 3_500_000);
    const refund = supabase.tables.refunds[0];
    assert.equal(refund.requested_via, 'auto');
    assert.equal(refund.amount, 35000);
    assert.equal(refund.fee, 0);
    assert.equal(refund.platform_fee, 625);

    const toBuyer = sent.find((m) => m.chatId === '2348031234567@c.us');
    assert.match(toBuyer.text, /sold to someone else just before your payment went through/);
    assert.match(toBuyer.text, /Your full ₦35,000 is being refunded/);
    assert.match(toBuyer.text, /3 to 10 working days/);
    assert.doesNotMatch(toBuyer.text, /Payment received/);

    const toOwner = sent.filter((m) => m.chatId === `${OWNER_PHONE}@c.us`);
    assert.equal(toOwner.length, 1, 'one message, not a new-order message');
    assert.match(toOwner[0].text, /second payment.*came in for \*Leather Jacket\* after it had sold/);
    assert.match(toOwner[0].text, /nothing for you to do/);

    // Asking again changes nothing.
    await worker.fetch(get('/api/checkout/utp_testreference0001'), E(), {});
    assert.equal(refunds.length, 1);
    assert.equal(supabase.tables.refunds.length, 1);
  } finally { restore(); }
});

test('on an escrow store, a payment for an item already sold is refunded from the hold', async () => {
  const { supabase, refunds, restore } = await lateSale({ escrow: true });
  try {
    const order = supabase.tables.orders[0];
    assert.equal(order.status, 'refunded');
    assert.equal(order.escrow_status, 'refunded', 'escrow can no longer release it');
    assert.equal(refunds[0].amount, 3_500_000);
  } finally { restore(); }
});

test('a refund Paystack refuses is left for the operator, and the buyer is told Vendwyze will refund them', async () => {
  const { supabase, sent, restore } = await lateSale({ refundStatus: 400 });
  try {
    assert.equal(supabase.tables.refunds[0].status, 'failed');
    assert.equal(supabase.tables.payouts.length, 0);
    const toBuyer = sent.find((m) => m.chatId === '2348031234567@c.us');
    assert.match(toBuyer.text, /Vendwyze will refund your full ₦35,000 and message you here/);
  } finally { restore(); }
});

test('an owner asks the bot for a payment link', async () => {
  const supabase = makeFakeSupabase({ ...seed(), bot_conversations: [], bot_messages: [], submissions: [] });
  const { waha, sent } = fakeWaha();
  const restore = installFetch({ supabase, waha });
  const hook = (body, id) => new Request('https://uniquethrift.ng/api/waha/webhook', {
    method: 'POST',
    headers: { 'X-Thrift-Secret': 'secret' },
    body: JSON.stringify({ event: 'message', session: 'ut-platform', payload: { id, from: `${OWNER_PHONE}@c.us`, body, timestamp: 1 } }),
  });
  const e = E({ WAHA_WEBHOOK_SECRET: 'secret' });
  try {
    await worker.fetch(hook('LINK jbu4pe 30k', 'm1'), e, {});
    assert.match(sent.at(-1).text, /Payment link for \*Leather Jacket\* — ₦30,000/);
    assert.match(sent.at(-1).text, /https:\/\/uniquethrift\.ng\/pay\//);

    await worker.fetch(hook('link ZZZZ99', 'm2'), e, {});
    assert.match(sent.at(-1).text, /can't find an item with the code \*ZZZZ99\*/);

    // A bare "link" is still the store page.
    await worker.fetch(hook('link', 'm3'), e, {});
    assert.match(sent.at(-1).text, /\/s\/unique-thrift/);
  } finally { restore(); }
});
