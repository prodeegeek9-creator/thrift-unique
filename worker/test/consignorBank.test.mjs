import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../index.js';
import { makeFakeSupabase, installFetch, env } from './fake-supabase.mjs';
import { parseBankMessage, matchBanks, sameName, VERIFY_AFTER_HOURS } from '../lib/consignorBank.js';
import { consignorBankSweep } from '../routes/waha.js';

// Where a store pays the people who bring it items: bank and account number
// on WhatsApp, the name from the bank shown back to confirm, and changes that
// need the same name, at most twice in 6 months, confirmed ~2 hours later by
// the consignor and approved by the store.

const TENANT = 'aaaaaaaa-0000-0000-0000-00000000000b';
const SESSION = 'ut-kay';
const SECRET = 'kay-secret';
const CONSIGNOR = '201164171788478@lid';
const OWNER_NUMBER = '2347036504991';
const OWNER = { id: 'user-owner', email: 'owner@kay.test' };
const STAFF = { id: 'user-staff', email: 'staff@kay.test' };
const TOKENS = { 'tok-owner': OWNER, 'tok-staff': STAFF };
const WAHA_URL = 'https://waha.test';

const BANKS = [
  { code: '044', name: 'Access Bank' },
  { code: '063', name: 'Access Bank (Diamond)' },
  { code: '058', name: 'Guaranty Trust Bank' },
  { code: '011', name: 'First Bank of Nigeria' },
  { code: '214', name: 'First City Monument Bank' },
  { code: '999992', name: 'OPay Digital Services Limited (OPay)' },
];
// What the bank says is on each account.
const ACCOUNTS = {
  '058:0123456789': 'ADEBAYO JOHN OLUWASEUN',
  '044:0987654321': 'JOHN ADEBAYO',
  '999992:8123456789': 'ADEBAYO JOHN',
  '044:1111111111': 'OKON PETER',
};

function seed() {
  return {
    tenants: [{
      id: TENANT, slug: 'kay', name: 'Kay stores', tier: 'starter', status: 'active', store_type: 'consignment',
      whatsapp_number: OWNER_NUMBER, waha_session: SESSION, waha_status: 'WORKING', billing_status: 'active',
    }],
    tenant_members: [
      { tenant_id: TENANT, user_id: OWNER.id, role: 'owner' },
      { tenant_id: TENANT, user_id: STAFF.id, role: 'staff' },
    ],
    whatsapp_secrets: [{ tenant_id: TENANT, webhook_secret: SECRET }],
    tenant_features: [],
    bot_conversations: [],
    bot_messages: [],
    submissions: [{ id: 's1', tenant_id: TENANT, seller_chat_id: CONSIGNOR, seller_name: 'Ade', title: 'Phone', status: 'pending', created_at: '2026-09-26T10:00:00Z' }],
    consignor_accounts: [],
    consignor_account_changes: [],
  };
}

function setup() {
  const sb = makeFakeSupabase(seed());
  const sent = [];
  const lookups = [];
  const restore = installFetch({
    supabase: sb,
    tokens: TOKENS,
    waha: {
      url: WAHA_URL,
      handler: async (url, init) => {
        if (new URL(url).pathname === '/api/sendText') sent.push(JSON.parse(init.body));
        return new Response('{}', { status: 200 });
      },
    },
    paystack: async (url) => {
      const u = new URL(url);
      const ok = (data) => new Response(JSON.stringify({ status: true, data }), { status: 200 });
      if (u.pathname === '/bank') return ok(BANKS);
      if (u.pathname === '/bank/resolve') {
        const key = `${u.searchParams.get('bank_code')}:${u.searchParams.get('account_number')}`;
        lookups.push(key);
        const name = ACCOUNTS[key];
        return name
          ? ok({ account_name: name, account_number: u.searchParams.get('account_number') })
          : new Response(JSON.stringify({ status: false, message: 'Could not resolve account name' }), { status: 422 });
      }
      throw new Error(`unexpected paystack ${u.pathname}`);
    },
  });
  return { sb, sent, lookups, restore };
}

