import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../index.js';
import { makeFakeSupabase, installFetch, env } from './fake-supabase.mjs';
import { cartStep, codesIn } from '../lib/cart.js';
import { parseEvent, bareMessageId } from '../lib/waha.js';
import { postToStatus } from '../routes/waha.js';
import { config } from '../lib/env.js';

// Checkout inside WhatsApp: a buyer builds a cart in a chat with the store's
// own number, pays once through Paystack, and gets an order per item.

const TENANT = 'aaaaaaaa-0000-0000-0000-00000000000a';
const P1 = 'dddddddd-0000-0000-0000-000000000001';
const P2 = 'dddddddd-0000-0000-0000-000000000002';
const SESSION = 'ut-shop';
const SECRET = 'store-secret';
const BUYER = '2348011111111@c.us';
const OWNER_NUMBER = '2348022222222';
const WAHA_URL = 'https://waha.test';

function seed({ tier = 'growth', checkout = true, escrow = true } = {}) {
  return {
    tenants: [{
      id: TENANT, slug: 'shop', name: 'Ada Shop', tier, status: 'active', store_type: 'brand', commission_pct: 7,
      whatsapp_number: OWNER_NUMBER, waha_session: SESSION, waha_status: 'WORKING', billing_status: 'active',
    }],
    whatsapp_secrets: [{ tenant_id: TENANT, webhook_secret: SECRET }],
    tenant_features: [
      { tenant_id: TENANT, flag: 'whatsapp_checkout', enabled: checkout },
      { tenant_id: TENANT, flag: 'escrow', enabled: escrow },
    ],
    products: [
      { id: P1, tenant_id: TENANT, public_code: 'JKT001', title: 'Leather jacket', price: 20000, status: 'active', images: ['a.jpg'] },
      { id: P2, tenant_id: TENANT, public_code: 'BAG002', title: 'Tote bag', price: 15000, status: 'active', images: ['b.jpg'] },
    ],
    buyers: [],
    orders: [],
    carts: [],
    payouts: [],
    payout_items: [],
    bot_conversations: [],
    bot_messages: [],
    submissions: [],
    refunds: [],
    status_posts: [],
    listing_channel_posts: [],
    tenant_members: [{ tenant_id: TENANT, user_id: 'user-staff', role: 'staff' }],
    submissions: [],
  };
}

function fakeWaha() {
  const sent = [];
  const statuses = [];
  return {
    sent,
    statuses,
    waha: {
      url: WAHA_URL,
      handler: async (url, init) => {
        const path = new URL(url).pathname;
        if (path === '/api/sendText') sent.push(JSON.parse(init.body));
        const lid = /\/lids\/(.+)$/.exec(path)?.[1];
        if (lid) {
          const pn = { [`${OWNER_NUMBER.slice(3)}@lid`]: `${OWNER_NUMBER}@c.us`, '555@lid': '2348055555555@c.us' }[decodeURIComponent(lid)];
          return pn ? new Response(JSON.stringify({ lid: decodeURIComponent(lid), pn }), { status: 200 }) : new Response('{}', { status: 404 });
        }
        if (path.endsWith('/status/new-message-id')) return new Response(JSON.stringify({ id: 'BAE5STATUS1' }), { status: 200 });
        if (path.endsWith('/status/image')) statuses.push(JSON.parse(init.body));
        return new Response('{}', { status: 200 });
      },
    },
  };
}

function fakePaystack() {
  const calls = [];
  return {
    calls,
    paystack: async (url, init) => {
      const path = new URL(url).pathname;
      const body = init?.body ? JSON.parse(init.body) : null;
      calls.push({ path, body });
      const ok = (data) => new Response(JSON.stringify({ status: true, data }), { status: 200 });
      if (path === '/transaction/initialize') return ok({ authorization_url: `https://checkout.paystack.test/${body.reference}` });
      if (path === '/refund') return ok({ id: 77, status: 'pending' });
      if (path === '/transfer') return ok({ transfer_code: 'TRF', status: 'pending' });
      throw new Error(`unexpected paystack ${path}`);
    },
  };
}

const E = () => env({ WAHA_URL, WAHA_API_KEY: 'k', WAHA_SESSION: 'ut-platform', PUBLIC_ORIGIN: 'https://vendwyze.test', WAHA_TYPING_MS: '0', TOKEN_SECRET: 'tok' });

