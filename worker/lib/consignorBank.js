import { db } from './supabase.js';
import { COLUMNS } from './columns.js';
import { listBanks, resolveAccount } from './transfers.js';
import { YES, NO, CANCEL } from './bot.js';
import { INTAKE_STATES } from './intake.js';

// Where a store pays the people who bring it items: their bank account,
// collected on WhatsApp on the store's own number (see migration 0031).
//
// We ask for two things only, the bank and the account number, and show back
// the name the bank has on it. They confirm; nobody types a name.
//
// A change is where money gets stolen, so it has rules, told up front:
//   * the new account must be in the same name as the first one
//   * twice in any 6 months
//   * we confirm it with them about 2 hours later (so it reaches the phone
//     after whoever asked may have put it down), and the store approves it
//   * it takes effect only when both have happened

export const BANK_STATES = ['bank', 'bank_pick', 'bank_confirm', 'bank_verify'];
export const MAX_CHANGES = 2;
export const CHANGE_WINDOW_DAYS = 183;
export const VERIFY_AFTER_HOURS = 2;
export const VERIFY_EXPIRES_HOURS = 48;

// BANK, "change account", "update my bank", "my account details"…
export const BANK = /^\s*(bank|account|(change|update|add|new)( my)? (bank|account)( details| number)?|my (bank|account)( details| number)?)\s*[.!?]*\s*$/i;
const LATER = /^\s*(later|skip|not now|next time)\b/i;

// ── READING WHAT THEY SEND ───────────────────────────────────────────────────

// "GTBank 0123456789", "0123456789 access", "Opay: 812 345 6789"…
export function parseBankMessage(text) {
  const raw = String(text ?? '');
  const compact = raw.replace(/(\d)[\s-]+(?=\d)/g, '$1');
  // Opay, PalmPay and Moniepoint numbers are the phone number without its 0,
  // and people often type the phone number.
  const number =
    /(?:^|\D)(\d{10})(?!\d)/.exec(compact)?.[1] ?? /(?:^|\D)0(\d{10})(?!\d)/.exec(compact)?.[1] ?? null;
  const bankText = compact
    .replace(/0?\d{10}/, ' ')
    .replace(/\b(bank|plc|ltd|limited|nigeria|account|acct|number|no|a\/c)\b/gi, ' ')
    .replace(/[^a-z0-9 ]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { number, bankText: bankText || null };
}

// What people call banks, mapped to words in Paystack's official names.
const ALIASES = {
  gtb: 'guaranty trust', gtbank: 'guaranty trust', gtco: 'guaranty trust', guaranty: 'guaranty trust',
  firstbank: 'first bank', first: 'first bank', fbn: 'first bank',
  uba: 'united bank for africa',
  fcmb: 'first city monument',
  zenith: 'zenith', access: 'access', diamond: 'access', fidelity: 'fidelity',
  opay: 'opay', paycom: 'opay', palmpay: 'palmpay', moniepoint: 'moniepoint', kuda: 'kuda',
  wema: 'wema', alat: 'wema', sterling: 'sterling', union: 'union', stanbic: 'stanbic',
  polaris: 'polaris', ecobank: 'ecobank', eco: 'ecobank', keystone: 'keystone', providus: 'providus',
  jaiz: 'jaiz', unity: 'unity', globus: 'globus', titan: 'titan', taj: 'taj', suntrust: 'suntrust',
  lotus: 'lotus', parallex: 'parallex', premium: 'premiumtrust', premiumtrust: 'premiumtrust',
  '9psb': '9 payment', carbon: 'carbon', vfd: 'vfd', rubies: 'rubies', sparkle: 'sparkle',
  standard: 'standard chartered', citi: 'citibank', citibank: 'citibank',
};

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// The banks a name could mean, best first. One means we know; several, we ask.
export function matchBanks(bankText, banks) {
  const q = norm(bankText);
  if (!q) return [];
  const squashed = q.replace(/ /g, '');
  const target = ALIASES[squashed] ?? ALIASES[q.split(' ')[0]] ?? q;

  const scored = [];
  for (const b of banks ?? []) {
    const name = norm(b.name);
    let score = 0;
    if (name === q || name.replace(/ /g, '') === squashed) score = 100;
    else if (name === target || name === `${target} bank`) score = 95;
    else if (name.startsWith(target)) score = 80;
    else if (name.includes(target)) score = 60;
    else if (target.split(' ').every((w) => w.length > 1 && name.split(' ').includes(w))) score = 40;
    // Shorter names first among equals: "Access Bank" before "Access Bank (Diamond)".
    if (score) scored.push({ bank: b, score, tiebreak: name.length });
  }
  scored.sort((a, b) => b.score - a.score || a.tiebreak - b.tiebreak);
  // A clear leader is certain enough: "access" is Access Bank, not the others
  // that start with the word.
  if (scored.length > 1 && scored[0].score >= 80 && scored[1].score <= scored[0].score - 10) return [scored[0].bank];
  return scored.slice(0, 6).map((s) => s.bank);
}

// The same person? Banks print names differently ("ADEBAYO JOHN",
// "JOHN ADEBAYO OLUWASEUN", "ADEBAYO, JOHN O."), so this compares name parts,
// in any order, and wants two in common (or every part of a one-word name).
export function sameName(a, b) {
  const parts = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 1));
  const x = parts(a);
  const y = parts(b);
  if (!x.size || !y.size) return false;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared >= Math.min(2, x.size, y.size);
}