const E = () => env({ WAHA_URL, WAHA_API_KEY: 'k', WAHA_SESSION: 'ut-platform', PUBLIC_ORIGIN: 'https://vendwyze.test', WAHA_TYPING_MS: '0' });

let n = 0;
async function say(...bodies) {
  for (const body of bodies) {
    n += 1;
    await worker.fetch(
      new Request('https://vendwyze.test/api/waha/webhook', {
        method: 'POST',
        headers: { 'X-Thrift-Secret': SECRET },
        body: JSON.stringify({ event: 'message.any', session: SESSION, payload: { id: `b-${n}`, from: CONSIGNOR, fromMe: false, body } }),
      }),
      E(),
      {}
    );
  }
}

const toConsignor = (sent) => sent.filter((m) => m.chatId === CONSIGNOR);
const last = (sent) => toConsignor(sent).at(-1)?.text ?? '';
const toOwner = (sent) => sent.filter((m) => m.chatId === `${OWNER_NUMBER}@c.us`);

function decide(id, decision, token = 'tok-owner') {
  return worker.fetch(
    new Request('https://vendwyze.test/api/submissions/account-change', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant: TENANT, id, decision }),
    }),
    E(),
    {}
  );
}

// Their first account, the name confirmed.
async function firstAccount(sent) {
  await say('BANK', 'GTBank 0123456789');
  assert.match(last(sent), /\*ADEBAYO JOHN OLUWASEUN\* at Guaranty Trust Bank/);
  await say('yes');
}

// ── reading what people type ─────────────────────────────────────────────────

test('bank and account number are read however people type them', () => {
  assert.deepEqual(parseBankMessage('GTBank 0123456789'), { number: '0123456789', bankText: 'GTBank' });
  assert.deepEqual(parseBankMessage('0123456789 access bank'), { number: '0123456789', bankText: 'access' });
  assert.deepEqual(parseBankMessage('Opay: 0812 345 6789'), { number: '8123456789', bankText: 'Opay' });
  assert.deepEqual(parseBankMessage('0123456789'), { number: '0123456789', bankText: null });

  const names = (t) => matchBanks(t, BANKS).map((b) => b.name);
  assert.deepEqual(names('gtb'), ['Guaranty Trust Bank']);
  assert.deepEqual(names('access'), ['Access Bank']);
  assert.deepEqual(names('first'), ['First Bank of Nigeria']);
  assert.deepEqual(names('fcmb'), ['First City Monument Bank']);
  assert.deepEqual(names('opay'), ['OPay Digital Services Limited (OPay)']);
  assert.deepEqual(names('bank of lagos'), []);
});

test('the same person, however the bank prints the name', () => {
  assert.ok(sameName('ADEBAYO JOHN OLUWASEUN', 'JOHN ADEBAYO'));
  assert.ok(sameName('ADEBAYO, JOHN O.', 'Adebayo John'));
  assert.ok(sameName('ADEBAYO J.', 'ADEBAYO JOHN'));
  assert.ok(!sameName('ADEBAYO JOHN', 'ADEBAYO MARY'));
  assert.ok(!sameName('ADEBAYO JOHN', 'OKON PETER'));
});

// ── the first account ────────────────────────────────────────────────────────

test('first account: bank and number in, the bank\'s name back, saved on YES with the rules told', async () => {
  const { sb, sent, restore } = setup();
  try {
    await say('BANK');
    assert.match(last(sent), /2 times in 6 months[\s\S]*same name[\s\S]*approve/);

    // Number first, bank after.
    await say('0123456789');
    assert.match(last(sent), /Which bank/);
    await say('gtb');
    assert.match(last(sent), /\*ADEBAYO JOHN OLUWASEUN\* at Guaranty Trust Bank \(••••6789\)[\s\S]*YES/);
    assert.equal(sb.tables.consignor_accounts.length, 0, 'nothing saved before YES');

    await say('Yes');
    assert.match(last(sent), /Saved[\s\S]*Guaranty Trust Bank ••••6789 \(ADEBAYO JOHN OLUWASEUN\)/);
    const [row] = sb.tables.consignor_accounts;
    assert.equal(row.account_number, '0123456789');
    assert.equal(row.anchor_name, 'ADEBAYO JOHN OLUWASEUN');
    assert.equal(sb.tables.bot_conversations[0].state, 'idle');
  } finally { restore(); }
});