let n = 0;
function msg(body, { from = BUYER, quoted = null, quotedId = 'status-1' } = {}) {
  n += 1;
  return {
    event: 'message.any',
    session: SESSION,
    payload: {
      id: `in-${n}`,
      timestamp: 1_700_000_000 + n,
      from,
      fromMe: false,
      body,
      ...(quoted != null ? { replyTo: { id: quotedId, body: quoted } } : {}),
    },
  };
}

function ownerSends(body, to = BUYER) {
  n += 1;
  return { event: 'message.any', session: SESSION, payload: { id: `own-${n}`, fromMe: true, from: `${OWNER_NUMBER}@c.us`, to, body } };
}

const hook = (payload) =>
  new Request('https://vendwyze.test/api/waha/webhook', {
    method: 'POST',
    headers: { 'X-Thrift-Secret': SECRET },
    body: JSON.stringify(payload),
  });

async function say(...messages) {
  for (const m of messages) await worker.fetch(hook(m), E(), {});
}

async function signed(body, secret = 'sk_test_secret') {
  const raw = JSON.stringify(body);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  const sig = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return new Request('https://vendwyze.test/api/paystack/webhook', { method: 'POST', headers: { 'x-paystack-signature': sig }, body: raw });
}

function setup(opts = {}, fetchOpts = {}) {
  const sb = makeFakeSupabase(seed(opts));
  const w = fakeWaha();
  const ps = fakePaystack();
  const restore = installFetch({ supabase: sb, waha: w.waha, paystack: ps.paystack, ...fetchOpts });
  return { sb, sent: w.sent, statuses: w.statuses, ps, restore };
}

const toBuyer = (sent) => sent.filter((m) => m.chatId === BUYER);
const last = (sent) => toBuyer(sent).at(-1)?.text ?? '';

// ── the conversation, on its own ─────────────────────────────────────────────

test('codes come from BUY, or from the Status post being replied to', () => {
  assert.deepEqual(codesIn({ body: 'buy jkt001' }), { own: 'JKT001', quoted: null });
  assert.deepEqual(codesIn({ body: 'I want this', quoted: 'Leather jacket\nReply BUY JKT001 to order' }), { own: null, quoted: 'JKT001' });
  assert.deepEqual(codesIn({ body: 'nice', quoted: 'https://vendwyze.test/p/BAG002' }), { own: null, quoted: 'BAG002' });
  assert.deepEqual(codesIn({ body: 'do you sell bags?' }), { own: null, quoted: null });
});

test('the bot stays out of ordinary chat, even with a cart open', () => {
  assert.equal(cartStep(null, { body: 'Good morning, is the jacket still there?' }), null);
  const conv = { state: 'cart', draft: { items: [{ code: 'JKT001', title: 'J', price: 1 }] }, updated_at: new Date().toISOString() };
  assert.equal(cartStep(conv, { body: 'can you do 18k?' }), null);
});

test("WhatsApp tells the store's own messages apart from incoming ones", () => {
  const out = parseEvent(ownerSends('hello'));
  assert.equal(out.kind, 'outgoing');
  assert.equal(out.to, BUYER);
  const incoming = parseEvent(msg('BUY JKT001', { quoted: 'Reply BUY JKT001 to order' }));
  assert.equal(incoming.kind, 'message');
  assert.match(incoming.quoted, /BUY JKT001/);
});

// ── end to end ───────────────────────────────────────────────────────────────