export const last4 = (n) => String(n ?? '').slice(-4);
const describe = (a) => `${a.bank_name} ••••${last4(a.account_number)} (${a.account_name})`;

// ── WHAT THE BOT SAYS ────────────────────────────────────────────────────────

export const SAY = {
  askFirst: (store) =>
    `💳 One more thing: when your item sells, ${store} pays you by bank transfer.\n\n` +
    'Send your *bank* and *account number*, e.g. *GTBank 0123456789*. ' +
    "We'll check it with your bank and show you the name on it.\n\n" +
    `Please note: you can change it at most *${MAX_CHANGES} times in 6 months*, the new account must be in the *same name*, ` +
    `and ${store} has to approve each change.\n\n` +
    'Reply *LATER* to do this another time.',
  remind: (store) =>
    `💳 Reminder: ${store} still doesn't have your bank details, so it can't pay you when your items sell.\n\n` +
    'Send your *bank* and *account number*, e.g. *GTBank 0123456789* (the name is checked with your bank). ' +
    `It can be changed at most ${MAX_CHANGES} times in 6 months, in the same name.\n\n` +
    'Reply *LATER* to do this another time.',
  askChange: (store, account) =>
    `Your payout account with ${store} is ${describe(account)}.\n\n` +
    'To change it, send the new *bank* and *account number*, e.g. *GTBank 0123456789*.\n\n' +
    `Remember: it must be in the same name, you can change it ${MAX_CHANGES} times in 6 months, ` +
    `and ${store} has to approve it. Reply *CANCEL* to keep it as it is.`,
  askAgain: 'Send your bank and 10-digit account number, e.g. *GTBank 0123456789*. (Reply *CANCEL* to stop.)',
  askNumber: (bank) => `And the 10-digit ${bank} account number?`,
  askBankName: 'Which bank is that account with? (e.g. GTBank, Opay, Access)',
  unknownBank: (text) => `I don't know a bank called "${text}". Send its name as it appears in your banking app, e.g. *Access Bank*.`,
  pick: (banks) =>
    'Which of these is it?\n\n' + banks.map((b, i) => `${i + 1} ${b.name}`).join('\n') + '\n\nReply with the number.',
  notFound: (bank) => `I couldn't find that account at ${bank}. Check the number and bank, and send them again.`,
  lookupDown: "I couldn't check that with the bank just now. Please send it again in a few minutes.",
  confirm: (a) =>
    `This account is *${a.account_name}* at ${a.bank_name} (••••${last4(a.account_number)}).\n\n` +
    'Reply *YES* if that is you, or *NO* to send different details.',
  confirmAgain: 'Reply *YES* if that is your account, or *NO* to send different details.',
  later: 'No problem. Send *BANK* to this number any time to add it, so you can be paid when your item sells.',
  cancelled: 'Okay, nothing changed.',
  saved: (store, a) =>
    `✅ Saved. ${store} will pay you into ${describe(a)} when your items sell.\n\n` +
    `To change it later, send *BANK* (at most ${MAX_CHANGES} times in 6 months, same name, approved by ${store}).`,
  wrongName: (store, current, found) =>
    `That account is in the name *${found}*, but your payout account with ${store} is in the name *${current}*. ` +
    'A new account must be in the same name, so it has not been changed.',
  limit: (store) =>
    `You've already changed your payout account ${MAX_CHANGES} times in the last 6 months, the most allowed. ` +
    `If you need help, message ${store}.`,
  alreadyPending: (change) =>
    `You already have a change waiting to ${describe(change)}. ` +
    "We'll confirm it with you, and it takes effect once the store approves it.",
  requested: (store) =>
    `Got it. For your safety, we'll message you in about ${VERIFY_AFTER_HOURS} hours to confirm this change, ` +
    `and ${store} also has to approve it. Until then, you'll be paid into your current account.`,
  verify: (change) =>
    `🔐 Did you ask to change your payout account to *${describe(change)}*?\n\n` +
    "Reply *YES* to confirm, or *NO* if it wasn't you.",
  verifyAgain: "Reply *YES* to confirm the change, or *NO* if it wasn't you.",
  verified: (store) => `Thanks, confirmed. ${store} still needs to approve it, and we'll tell you when it's done.`,
  notYou: (account) =>
    `Cancelled. Your payout account stays ${describe(account)}.\n\n` +
    "If you didn't ask for this, someone may have used your phone. Keep it locked, and tell the store.",
  applied: (a) => `✅ Done. Your payout account is now ${describe(a)}.`,
  storeRejected: (store, account) =>
    `${store} didn't approve the change, so your payout account stays ${describe(account)}. Message them if you have questions.`,
  expired: (account) =>
    `The change to your payout account wasn't confirmed in time, so it was cancelled. It stays ${describe(account)}. Send *BANK* to try again.`,
};

