import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../index.js';
import { makeFakeSupabase, installFetch, env } from './fake-supabase.mjs';
import { sendOwedPayouts } from '../routes/escrow.js';

// Paying stores: the bank account a store saves, the Paystack transfer that
// follows a sale, and Paystack's word on whether it landed.

const TENANT = 'aaaaaaaa-0000-0000-0000-00000000000a';
const OWNER = { id: 'user-owner', email: 'owner@store.test' };
const MANAGER = { id: 'user-manager', email: 'manager@store.test' };
const OPERATOR = { id: 'user-op', email: 'op@platform.test' };
const TOKENS = { 'tok-owner': OWNER, 'tok-manager': MANAGER, 'tok-op': OPERATOR };
const WAHA_URL = 'https://waha.test';
const OWNER_CHAT = '2348156740439@c.us';

function seed({ paused = false, account = false, payouts = [] } = {}) {
  return {
    tenants: [{ id: TENANT, slug: 'unique-thrift', name: 'Unique Thrift', status: 'active', commission_pct: 8,
      whatsapp_number: '2348156740439', payouts_paused: paused }],
    tenant_members: [
      { tenant_id: TENANT, user_id: OWNER.id, role: 'owner' },
      { tenant_id: TENANT, user_id: MANAGER.id, role: 'manager' },
    ],
    platform_admins: [{ user_id: OPERATOR.id, level: 'owner' }],
    operator_audit: [],
    payout_accounts: account
      ? [{ tenant_id: TENANT, bank_code: '058', bank_name: 'GTBank', account_last4: '6789', account_name: 'ADA OBI', recipient_code: 'RCP_existing' }]
      : [],
    payouts,
    payout_items: [],
  };
}

const PENDING = (extra = {}) => ({
  id: 'bbbbbbbb-0000-0000-0000-00000000000b', tenant_id: TENANT, amount: 32200, commission: 2800,
  status: 'pending', reference: 'PO-UT-ABC234', attempts: 0, created_at: '2026-09-26T10:00:00Z', ...extra,
});

