import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../index.js';
import { makeFakeSupabase, installFetch, env } from './fake-supabase.mjs';

// What a thrift store owes the people it sells for: told when their item
// sells, and again when the store marks them paid.

const TENANT = 'aaaaaaaa-0000-0000-0000-00000000000a';
const PRODUCT = '11111111-0000-0000-0000-000000000001';
const SUB = 'cccccccc-0000-0000-0000-00000000000c';
const CONSIGNOR_CHAT = '201164171788478@lid';
const OWNER = { id: 'user-owner', email: 'o@s.test' };
const STAFF = { id: 'user-staff', email: 's@s.test' };
const TOKENS = { 'tok-owner': OWNER, 'tok-staff': STAFF };
const WAHA_URL = 'https://waha.test';

function seed({ sub = {}, product = {} } = {}) {
  return {
    tenants: [{ id: TENANT, slug: 'unique-thrift', name: 'Unique Thrift', status: 'active', commission_pct: 8,
      whatsapp_number: '2348156740439', waha_session: 'ut-unique-thrift', waha_status: 'WORKING' }],
    tenant_features: [],
    tenant_members: [
      { tenant_id: TENANT, user_id: OWNER.id, role: 'owner' },
      { tenant_id: TENANT, user_id: STAFF.id, role: 'staff' },
    ],
    products: [{ id: PRODUCT, tenant_id: TENANT, public_code: 'NCD123', title: 'Native complete dress', price: 45000,
      status: 'active', images: [], ...product }],
    submissions: [{ id: SUB, tenant_id: TENANT, seller_chat_id: CONSIGNOR_CHAT, seller_name: 'Segun',
      title: 'Native complete dress', asking_price: 30000, condition: 'excellent', status: 'approved',
      product_id: PRODUCT, ...sub }],
    buyers: [{ id: 'b1', tenant_id: TENANT, phone: '2348031234567', name: 'Ada' }],
    orders: [{ id: 'o1', tenant_id: TENANT, order_code: 'UT-NCD234', product_id: PRODUCT, buyer_id: 'b1', amount: 45000,
      commission: 0, status: 'awaiting_payment', escrow_status: 'none', payment_ref: 'utp_consignortest0001' }],
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
        if (new URL(url).pathname === '/api/sendText') sent.push(JSON.parse(init.body));
        return new Response('{}', { status: 200 });
      },
    },
  };
}

const E = () => env({ WAHA_URL, WAHA_API_KEY: 'k', WAHA_SESSION: 'ut-platform', PUBLIC_ORIGIN: 'https://uniquethrift.ng', WAHA_TYPING_MS: '0' });
const post = (path, body, token) => new Request(`https://uniquethrift.ng${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
});

test("a consignor's item selling tells them what the store owes them, from the store's number", async () => {
  // The database trigger (migration 0023) sets owed_amount when the product
  // is sold; here it is already set, as it would be by then.
  const supabase = makeFakeSupabase(seed({ sub: { owed_amount: 30000 } }));
  const { waha, sent } = fakeWaha();
  const restore = installFetch({ supabase, waha, paystackAmountKobo: 4_500_000 });
  try {
    await worker.fetch(new Request('https://uniquethrift.ng/api/checkout/utp_consignortest0001'), E(), {});
    const toConsignor = sent.find((m) => m.chatId === CONSIGNOR_CHAT);
    assert.equal(toConsignor?.session, 'ut-unique-thrift');
    assert.match(toConsignor.text, /Native complete dress\* has sold/);
    assert.match(toConsignor.text, /Unique Thrift owes you ₦30,000/);
    // Not the listing price: what they asked for.
    assert.doesNotMatch(toConsignor.text, /45,000/);
  } finally { restore(); }
});

test('the store marks a consignor paid, once, and the consignor is told', async () => {
  const supabase = makeFakeSupabase(seed({ sub: { sold_at: '2026-09-26T10:00:00Z', owed_amount: 30000 } }));
  const { waha, sent } = fakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });
  try {
    const res = await worker.fetch(post('/api/submissions/paid', { tenant: TENANT, id: SUB, note: 'Sent to your Opay 0803…' }, 'tok-owner'), E(), {});
    assert.equal(res.status, 200);
    assert.equal((await res.json()).notified, true);

    const row = supabase.tables.submissions[0];
    assert.ok(row.consignor_paid_at);
    assert.equal(row.consignor_paid_by, OWNER.id);
    assert.equal(row.consignor_paid_note, 'Sent to your Opay 0803…');

    const told = sent.at(-1);
    assert.equal(told.chatId, CONSIGNOR_CHAT);
    assert.equal(told.session, 'ut-unique-thrift');
    assert.match(told.text, /has paid you ₦30,000 for your \*Native complete dress\*/);
    assert.match(told.text, /Sent to your Opay/);

    const again = await worker.fetch(post('/api/submissions/paid', { tenant: TENANT, id: SUB }, 'tok-owner'), E(), {});
    assert.equal(again.status, 409);
    assert.equal(sent.length, 1);
  } finally { restore(); }
});

test('an unsold item cannot be marked paid, and staff cannot mark payments', async () => {
  const supabase = makeFakeSupabase(seed());
  const { waha, sent } = fakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });
  try {
    const unsold = await worker.fetch(post('/api/submissions/paid', { tenant: TENANT, id: SUB }, 'tok-owner'), E(), {});
    assert.equal(unsold.status, 409);

    supabase.tables.submissions[0].sold_at = '2026-09-26T10:00:00Z';
    const staff = await worker.fetch(post('/api/submissions/paid', { tenant: TENANT, id: SUB }, 'tok-staff'), E(), {});
    assert.equal(staff.status, 403);
    assert.equal(supabase.tables.submissions[0].consignor_paid_at, undefined);
    assert.equal(sent.length, 0);
  } finally { restore(); }
});