// For the store owner, on the platform number.
export function ownerChangeMessage({ name, change, origin }) {
  return (
    `🔐 ${name ?? 'A seller'} asked to change their payout account to ${describe(change)}. ` +
    'It needs your approval' +
    (origin ? `: ${origin}/dashboard/submissions` : ' in Items to review.')
  );
}

export function ownerNotYouMessage({ name, change }) {
  return (
    `⚠️ ${name ?? 'A seller'} said they did NOT ask to change their payout account to ${describe(change)}. ` +
    'It has been cancelled. Someone may have had their phone.'
  );
}

// ── THE CONVERSATION ─────────────────────────────────────────────────────────

// A question about bank details lapses after a day; the verification of a
// change has its own deadline (VERIFY_EXPIRES_HOURS, in the sweep).
export const ASK_LAPSES_HOURS = 24;

// Is this message the bank conversation's to answer?
export function wantsBank(conversation, text, now = new Date()) {
  if (BANK.test(String(text ?? ''))) return true;
  const state = conversation?.state;
  if (!BANK_STATES.includes(state)) return false;
  if (state === 'bank_verify') return true;
  const then = new Date(conversation.updated_at ?? 0).getTime();
  return !(then > 0 && now.getTime() - then > ASK_LAPSES_HOURS * 3_600_000);
}

// Somebody halfway through offering an item (or through giving bank
// details), whom a verification message would interrupt.
export function INTAKE_BUSY(conversation, now = new Date()) {
  const state = conversation?.state;
  if (!state || state === 'idle' || state === 'bank_verify') return false;
  if (!INTAKE_STATES.includes(state) && !BANK_STATES.includes(state)) return false;
  const then = new Date(conversation.updated_at ?? 0).getTime();
  return then > 0 && now.getTime() - then < ASK_LAPSES_HOURS * 3_600_000;
}

// A few words could be a bank name or an answer; a longer message that isn't
// one is somebody talking to the store, and the owner answers it.
const chatty = (text) => String(text ?? '').trim().split(/\s+/).length > 3;

export async function accountFor(cfg, tenantId, chat) {
  return db(cfg).one(
    'consignor_accounts',
    `tenant_id=eq.${tenantId}&seller_chat_id=eq.${encodeURIComponent(chat)}&select=${COLUMNS.consignor_account}`
  );
}

async function openChange(cfg, tenantId, chat) {
  return db(cfg).one(
    'consignor_account_changes',
    `tenant_id=eq.${tenantId}&seller_chat_id=eq.${encodeURIComponent(chat)}&status=eq.pending&select=${COLUMNS.consignor_account_change}&order=requested_at.desc`
  );
}

async function changesUsed(cfg, tenantId, chat, now = new Date()) {
  const since = new Date(now.getTime() - CHANGE_WINDOW_DAYS * 86_400_000).toISOString();
  const rows = await db(cfg).select(
    'consignor_account_changes',
    `tenant_id=eq.${tenantId}&seller_chat_id=eq.${encodeURIComponent(chat)}` +
      `&status=in.(pending,applied)&requested_at=gte.${since}&select=id`
  );
  return rows.length;
}

// After every item somebody sends, until we have their account: the full ask
// (with the rules) the first time, a short reminder after that.
export async function firstAsk(cfg, tenant, chat) {
  const have = await accountFor(cfg, tenant.id, chat).catch(() => null);
  if (have) return null;
  const items = await db(cfg)
    .select('submissions', `tenant_id=eq.${tenant.id}&seller_chat_id=eq.${encodeURIComponent(chat)}&select=id&limit=2`)
    .catch(() => []);
  const text = items.length > 1 ? SAY.remind(tenant.name) : SAY.askFirst(tenant.name);
  return { state: 'bank', draft: { mode: 'first' }, replies: [text] };
}