function fakePaystack({ transfer = 'pending', resolveOk = true, transferError = null } = {}) {
  const calls = [];
  return {
    calls,
    paystack: async (url, init) => {
      const u = new URL(url);
      const body = init?.body ? JSON.parse(init.body) : null;
      calls.push({ path: u.pathname, query: u.search, body });
      const ok = (data) => new Response(JSON.stringify({ status: true, data }), { status: 200 });
      if (u.pathname === '/bank') return ok([{ code: '058', name: 'GTBank', active: true }, { code: '044', name: 'Access Bank', active: true }]);
      if (u.pathname === '/bank/resolve') {
        return resolveOk
          ? ok({ account_name: 'ADA OBI', account_number: u.searchParams.get('account_number') })
          : new Response(JSON.stringify({ status: false, message: 'Could not resolve account name' }), { status: 422 });
      }
      if (u.pathname === '/transferrecipient') return ok({ recipient_code: 'RCP_new' });
      if (u.pathname === '/transfer') {
        if (transferError) return new Response(JSON.stringify({ status: false, message: transferError }), { status: 400 });
        return ok({ transfer_code: 'TRF_1', status: transfer, reference: body.reference });
      }
      return new Response('?', { status: 404 });
    },
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

const E = (extra = {}) =>
  env({ WAHA_URL, WAHA_API_KEY: 'k', WAHA_SESSION: 'ut-platform', PUBLIC_ORIGIN: 'https://uniquethrift.ng', WAHA_TYPING_MS: '0', ...extra });

const post = (path, body, token) =>
  new Request(`https://uniquethrift.ng${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

async function signed(body, secret = 'sk_test_secret') {
  const raw = JSON.stringify(body);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  const sig = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return new Request('https://uniquethrift.ng/api/paystack/webhook', {
    method: 'POST', headers: { 'x-paystack-signature': sig }, body: raw,
  });
}

test('an owner saves a bank account: checked, stored without the full number, owed money sent', async () => {
  const supabase = makeFakeSupabase(seed({ payouts: [PENDING()] }));
  const { paystack, calls } = fakePaystack();
  const { waha, sent } = fakeWaha();
  const restore = installFetch({ supabase, paystack, waha, tokens: TOKENS });
  try {
    const checked = await worker.fetch(post('/api/payouts/resolve', { tenant: TENANT, bank_code: '058', account_number: '0123456789' }, 'tok-owner'), E(), {});
    assert.deepEqual(await checked.json(), { account_name: 'ADA OBI' });

    const res = await worker.fetch(post('/api/payouts/account', { tenant: TENANT, bank_code: '058', account_number: '012 345 6789' }, 'tok-owner'), E(), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.bank_name, 'GTBank');
    assert.equal(body.account_last4, '6789');
    assert.equal(body.sent, 1);

    const account = supabase.tables.payout_accounts[0];
    assert.equal(account.recipient_code, 'RCP_new');
    assert.equal(account.account_last4, '6789');
    assert.equal(JSON.stringify(account).includes('0123456789'), false, 'the full account number was stored');

    const transfer = calls.find((c) => c.path === '/transfer').body;
    assert.equal(transfer.amount, 3_220_000);
    assert.equal(transfer.recipient, 'RCP_new');
    assert.equal(transfer.reference, 'po-ut-abc234');
    assert.equal(transfer.source, 'balance');

    const payout = supabase.tables.payouts[0];
    assert.equal(payout.status, 'sending');
    assert.equal(payout.transfer_code, 'TRF_1');
    assert.equal(payout.attempts, 1);

    // The owner hears about the change, in case it was not them.
    assert.match(sent.find((m) => m.chatId === OWNER_CHAT).text, /GTBank\* ••••6789 \(ADA OBI\)/);
  } finally { restore(); }
});

test('only the owner can change where money goes, and a wrong account is refused', async () => {
  const supabase = makeFakeSupabase(seed());
  const { paystack } = fakePaystack({ resolveOk: false });
  const restore = installFetch({ supabase, paystack, tokens: TOKENS });
  try {
    const manager = await worker.fetch(post('/api/payouts/account', { tenant: TENANT, bank_code: '058', account_number: '0123456789' }, 'tok-manager'), E(), {});
    assert.equal(manager.status, 403);

    const short = await worker.fetch(post('/api/payouts/account', { tenant: TENANT, bank_code: '058', account_number: '12345' }, 'tok-owner'), E(), {});
    assert.equal(short.status, 400);

    const wrong = await worker.fetch(post('/api/payouts/account', { tenant: TENANT, bank_code: '058', account_number: '0123456789' }, 'tok-owner'), E(), {});
    assert.equal(wrong.status, 422);
    assert.equal(supabase.tables.payout_accounts.length, 0);
  } finally { restore(); }
});

test('a payout waits without a bank account, and the sweep sends it once there is one', async () => {
  const supabase = makeFakeSupabase(seed({ payouts: [PENDING()] }));
  const { paystack, calls } = fakePaystack();
  const restore = installFetch({ supabase, paystack });
  try {
    await sendOwedPayouts(E());
    assert.equal(supabase.tables.payouts[0].status, 'pending');
    assert.equal(calls.filter((c) => c.path === '/transfer').length, 0);

    supabase.tables.payout_accounts.push(seed({ account: true }).payout_accounts[0]);
    const r = await sendOwedPayouts(E());
    assert.equal(r.sent, 1);
    assert.equal(supabase.tables.payouts[0].status, 'sending');

    // A second sweep finds nothing to send.
    await sendOwedPayouts(E());
    assert.equal(calls.filter((c) => c.path === '/transfer').length, 1);
  } finally { restore(); }
});

test('Paystack refusing a transfer leaves it waiting with the reason, and it is retried', async () => {
  const supabase = makeFakeSupabase(seed({ account: true, payouts: [PENDING()] }));
  const { paystack } = fakePaystack({ transferError: 'Your balance is not enough to fulfil this request' });
  const restore = installFetch({ supabase, paystack });
  try {
    await sendOwedPayouts(E());
    const payout = supabase.tables.payouts[0];
    assert.equal(payout.status, 'pending');
    assert.equal(payout.attempts, 1);
    assert.match(payout.failure_reason, /balance is not enough/);
  } finally { restore(); }
});

test('a paused store accrues payouts, and resuming sends them', async () => {
  const supabase = makeFakeSupabase(seed({ paused: true, account: true, payouts: [PENDING()] }));
  const { paystack, calls } = fakePaystack();
  const restore = installFetch({ supabase, paystack, tokens: TOKENS });
  try {
    await sendOwedPayouts(E());
    assert.equal(supabase.tables.payouts[0].status, 'pending');

    const res = await worker.fetch(post(`/api/admin/tenants/${TENANT}/payouts-paused`, { paused: false }, 'tok-op'), E(), {});
    assert.equal((await res.json()).sent, 1);
    assert.equal(calls.filter((c) => c.path === '/transfer').length, 1);
    assert.equal(supabase.tables.operator_audit.at(-1).action, 'payouts.resume');
  } finally { restore(); }
});

test("Paystack's transfer webhooks settle the payout, and the owner is told it landed", async () => {
  const supabase = makeFakeSupabase(seed({ account: true, payouts: [PENDING({ status: 'sending', attempts: 1 })] }));
  const { waha, sent } = fakeWaha();
  const restore = installFetch({ supabase, waha });
  try {
    const ok = await worker.fetch(await signed({ event: 'transfer.success', data: { reference: 'po-ut-abc234' } }), E(), {});
    assert.equal(ok.status, 200);
    assert.equal(supabase.tables.payouts[0].status, 'paid');
    assert.ok(supabase.tables.payouts[0].paid_at);
    assert.match(sent.at(-1).text, /₦32,200 has been paid to your GTBank account ending 6789/);

    // A replay changes nothing and says nothing.
    await worker.fetch(await signed({ event: 'transfer.success', data: { reference: 'po-ut-abc234' } }), E(), {});
    assert.equal(sent.length, 1);

    // A reversal puts it back to waiting, with the reason.
    await worker.fetch(await signed({ event: 'transfer.reversed', data: { reference: 'po-ut-abc234' } }), E(), {});
    assert.equal(supabase.tables.payouts[0].status, 'pending');
    assert.match(supabase.tables.payouts[0].failure_reason, /reversed/);
  } finally { restore(); }
});

test('an operator retries a stuck payout, and it is audited', async () => {
  const supabase = makeFakeSupabase(seed({ account: true, payouts: [PENDING({ attempts: 5, failure_reason: 'Transfer failed' })] }));
  const { paystack, calls } = fakePaystack();
  const restore = installFetch({ supabase, paystack, tokens: TOKENS });
  try {
    // Out of attempts: the sweep leaves it.
    await sendOwedPayouts(E());
    assert.equal(calls.filter((c) => c.path === '/transfer').length, 0);

    const res = await worker.fetch(post(`/api/admin/payouts/${PENDING().id}/retry`, {}, 'tok-op'), E(), {});
    assert.equal((await res.json()).result, 'sent');
    assert.equal(supabase.tables.payouts[0].status, 'sending');
    assert.equal(supabase.tables.operator_audit.at(-1).action, 'payouts.retry');
  } finally { restore(); }
});

test('a Starter sale with a bank account on file is transferred straight away', async () => {
  const PRODUCT = '11111111-0000-0000-0000-000000000001';
  const supabase = makeFakeSupabase({
    ...seed({ account: true }),
    tenant_features: [{ tenant_id: TENANT, flag: 'escrow', enabled: false }],
    products: [{ id: PRODUCT, tenant_id: TENANT, public_code: 'JBU4PE', title: 'Jacket', price: 35000, status: 'active', images: [] }],
    buyers: [{ id: 'b1', tenant_id: TENANT, phone: '2348031234567', name: 'Ada' }],
    orders: [{ id: 'o1', tenant_id: TENANT, order_code: 'UT-ABC234', product_id: PRODUCT, buyer_id: 'b1', amount: 35000,
      commission: 0, status: 'awaiting_payment', escrow_status: 'none', payment_ref: 'utp_testreference0002' }],
  });
  const { paystack, calls } = fakePaystack();
  const { waha, sent } = fakeWaha();
  const restore = installFetch({ supabase, paystack, waha, paystackAmountKobo: 3_500_000 });
  try {
    await worker.fetch(new Request('https://uniquethrift.ng/api/checkout/utp_testreference0002'), E(), {});
    const transfer = calls.find((c) => c.path === '/transfer')?.body;
    assert.equal(transfer?.amount, 3_220_000);
    assert.equal(transfer?.reference, 'po-ut-abc234');
    assert.equal(supabase.tables.payouts[0].status, 'sending');
    assert.match(sent.find((m) => m.chatId === OWNER_CHAT).text, /on its way to your GTBank account ending 6789/);
  } finally { restore(); }
});
