import { require_, originOf } from '../lib/env.js';
import { db } from '../lib/supabase.js';
import { json } from '../lib/http.js';
import { requireMember, refuseMember, NotMember } from '../lib/member.js';
import { listBanks, resolveAccount, createRecipient, sendPendingFor } from '../lib/transfers.js';
import { chatId } from '../lib/waha.js';
import { say } from './waha.js';

// Where a store is paid.
//
//   GET  /api/payouts/banks?tenant=…            the banks Paystack pays into
//   POST /api/payouts/resolve { tenant, bank_code, account_number }
//                                               the name on that account
//   POST /api/payouts/account { tenant, bank_code, account_number }
//                                               save it, and pay what is owed
//
// Owner only for anything that changes where money goes: a manager who could
// point payouts at their own account could take the store's takings. Every
// change is also sent to the owner's WhatsApp, so a change they did not make
// is one they hear about at once.

export async function handlePayouts(request, env, path) {
  const rest = path.slice('/api/payouts'.length) || '/';
  const method = request.method;
  if (rest === '/banks' && method === 'GET') return banks(request, env);
  if (rest === '/resolve' && method === 'POST') return resolve(request, env);
  if (rest === '/account' && method === 'POST') return saveAccount(request, env);
  return json({ error: 'Not found' }, 404);
}

async function gate(request, env, tenantId, roles) {
  const cfg = require_(env, 'supabaseUrl', 'serviceKey');
  cfg.publicOrigin = originOf(request, cfg);
  if (!cfg.paystackKey) return { refusal: json({ error: "Payouts aren't set up yet." }, 503) };
  try {
    const member = await requireMember(request, cfg, tenantId, { roles });
    return { cfg, member };
  } catch (err) {
    if (err instanceof NotMember) return { refusal: refuseMember(err) };
    throw err;
  }
}

async function banks(request, env) {
  const tenantId = new URL(request.url).searchParams.get('tenant');
  const { cfg, refusal } = await gate(request, env, tenantId, ['owner', 'manager']);
  if (refusal) return refusal;
  try {
    return json(await listBanks(cfg));
  } catch (err) {
    console.error('bank list failed:', err?.message ?? err);
    return json({ error: "Couldn't load the bank list. Try again in a minute." }, 502);
  }
}

function readAccount(body) {
  const bankCode = String(body?.bank_code ?? '').trim();
  const accountNumber = String(body?.account_number ?? '').replace(/\D/g, '');
  if (!bankCode) return { error: 'Pick your bank.' };
  if (!/^[0-9]{10}$/.test(accountNumber)) return { error: 'An account number is 10 digits.' };
  return { bankCode, accountNumber };
}

async function resolve(request, env) {
  const body = await request.json().catch(() => ({}));
  const { cfg, refusal } = await gate(request, env, body?.tenant, ['owner']);
  if (refusal) return refusal;

  const input = readAccount(body);
  if (input.error) return json({ error: input.error }, 400);

  try {
    const { accountName } = await resolveAccount(cfg, input);
    return json({ account_name: accountName });
  } catch (err) {
    return json({ error: "That account couldn't be found at that bank. Check the number and the bank." }, 422);
  }
}

async function saveAccount(request, env) {
  const body = await request.json().catch(() => ({}));
  const { cfg, member, refusal } = await gate(request, env, body?.tenant, ['owner']);
  if (refusal) return refusal;
  const tenantId = body.tenant;

  const input = readAccount(body);
  if (input.error) return json({ error: input.error }, 400);

  // Checked again here, not trusted from the resolve step: this is the one
  // that decides where money goes.
  let accountName;
  try {
    ({ accountName } = await resolveAccount(cfg, input));
  } catch {
    return json({ error: "That account couldn't be found at that bank. Check the number and the bank." }, 422);
  }

  const bank = (await listBanks(cfg).catch(() => [])).find((b) => b.code === input.bankCode);
  let recipientCode;
  try {
    recipientCode = await createRecipient(cfg, { name: accountName, ...input });
  } catch (err) {
    console.error('recipient failed:', err?.message ?? err);
    return json({ error: "Paystack couldn't set up that account for payouts. Try again in a minute." }, 502);
  }

  const account = {
    tenant_id: tenantId,
    bank_code: input.bankCode,
    bank_name: bank?.name ?? input.bankCode,
    account_last4: input.accountNumber.slice(-4),
    account_name: accountName,
    recipient_code: recipientCode,
    updated_by: member.userId,
    updated_at: new Date().toISOString(),
  };
  await db(cfg).insert('payout_accounts', account, { onConflict: 'tenant_id', merge: true, returning: false });

  const tenant = await db(cfg).one('tenants', `id=eq.${tenantId}&select=id,name,whatsapp_number`);
  const to = chatId(tenant?.whatsapp_number);
  if (to) {
    await say(
      cfg,
      tenant,
      to,
      `🏦 Your payouts now go to *${account.bank_name}* ••••${account.account_last4} (${accountName}).\n\n` +
        "If you didn't make this change, reply here straight away."
    ).catch(() => {});
  }

  // Whatever the store was already owed goes now.
  const results = await sendPendingFor(cfg, tenantId).catch(() => []);

  return json({
    ok: true,
    bank_name: account.bank_name,
    account_last4: account.account_last4,
    account_name: accountName,
    sent: results.filter((r) => r === 'sent').length,
  });
}