// bankTurn(cfg, tenant, chat, conversation, text)
//   → { state, draft, replies, notifyOwner? } | null (not ours)
//
// Talks to Paystack (bank list, account lookup) and the database, so it lives
// here rather than being a pure step like lib/intake.js.
export async function bankTurn(cfg, tenant, chat, conversation, text) {
  const store = tenant.name;
  const state = BANK_STATES.includes(conversation?.state) ? conversation.state : 'idle';
  const draft = state === 'idle' ? {} : { ...(conversation.draft ?? {}) };
  const body = String(text ?? '').trim();
  const done = (replies, extra = {}) => ({ state: 'idle', draft: {}, replies: [].concat(replies), ...extra });
  const stay = (s, d, reply) => ({ state: s, draft: d, replies: [reply] });

  // BANK from anywhere (other than answering the verification) starts over.
  if (BANK.test(body) && state !== 'bank_verify') {
    const account = await accountFor(cfg, tenant.id, chat);
    if (!account) return stay('bank', { mode: 'first' }, SAY.askFirst(store));
    const pending = await openChange(cfg, tenant.id, chat);
    if (pending) return done(SAY.alreadyPending(pending));
    if ((await changesUsed(cfg, tenant.id, chat)) >= MAX_CHANGES) return done(SAY.limit(store));
    return stay('bank', { mode: 'change' }, SAY.askChange(store, account));
  }

  switch (state) {
    case 'bank': {
      if (draft.mode === 'first' && LATER.test(body)) return done(SAY.later);
      if (CANCEL.test(body)) return done(draft.mode === 'first' ? SAY.later : SAY.cancelled);
      const { number, bankText } = parseBankMessage(body);
      const next = { ...draft, ...(number ? { number } : {}) };
      if (bankText && !(/^\d+$/.test(bankText))) {
        const banks = matchBanks(bankText, await listBanks(cfg));
        if (!banks.length) return !number && chatty(body) ? null : stay('bank', next, SAY.unknownBank(bankText));
        if (banks.length > 1) return stay('bank_pick', { ...next, options: banks }, SAY.pick(banks));
        next.bank = banks[0];
      }
      if (!next.bank && next.number) return stay('bank', next, SAY.askBankName);
      if (next.bank && !next.number) return stay('bank', next, SAY.askNumber(next.bank.name));
      if (!next.bank) return stay('bank', next, SAY.askAgain);
      return lookUp(cfg, tenant, chat, next);
    }

    case 'bank_pick': {
      if (CANCEL.test(body)) return done(draft.mode === 'first' ? SAY.later : SAY.cancelled);
      const i = Number.parseInt(body, 10);
      const bank = draft.options?.[i - 1];
      if (!bank) return stay('bank_pick', draft, SAY.pick(draft.options ?? []));
      const next = { mode: draft.mode, number: draft.number, bank };
      if (!next.number) return stay('bank', next, SAY.askNumber(bank.name));
      return lookUp(cfg, tenant, chat, next);
    }

    case 'bank_confirm': {
      if (NO.test(body)) return stay('bank', { mode: draft.mode }, SAY.askAgain);
      if (!YES.test(body)) return chatty(body) ? null : stay('bank_confirm', draft, SAY.confirmAgain);
      return draft.mode === 'change' ? requestChange(cfg, tenant, chat, draft) : saveFirst(cfg, tenant, chat, draft);
    }

    case 'bank_verify': {
      const change = draft.change_id
        ? await db(cfg).one('consignor_account_changes', `id=eq.${draft.change_id}&tenant_id=eq.${tenant.id}&select=${COLUMNS.consignor_account_change}`)
        : null;
      if (!change || change.status !== 'pending') return done([]);
      if (YES.test(body)) {
        const at = new Date().toISOString();
        await db(cfg).update('consignor_account_changes', `id=eq.${change.id}&status=eq.pending`, { verified_at: at }, { returning: false });
        if (change.store_decision === 'approved') {
          const applied = await applyChange(cfg, { ...change, verified_at: at });
          return done(applied ? SAY.applied(change) : []);
        }
        return done(SAY.verified(store));
      }
      if (NO.test(body)) {
        await db(cfg).update(
          'consignor_account_changes',
          `id=eq.${change.id}&status=eq.pending`,
          { status: 'cancelled' },
          { returning: false }
        );
        const account = await accountFor(cfg, tenant.id, chat);
        return done(SAY.notYou(account ?? change), { notifyOwner: { kind: 'not_you', change } });
      }
      return chatty(body) ? null : stay('bank_verify', draft, SAY.verifyAgain);
    }

    default:
      return null;
  }
}