test('a buyer builds a cart, pays once, and gets an order per item', async () => {
  const { sb, sent, ps, restore } = setup();
  try {
    await say(msg('BUY JKT001'));
    assert.match(last(sent), /Added \*Leather jacket\*/);
    await say(msg('buy bag002'));
    assert.match(last(sent), /Total: ₦35,000/);
    await say(msg('checkout'));
    assert.match(last(sent), /What name/);
    await say(msg('Ada Obi'));
    await say(msg('12 Allen Avenue, Ikeja, Lagos'));
    assert.match(last(sent), /Deliver to: 12 Allen Avenue/);
    await say(msg('PAY'));

    const init = ps.calls.find((c) => c.path === '/transaction/initialize');
    assert.equal(init.body.amount, 3_500_000);
    assert.match(init.body.reference, /^utc_[a-z0-9]{20}$/);
    assert.match(last(sent), /checkout\.paystack\.test/);
    assert.match(last(sent), /only paid once you confirm/);

    const cart = sb.tables.carts[0];
    assert.equal(cart.amount, 35000);
    assert.equal(cart.buyer_name, 'Ada Obi');
    const orders = sb.tables.orders.filter((o) => o.cart_id === cart.id);
    assert.deepEqual(orders.map((o) => o.payment_ref).sort(), [`${cart.payment_ref}_1`, `${cart.payment_ref}_2`]);
    assert.ok(orders.every((o) => o.status === 'awaiting_payment' && o.source_channel === 'whatsapp'));

    // Paystack confirms the one payment.
    const before = sent.length;
    const res = await worker.fetch(
      await signed({ event: 'charge.success', data: { reference: cart.payment_ref, amount: 3_500_000, metadata: { kind: 'cart', cart_ref: cart.payment_ref } } }),
      E(),
      {}
    );
    assert.equal(res.status, 200);
    assert.equal(cart.status, 'paid');
    for (const o of orders) {
      assert.equal(o.status, 'escrow');
      assert.equal(o.escrow_status, 'held');
    }
    assert.ok(sb.tables.products.every((p) => p.status === 'sold'));

    // One message to the buyer and one to the owner for the lot.
    const after = sent.slice(before);
    assert.equal(after.filter((m) => m.chatId === BUYER).length, 1);
    assert.equal(after.filter((m) => m.chatId === `${OWNER_NUMBER}@c.us`).length, 1);
    assert.match(after.find((m) => m.chatId === BUYER).text, /Payment received/);
    assert.equal(after.find((m) => m.chatId === BUYER).session, SESSION, 'answered from the store number');
    assert.match(after.find((m) => m.chatId !== BUYER).text, /New WhatsApp order.*2 items/);

    // A replay changes nothing.
    await worker.fetch(await signed({ event: 'charge.success', data: { reference: cart.payment_ref, amount: 3_500_000 } }), E(), {});
    assert.equal(sent.length, before + 2);
    assert.equal(sb.tables.bot_conversations[0].state, 'idle');
  } finally { restore(); }
});

test('an item sold to someone else before payment is refunded straight away', async () => {
  const { sb, sent, ps, restore } = setup({}, { paystackAmountKobo: 3_500_000, paystackFeesKobo: 0 });
  try {
    await say(msg('BUY JKT001'), msg('BUY BAG002'), msg('checkout'), msg('Ada Obi'), msg('12 Allen Avenue, Ikeja'), msg('pay'));
    const cart = sb.tables.carts[0];
    // Sold on the store page in the meantime.
    sb.tables.products.find((p) => p.id === P2).status = 'sold';

    await worker.fetch(await signed({ event: 'charge.success', data: { reference: cart.payment_ref, amount: 3_500_000 } }), E(), {});

    const bagOrder = sb.tables.orders.find((o) => o.product_id === P2);
    assert.equal(bagOrder.status, 'refunded');
    const refund = ps.calls.find((c) => c.path === '/refund');
    assert.equal(refund.body.transaction, cart.payment_ref, 'refunded against the cart payment');
    assert.equal(refund.body.amount, 1_500_000, 'only that item');
    assert.equal(sb.tables.refunds[0].requested_via, 'auto');
    assert.match(last(sent), /Tote bag\* was sold to someone else/);
  } finally { restore(); }
});