test('a wrong number is caught by the bank, NO asks again, and LATER is fine', async () => {
  const { sb, sent, restore } = setup();
  try {
    await say('BANK', 'GTBank 9999999999');
    assert.match(last(sent), /couldn't find that account at Guaranty Trust Bank/);

    await say('access 0987654321');
    assert.match(last(sent), /\*JOHN ADEBAYO\*/);
    await say('no');
    assert.match(last(sent), /Send your bank and 10-digit account number/);

    await say('later');
    assert.match(last(sent), /Send \*BANK\* to this number any time/);
    assert.equal(sb.tables.consignor_accounts.length, 0);
  } finally { restore(); }
});

test('a longer message mid-way is somebody talking to the store, and the bot keeps out of it', async () => {
  const { sent, restore } = setup();
  try {
    await say('BANK');
    const count = toConsignor(sent).length;
    await say('Good morning, has my phone sold yet?');
    assert.equal(toConsignor(sent).length, count);
  } finally { restore(); }
});

// ── changing it ──────────────────────────────────────────────────────────────

test('a change to an account in another name is refused, and nothing is changed', async () => {
  const { sb, sent, restore } = setup();
  try {
    await firstAccount(sent);
    await say('change account');
    assert.match(last(sent), /same name[\s\S]*2 times in 6 months/);
    await say('Access 1111111111');
    assert.match(last(sent), /in the name \*OKON PETER\*[\s\S]*\*ADEBAYO JOHN OLUWASEUN\*[\s\S]*has not been changed/);
    assert.equal(sb.tables.consignor_account_changes.length, 0);
  } finally { restore(); }
});

test('a change in the same name: confirmed ~2 hours later, approved by the store, then it takes effect', async () => {
  const { sb, sent, restore } = setup();
  try {
    await firstAccount(sent);
    await say('BANK', 'access 0987654321', 'yes');
    assert.match(last(sent), /message you in about 2 hours[\s\S]*Kay stores also has to approve/);

    const [change] = sb.tables.consignor_account_changes;
    assert.equal(change.status, 'pending');
    assert.equal(change.old_account_number, '0123456789');
    assert.match(toOwner(sent).at(-1).text, /Ade asked to change their payout account to Access Bank ••••4321[\s\S]*approval/);
    assert.equal(sb.tables.consignor_accounts[0].account_number, '0123456789', 'still the old one');

    // Not yet: the sweep waits the 2 hours.
    let r = await consignorBankSweep(E(), { now: new Date() });
    assert.equal(r.sent, 0);
    const later = new Date(Date.now() + (VERIFY_AFTER_HOURS * 60 + 5) * 60_000);
    r = await consignorBankSweep(E(), { now: later });
    assert.equal(r.sent, 1);
    assert.match(last(sent), /Did you ask to change your payout account to \*Access Bank ••••4321 \(JOHN ADEBAYO\)\*/);

    // They confirm; the store still has to approve.
    await say('YES');
    assert.match(last(sent), /confirmed\. Kay stores still needs to approve/);
    assert.equal(sb.tables.consignor_accounts[0].account_number, '0123456789');

    // Staff can't; the owner can.
    assert.equal((await decide(change.id, 'approve', 'tok-staff')).status, 403);
    const res = await (await decide(change.id, 'approve')).json();
    assert.equal(res.status, 'applied');
    assert.equal(sb.tables.consignor_accounts[0].account_number, '0987654321');
    assert.equal(sb.tables.consignor_accounts[0].anchor_name, 'ADEBAYO JOHN OLUWASEUN', 'the first name stays the one to match');
    assert.match(last(sent), /Done\. Your payout account is now Access Bank ••••4321/);
  } finally { restore(); }
});

test('approved by the store first, it takes effect the moment they confirm', async () => {
  const { sb, sent, restore } = setup();
  try {
    await firstAccount(sent);
    await say('BANK', 'access 0987654321', 'yes');
    const [change] = sb.tables.consignor_account_changes;
    const res = await (await decide(change.id, 'approve')).json();
    assert.equal(res.status, 'waiting_for_seller');

    await consignorBankSweep(E(), { now: new Date(Date.now() + 3 * 3_600_000) });
    await say('yes');
    assert.match(last(sent), /Done\. Your payout account is now Access Bank/);
    assert.equal(sb.tables.consignor_accounts[0].account_number, '0987654321');
  } finally { restore(); }
});

test('"NO, it wasn\'t me" cancels the change and warns the owner', async () => {
  const { sb, sent, restore } = setup();
  try {
    await firstAccount(sent);
    await say('BANK', 'access 0987654321', 'yes');
    await consignorBankSweep(E(), { now: new Date(Date.now() + 3 * 3_600_000) });
    await say('no');
    assert.match(last(sent), /Cancelled\. Your payout account stays Guaranty Trust Bank ••••6789[\s\S]*someone may have used your phone/);
    assert.equal(sb.tables.consignor_account_changes[0].status, 'cancelled');
    assert.match(toOwner(sent).at(-1).text, /did NOT ask to change their payout account/);
    assert.equal(sb.tables.consignor_accounts[0].account_number, '0123456789');
  } finally { restore(); }
});

test('the store can reject a change, and one left unconfirmed for 2 days lapses', async () => {
  const { sb, sent, restore } = setup();
  try {
    await firstAccount(sent);
    await say('BANK', 'access 0987654321', 'yes');
    let [change] = sb.tables.consignor_account_changes;
    await decide(change.id, 'reject');
    assert.equal(change.status, 'rejected');
    assert.match(last(sent), /didn't approve the change, so your payout account stays Guaranty Trust Bank/);
    assert.equal((await decide(change.id, 'approve')).status, 409, 'decided is decided');

    // A second request, never confirmed.
    await say('BANK', 'opay 08123456789', 'yes');
    change = sb.tables.consignor_account_changes[1];
    await consignorBankSweep(E(), { now: new Date(Date.now() + 3 * 3_600_000) });
    await consignorBankSweep(E(), { now: new Date(Date.now() + 52 * 3_600_000) });
    assert.equal(change.status, 'expired');
    assert.match(last(sent), /wasn't confirmed in time[\s\S]*Guaranty Trust Bank/);
  } finally { restore(); }
});

test('two changes in 6 months, then no more; and one at a time', async () => {
  const { sb, sent, restore } = setup();
  try {
    await firstAccount(sent);
    await say('BANK', 'access 0987654321', 'yes');
    await say('BANK');
    assert.match(last(sent), /already have a change waiting/);

    // The first is applied; a second, then a third is refused.
    const [first] = sb.tables.consignor_account_changes;
    await decide(first.id, 'approve');
    await consignorBankSweep(E(), { now: new Date(Date.now() + 3 * 3_600_000) });
    await say('yes');
    await say('BANK', 'opay 8123456789', 'yes');
    assert.equal(sb.tables.consignor_account_changes.length, 2);
    const second = sb.tables.consignor_account_changes[1];
    await decide(second.id, 'approve');
    await consignorBankSweep(E(), { now: new Date(Date.now() + 3 * 3_600_000) });
    await say('yes');
    assert.equal(sb.tables.consignor_accounts[0].bank_name, 'OPay Digital Services Limited (OPay)');

    await say('BANK');
    assert.match(last(sent), /already changed your payout account 2 times in the last 6 months/);
  } finally { restore(); }
});
