import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../index.js';
import { makeFakeSupabase, installFetch, env } from './fake-supabase.mjs';
import { sign } from '../lib/sign.js';
import { RESERVATION_MINUTES } from '../lib/reservations.js';

// One buyer at a time for each item (lib/reservations.js): once somebody presses
// Pay, everyone else is told a payment is in progress until it goes through
// or its hold runs out.

const TENANT = 'aaaaaaaa-0000-0000-0000-00000000000a';
const JACKET = '11111111-0000-0000-0000-000000000001';
const BAG = '11111111-0000-0000-0000-000000000002';
const OWNER_PHONE = '2348156740439';
const WAHA_URL = 'https://waha.test';

function seed() {
  return {
    tenants: [{
      id: TENANT, slug: 'unique-thrift', name: 'Unique Thrift', status: 'active', commission_pct: 8,
      whatsapp_number: OWNER_PHONE, waha_session: 'ut-unique-thrift', waha_status: 'WORKING',
    }],
    tenant_features: [{ tenant_id: TENANT, flag: 'escrow', enabled: false }],
    products: [
      { id: JACKET, tenant_id: TENANT, public_code: 'JBU4PE', title: 'Leather Jacket', price: 35000, condition: 'excellent', images: [], status: 'active' },
      { id: BAG, tenant_id: TENANT, public_code: 'TOTE22', title: 'Tote Bag', price: 15000, condition: 'good', images: [], status: 'active' },
    ],
  };
}

function fakePaystack() {
  const initialized = [];
  return {
    initialized,
    paystack: async (url, init) => {
      if (url === 'https://api.paystack.co/transaction/initialize') {
        const body = JSON.parse(init.body);
        initialized.push(body);
        return new Response(JSON.stringify({
          status: true,
          data: { authorization_url: `https://checkout.paystack.test/${body.reference}`, reference: body.reference },
        }), { status: 200 });
      }
      return new Response('?', { status: 404 });
    },
  };
}

const waha = { url: WAHA_URL, handler: async () => new Response('{}', { status: 200 }) };

// A Paystack whose verify answers `status` for every reference, or 404 (it
// has never heard of it) when amountKobo is null.
function setup({ amountKobo = null, status = 'success' } = {}) {
  const supabase = makeFakeSupabase(seed());
  const ps = fakePaystack();
  const restore = installFetch({ supabase, waha, paystack: ps.paystack, paystackAmountKobo: amountKobo, paystackStatus: status });
  return { supabase, ps, restore };
}

const E = () => env({ WAHA_URL, WAHA_API_KEY: 'k', WAHA_SESSION: 'ut-platform', PUBLIC_ORIGIN: 'https://uniquethrift.ng', WAHA_TYPING_MS: '0' });

const ADA = { name: 'Ada Obi', phone: '0803 123 4567', address: '12 Allen Avenue, Ikeja, Lagos' };
const BOLA = { name: 'Bola Ade', phone: '0805 555 1234', address: '4 Awolowo Road, Ikoyi, Lagos' };