test('replying to a Status post: "I want this" adds it, a price or availability question is answered', async () => {
  const { sent, restore } = setup();
  const caption = 'Leather jacket\n₦20,000 · Excellent\nReply BUY JKT001 to order\nhttps://vendwyze.test/p/JKT001';
  try {
    await say(msg('Is it still available?', { quoted: caption }));
    assert.match(last(sent), /\*Leather jacket\* is ₦20,000, and it's still available\. Reply \*BUY JKT001\*/);
    await say(msg('I want this', { quoted: caption }));
    assert.match(last(sent), /Added \*Leather jacket\*/);
  } finally { restore(); }
});

test('any other question about a post, or a reply to a post that is not an item, is left for the owner', async () => {
  const { sb, sent, restore } = setup();
  const caption = 'Leather jacket\n₦20,000 · Excellent\nReply BUY JKT001 to order';
  try {
    await say(
      msg('Is it available in size 42?', { quoted: caption }),
      msg('Can I see the back?', { quoted: caption }),
      msg('I want this', { quoted: 'Happy Sunday from Ada Shop!' }),
      msg('How much?', { quoted: 'New stock landing Friday' })
    );
    assert.equal(toBuyer(sent).length, 0);
    assert.equal(sb.tables.bot_messages.length, 0, 'not the bot\'s, so not logged');
  } finally { restore(); }
});

test('the bot answers price and availability questions only when that is the whole message', () => {
  const P = { JKT001: { id: P1, title: 'Leather jacket', price: 20000, status: 'active' } };
  const ask = (body) => cartStep(null, { body, quoted: 'Reply BUY JKT001 to order' }, { products: P });
  for (const q of ['How much?', 'price pls', 'Good morning, how much is this?', 'is this still available?', 'still dey?', 'Sold?']) {
    assert.match(ask(q)?.replies[0] ?? '', /still available/, q);
  }
  for (const q of ['Is it available in size 42?', 'how much for two?', 'does it come in blue?', 'nice']) {
    assert.equal(ask(q), null, q);
  }
  const sold = cartStep(null, { body: 'available?', quoted: 'BUY JKT001' }, { products: { JKT001: { ...P.JKT001, status: 'sold' } } });
  assert.match(sold.replies[0], /has sold/);
});

test('a Status post Vendwyze makes is saved under its WhatsApp ID, and a reply to it names the item without the caption', async () => {
  const { sb, sent, statuses, restore } = setup();
  try {
    const tenant = sb.tables.tenants[0];
    const posted = await postToStatus(config(E()), tenant, sb.tables.products[0]);
    assert.equal(posted, true);
    assert.equal(statuses[0].id, 'BAE5STATUS1', 'posted under the ID WAHA handed out');
    assert.match(statuses[0].caption, /Reply BUY JKT001 to order/);
    assert.deepEqual(
      sb.tables.status_posts.map((r) => [r.product_id, r.message_id]),
      [[P1, 'BAE5STATUS1']]
    );

    // WhatsApp sent the reply with an empty quote, and the serialised ID.
    await say(msg('how much?', { quoted: '', quotedId: 'false_status@broadcast_BAE5STATUS1_2348022222222@c.us' }));
    assert.match(last(sent), /Leather jacket\* is ₦20,000/);
    await say(msg('I want this', { quoted: '', quotedId: 'BAE5STATUS1' }));
    assert.match(last(sent), /Added \*Leather jacket\*/);
  } finally { restore(); }
});

test('a quoted message ID is read bare, whichever way WAHA writes it', () => {
  assert.equal(bareMessageId('BAE5ABC'), 'BAE5ABC');
  assert.equal(bareMessageId('false_status@broadcast_BAE5ABC_2348022222222@c.us'), 'BAE5ABC');
  assert.equal(bareMessageId('true_2348011111111@c.us_3EB0XYZ'), '3EB0XYZ');
  assert.equal(bareMessageId(null), null);
  const noweb = parseEvent({
    event: 'message',
    session: SESSION,
    payload: {
      id: 'x', from: BUYER, fromMe: false, body: 'I want this',
      _data: { message: { extendedTextMessage: { text: 'I want this', contextInfo: { stanzaId: 'BAE5ABC', remoteJid: 'status@broadcast', quotedMessage: { imageMessage: {} } } } } },
    },
  });
  assert.equal(noweb.quotedId, 'BAE5ABC');
  assert.equal(noweb.quoted, null);
});

test('when the owner types in a chat, the bot steps back from it', async () => {
  const { sb, sent, restore } = setup();
  try {
    await say(msg('BUY JKT001'));
    const botLine = last(sent);

    // The bot's own message echoed back is not the owner.
    await say(ownerSends(botLine));
    assert.equal(sb.tables.bot_conversations[0].paused_until ?? null, null);

    // The owner typing is.
    await say(ownerSends('Hi Ada! Yes it is, I can do 18k for you'));
    assert.ok(sb.tables.bot_conversations[0].paused_until);

    const count = toBuyer(sent).length;
    await say(msg('checkout'), msg('Can you deliver to Ikeja?'));
    assert.equal(toBuyer(sent).length, count, 'the bot talked over the owner');

    // Asked for by name, it answers, and the pause is over.
    await say(msg('BUY BAG002'));
    assert.match(last(sent), /Added \*Tote bag\*/);
    assert.equal(sb.tables.bot_conversations[0].paused_until, null);
  } finally { restore(); }
});

test('SELL reaches the bot even in a chat the owner has just typed in', async () => {
  const { sb, sent, restore } = setup({ tier: 'starter', checkout: false, escrow: false });
  sb.tables.tenants[0].store_type = 'consignment';
  try {
    // "Send SELL to my number and the bot will help you"
    await say(ownerSends('Send SELL to this number and the bot will take you through it'));
    assert.ok(sb.tables.bot_conversations[0].paused_until);

    await say(msg('Sell'));
    assert.match(last(sent), /assistant/i);
    assert.equal(sb.tables.bot_conversations[0].paused_until ?? null, null);
  } finally { restore(); }
});

test('a Starter store: BUY is left for the owner, and nothing is logged', async () => {
  const { sb, sent, restore } = setup({ tier: 'starter', checkout: false, escrow: false });
  try {
    await say(msg('BUY JKT001'));
    assert.equal(sent.length, 0);
    assert.equal(sb.tables.bot_messages.length, 0);
  } finally { restore(); }
});

test('CANCEL after a payment link drops the unpaid cart and its orders', async () => {
  const { sb, restore } = setup();
  try {
    await say(msg('BUY JKT001'), msg('checkout'), msg('Ada Obi'), msg('12 Allen Avenue, Ikeja'), msg('pay'));
    await say(msg('cancel'));
    assert.equal(sb.tables.carts[0].status, 'cancelled');
    assert.ok(sb.tables.orders.every((o) => o.status === 'cancelled'));
    assert.equal(sb.tables.products[0].status, 'active');
  } finally { restore(); }
});

test('the dashboard lists the chats on hold, and Resume bot hands one or all back', async () => {
  const { sb, sent, restore } = setup({}, { tokens: { 'tok-staff': { id: 'user-staff', email: 's@x.test' } } });
  const api = (path, { method = 'GET', body, token = 'tok-staff' } = {}) =>
    worker.fetch(
      new Request(`https://vendwyze.test/api/waha${path}`, {
        method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      }),
      E(),
      {}
    );
  try {
    sb.tables.carts.push({ id: 'c1', tenant_id: TENANT, chat_id: '555@lid', buyer_name: 'Tolu', payment_ref: 'utc_x', amount: 1, created_at: new Date().toISOString() });
    await say(
      ownerSends('I will send you the account number', '555@lid'),
      ownerSends('Hello', BUYER),
      // Messaging yourself, or a Status post: nobody is waiting on the bot there.
      ownerSends('note to self', `${OWNER_NUMBER.slice(3)}@lid`)
    );

    assert.ok((await api(`/holds?tenant=${TENANT}`, { token: null })).status >= 401, 'signed-out');

    let { holds } = await (await api(`/holds?tenant=${TENANT}`)).json();
    assert.deepEqual(
      holds.map((h) => [h.chat_id, h.name, h.phone, h.note]).sort(),
      [
        ['2348011111111@c.us', null, '2348011111111', 'Hello'],
        ['555@lid', 'Tolu', '2348055555555', 'I will send you the account number'],
      ]
    );

    const one = await (await api('/holds/resume', { method: 'POST', body: { tenant: TENANT, chat: BUYER } })).json();
    assert.equal(one.resumed, 1);
    ({ holds } = await (await api(`/holds?tenant=${TENANT}`)).json());
    assert.deepEqual(holds.map((h) => h.chat_id), ['555@lid']);

    // And the bot answers there again.
    await say(msg('BUY JKT001'));
    assert.match(last(sent), /Added/);

    const all = await (await api('/holds/resume', { method: 'POST', body: { tenant: TENANT } })).json();
    assert.equal(all.resumed, 2, 'the rest, including the note-to-self chat');
    ({ holds } = await (await api(`/holds?tenant=${TENANT}`)).json());
    assert.deepEqual(holds, []);
  } finally { restore(); }
});