async function lookUp(cfg, tenant, chat, draft) {
  let found;
  try {
    found = await resolveAccount(cfg, { accountNumber: draft.number, bankCode: draft.bank.code });
  } catch (err) {
    // Paystack answers 422 for an account that doesn't exist at that bank.
    if (err?.status && err.status < 500) {
      return { state: 'bank', draft: { mode: draft.mode }, replies: [SAY.notFound(draft.bank.name)] };
    }
    console.error('account lookup failed:', err?.message ?? err);
    return { state: 'bank', draft: { mode: draft.mode }, replies: [SAY.lookupDown] };
  }
  const candidate = {
    bank_code: draft.bank.code,
    bank_name: draft.bank.name,
    account_number: draft.number,
    account_name: String(found.accountName ?? '').trim(),
  };

  if (draft.mode === 'change') {
    const account = await accountFor(cfg, tenant.id, chat);
    if (account && !sameName(account.anchor_name, candidate.account_name)) {
      return { state: 'idle', draft: {}, replies: [SAY.wrongName(tenant.name, account.anchor_name, candidate.account_name)] };
    }
  }
  return { state: 'bank_confirm', draft: { mode: draft.mode, ...candidate }, replies: [SAY.confirm(candidate)] };
}

async function saveFirst(cfg, tenant, chat, draft) {
  const row = {
    tenant_id: tenant.id,
    seller_chat_id: chat,
    bank_code: draft.bank_code,
    bank_name: draft.bank_name,
    account_number: draft.account_number,
    account_name: draft.account_name,
    anchor_name: draft.account_name,
  };
  // Somebody who already has one (two tabs, a replay) is a change, not this.
  const saved = await db(cfg).insert('consignor_accounts', row, { onConflict: 'tenant_id,seller_chat_id' });
  if (!saved) return { state: 'idle', draft: {}, replies: ['You already have a payout account. Send *BANK* to change it.'] };
  return { state: 'idle', draft: {}, replies: [SAY.saved(tenant.name, row)] };
}

async function requestChange(cfg, tenant, chat, draft) {
  const account = await accountFor(cfg, tenant.id, chat);
  if (!account) return saveFirst(cfg, tenant, chat, draft);
  // Checked again: the limit and the name could have moved since the ask.
  if (await openChange(cfg, tenant.id, chat)) {
    return { state: 'idle', draft: {}, replies: [SAY.alreadyPending(await openChange(cfg, tenant.id, chat))] };
  }
  if ((await changesUsed(cfg, tenant.id, chat)) >= MAX_CHANGES) {
    return { state: 'idle', draft: {}, replies: [SAY.limit(tenant.name)] };
  }
  if (!sameName(account.anchor_name, draft.account_name)) {
    return { state: 'idle', draft: {}, replies: [SAY.wrongName(tenant.name, account.anchor_name, draft.account_name)] };
  }
  const change = {
    tenant_id: tenant.id,
    seller_chat_id: chat,
    bank_code: draft.bank_code,
    bank_name: draft.bank_name,
    account_number: draft.account_number,
    account_name: draft.account_name,
    old_bank_name: account.bank_name,
    old_account_number: account.account_number,
  };
  await db(cfg).insert('consignor_account_changes', change, { returning: false });
  return { state: 'idle', draft: {}, replies: [SAY.requested(tenant.name)], notifyOwner: { kind: 'requested', change } };
}

// Both the consignor and the store have said yes: the new account is theirs.
// Returns true if this call applied it.
export async function applyChange(cfg, change) {
  if (change.status !== 'pending' || !change.verified_at || change.store_decision !== 'approved') return false;
  const claimed = await db(cfg).update(
    'consignor_account_changes',
    `id=eq.${change.id}&status=eq.pending`,
    { status: 'applied', applied_at: new Date().toISOString() }
  );
  if (!claimed.length) return false;
  await db(cfg).update(
    'consignor_accounts',
    `tenant_id=eq.${change.tenant_id}&seller_chat_id=eq.${encodeURIComponent(change.seller_chat_id)}`,
    {
      bank_code: change.bank_code,
      bank_name: change.bank_name,
      account_number: change.account_number,
      account_name: change.account_name,
      updated_at: new Date().toISOString(),
    },
    { returning: false }
  );
  return true;
}