async function pay(body) {
  const res = await worker.fetch(
    new Request('https://uniquethrift.ng/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    E(),
    {}
  );
  return { status: res.status, body: await res.json() };
}

const get = async (path) => {
  const res = await worker.fetch(new Request(`https://uniquethrift.ng${path}`), E(), {});
  return { status: res.status, body: await res.json() };
};

// Moves a hold into the past, as if its buyer walked away from Paystack.
function lapse(supabase, id = JACKET) {
  const p = supabase.tables.products.find((x) => x.id === id);
  p.held_until = new Date(Date.now() - 60_000).toISOString();
}

test('pressing Pay holds the item for that buyer, and the next buyer is told a payment is in progress', async () => {
  const { supabase, ps, restore } = setup();
  try {
    const first = await pay({ code: 'JBU4PE', ...ADA });
    assert.equal(first.status, 200);

    const jacket = supabase.tables.products.find((p) => p.id === JACKET);
    const order = supabase.tables.orders[0];
    assert.equal(jacket.held_by_ref, order.payment_ref);
    assert.equal(jacket.held_by_buyer, order.buyer_id);
    const minutes = (new Date(jacket.held_until) - Date.now()) / 60_000;
    assert.ok(minutes > RESERVATION_MINUTES - 1 && minutes <= RESERVATION_MINUTES, `held for ${minutes} minutes`);
    assert.equal(order.checkout_url, first.body.url, 'the Paystack page is kept for the same buyer');

    const second = await pay({ code: 'JBU4PE', ...BOLA });
    assert.equal(second.status, 409);
    assert.equal(second.body.held, true);
    assert.equal(second.body.held_minutes, RESERVATION_MINUTES);
    assert.match(second.body.error, /Someone else is paying for this item right now/);
    assert.equal(supabase.tables.orders.length, 1, 'no second order');
    assert.equal(ps.initialized.length, 1, 'no second Paystack page');
  } finally { restore(); }
});

test('the buyer who is paying goes back to the same Paystack page, not a second payment', async () => {
  const { supabase, ps, restore } = setup();
  try {
    const first = await pay({ code: 'JBU4PE', ...ADA });
    const again = await pay({ code: 'JBU4PE', ...ADA, phone: '+234 803 123 4567' });
    assert.equal(again.status, 200);
    assert.equal(again.body.resumed, true);
    assert.equal(again.body.url, first.body.url);
    assert.equal(supabase.tables.orders.length, 1);
    assert.equal(ps.initialized.length, 1);
  } finally { restore(); }
});

test('a buyer pays for one item at a time', async () => {
  const { supabase, restore } = setup();
  try {
    assert.equal((await pay({ code: 'JBU4PE', ...ADA })).status, 200);
    const other = await pay({ code: 'TOTE22', ...ADA });
    assert.equal(other.status, 409);
    assert.equal(other.body.busy, true);
    assert.match(other.body.error, /already paying for Leather Jacket/);
    assert.equal(supabase.tables.products.find((p) => p.id === BAG).held_until, undefined);

    // Somebody else can still buy the bag.
    assert.equal((await pay({ code: 'TOTE22', ...BOLA })).status, 200);
  } finally { restore(); }
});

test('the payment link says "Payment in progress" while held, and "Paid" once sold', async () => {
  const { supabase, restore } = setup();
  try {
    const token = await sign('token-secret-for-tests', { k: 'pay', p: JACKET, a: 30000 }, 3600);
    const free = await get(`/api/checkout/link/${token}`);
    assert.equal(free.status, 200);
    assert.equal(free.body.held_minutes, null);

    await pay({ token, ...ADA });
    const held = await get(`/api/checkout/link/${token}`);
    assert.equal(held.body.held_minutes, RESERVATION_MINUTES);
    assert.equal(held.body.price, 30000);

    supabase.tables.products.find((p) => p.id === JACKET).status = 'sold';
    const sold = await get(`/api/checkout/link/${token}`);
    assert.equal(sold.status, 409);
    assert.equal(sold.body.sold, true);
    assert.match(sold.body.error, /has been paid for/);
  } finally { restore(); }
});

test('once a hold runs out unpaid, the next buyer gets the item', async () => {
  // Paystack has the first payment as abandoned: started, never paid.
  const { supabase, ps, restore } = setup({ amountKobo: 3_500_000, status: 'abandoned' });
  try {
    await pay({ code: 'JBU4PE', ...ADA });
    lapse(supabase);

    const next = await pay({ code: 'JBU4PE', ...BOLA });
    assert.equal(next.status, 200);
    const [adas, bolas] = supabase.tables.orders;
    assert.equal(supabase.tables.products.find((p) => p.id === JACKET).held_by_ref, bolas.payment_ref);
    // Ada's order stays open: a payment on a page she left open still counts.
    assert.equal(adas.status, 'awaiting_payment');
    assert.equal(ps.initialized.length, 2);
  } finally { restore(); }
});

test('a hold that ran out is not taken over if its buyer paid after all', async () => {
  // Ada paid, but neither the webhook nor her return page has landed yet.
  const { supabase, restore } = setup({ amountKobo: 3_500_000, status: 'success' });
  try {
    await pay({ code: 'JBU4PE', ...ADA });
    lapse(supabase);

    const next = await pay({ code: 'JBU4PE', ...BOLA });
    assert.equal(next.status, 409);
    assert.equal(next.body.sold, true);

    const jacket = supabase.tables.products.find((p) => p.id === JACKET);
    assert.equal(jacket.status, 'sold');
    assert.equal(supabase.tables.orders.length, 1, 'no order for Bola');
    assert.equal(supabase.tables.orders[0].status, 'paid', "Ada's payment settled on the spot");
    assert.equal(supabase.tables.payouts.length, 1);
  } finally { restore(); }
});

test("paying settles the item for the buyer holding it, and clears the hold", async () => {
  const { supabase, restore } = setup({ amountKobo: 3_500_000, status: 'success' });
  try {
    const { body } = await pay({ code: 'JBU4PE', ...ADA });
    const paid = await get(`/api/checkout/${body.reference}`);
    assert.equal(paid.body.status, 'paid');

    const jacket = supabase.tables.products.find((p) => p.id === JACKET);
    assert.equal(jacket.status, 'sold');
    assert.equal(jacket.held_by_ref, null);
    assert.equal(jacket.held_until, null);
  } finally { restore(); }
});

test('a payment made after its hold was taken over does not take the item from the new buyer', async () => {
  const { supabase, restore } = setup({ amountKobo: 3_500_000, status: 'abandoned' });
  try {
    const ada = await pay({ code: 'JBU4PE', ...ADA });
    lapse(supabase);
    await pay({ code: 'JBU4PE', ...BOLA });
    const bolaRef = supabase.tables.orders[1].payment_ref;
    restore();

    // Ada finishes paying on the page she left open.
    const refunds = [];
    const restore2 = installFetch({
      supabase,
      waha,
      paystackAmountKobo: 3_500_000,
      paystackStatus: 'success',
      paystack: async (url, init) => {
        if (url.endsWith('/refund')) refunds.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ status: true, data: { id: 5, status: 'pending' } }), { status: 200 });
      },
    });
    try {
      await get(`/api/checkout/${ada.body.reference}`);
      const jacket = supabase.tables.products.find((p) => p.id === JACKET);
      assert.equal(jacket.status, 'active', 'still Bola’s to pay for');
      assert.equal(jacket.held_by_ref, bolaRef);
      // Her money goes straight back, all of it, and the store is owed nothing.
      assert.equal(supabase.tables.orders[0].status, 'refunded');
      assert.equal(refunds[0]?.amount, 3_500_000);
      assert.equal(supabase.tables.payouts.length, 0);
    } finally { restore2(); }
  } finally { restore(); }
});

test('a Paystack page that fails to open puts the item straight back', async () => {
  const supabase = makeFakeSupabase(seed());
  const restore = installFetch({
    supabase,
    waha,
    paystack: async () => new Response(JSON.stringify({ status: false, message: 'nope' }), { status: 400 }),
  });
  try {
    assert.equal((await pay({ code: 'JBU4PE', ...ADA })).status, 502);
    const jacket = supabase.tables.products.find((p) => p.id === JACKET);
    assert.equal(jacket.held_by_ref, null);
    assert.equal(jacket.held_until, null);
  } finally { restore(); }
});
