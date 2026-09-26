import { db } from './supabase.js';
import { nairaToKobo } from './money.js';
import { formatNaira } from './bot.js';

// Paying stores, through Paystack Transfers.
//
// A payout row is written when a store is owed (lib/orders.js: straight after
// payment on Starter, on release for escrow). sendPayout() hands it to
// Paystack; Paystack's transfer.success / transfer.failed webhook settles it
// (routes/paystack.js). Anything that could not be sent yet — no bank account,
// payouts paused, Paystack said no — stays 'pending' and the hourly sweep
// tries again.

const API = 'https://api.paystack.co';

// How many times a payout is handed to Paystack before it waits for a person.
export const MAX_ATTEMPTS = 5;

async function paystack(cfg, path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.paystackKey}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload?.status) {
    const err = new Error(payload?.message ?? `Paystack ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return payload.data;
}

// Nigerian banks Paystack can pay into, for the account form.
let banksCache = null;
export async function listBanks(cfg) {
  if (banksCache && banksCache.at > Date.now() - 6 * 3600_000) return banksCache.banks;
  const data = await paystack(cfg, '/bank?country=nigeria&currency=NGN&perPage=200');
  const banks = (data ?? [])
    .filter((b) => b.active !== false && !b.is_deleted)
    .map((b) => ({ code: b.code, name: b.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  banksCache = { at: Date.now(), banks };
  return banks;
}

// The name the bank has on an account, which is how a store knows it typed
// the right number before any money is sent there.
export async function resolveAccount(cfg, { accountNumber, bankCode }) {
  const data = await paystack(
    cfg,
    `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`
  );
  return { accountName: data.account_name, accountNumber: data.account_number };
}

export async function createRecipient(cfg, { name, accountNumber, bankCode }) {
  const data = await paystack(cfg, '/transferrecipient', {
    method: 'POST',
    body: { type: 'nuban', name, account_number: accountNumber, bank_code: bankCode, currency: 'NGN' },
  });
  return data.recipient_code;
}

// Hand one payout to Paystack, if it can go now. Returns what happened, for
// logs and tests: 'sent', or why it is still waiting.
//
// The transfer reference is the payout's own reference, lowercased as
// Paystack requires. Paystack refuses a second transfer with a reference it
// has seen, so even a payout claimed twice cannot be paid twice.
export async function sendPayout(cfg, payout) {
  if (!cfg.paystackKey) return 'not configured';
  if (!payout || payout.status !== 'pending') return 'not pending';
  if ((payout.attempts ?? 0) >= MAX_ATTEMPTS) return 'needs a person';

  const [tenant, account] = await Promise.all([
    db(cfg).one('tenants', `id=eq.${payout.tenant_id}&select=id,name,payouts_paused`),
    db(cfg).one('payout_accounts', `tenant_id=eq.${payout.tenant_id}&select=recipient_code,bank_name,account_last4`),
  ]);
  if (!tenant) return 'no store';
  if (tenant.payouts_paused) return 'paused';
  if (!account?.recipient_code) return 'no bank account';

  // Claim it. Only a pending row matches, so two sweeps cannot both send.
  const claimed = await db(cfg).update(
    'payouts',
    `id=eq.${payout.id}&status=eq.pending`,
    { status: 'sending', attempts: (payout.attempts ?? 0) + 1, sent_at: new Date().toISOString(), failure_reason: null }
  );
  if (!claimed.length) return 'claimed elsewhere';

  try {
    const data = await paystack(cfg, '/transfer', {
      method: 'POST',
      body: {
        source: 'balance',
        amount: nairaToKobo(payout.amount),
        recipient: account.recipient_code,
        reference: String(payout.reference ?? payout.id).toLowerCase(),
        reason: `${tenant.name} payout ${payout.reference ?? ''}`.trim(),
        currency: 'NGN',
      },
    });

    // 'success' can come back at once; usually it is 'pending' and the
    // webhook follows. 'otp' means the Paystack account still asks for an OTP
    // on API transfers, which has to be switched off in its settings.
    if (data?.status === 'otp') {
      await db(cfg).update(
        'payouts',
        `id=eq.${payout.id}`,
        { status: 'pending', failure_reason: 'Paystack asks for an OTP: turn it off for API transfers' },
        { returning: false }
      );
      return 'otp required';
    }

    await db(cfg).update(
      'payouts',
      `id=eq.${payout.id}`,
      {
        transfer_code: data?.transfer_code ?? null,
        ...(data?.status === 'success' ? { status: 'paid', paid_at: new Date().toISOString() } : {}),
      },
      { returning: false }
    );
    return 'sent';
  } catch (err) {
    // Not sent. Back to pending for the sweep, with the reason visible to the
    // store and the operator (e.g. the platform's Paystack balance is short).
    console.error('payout transfer failed:', payout.reference, err?.message ?? err);
    await db(cfg).update(
      'payouts',
      `id=eq.${payout.id}`,
      { status: 'pending', failure_reason: String(err?.message ?? 'Transfer failed').slice(0, 200) },
      { returning: false }
    );
    return 'failed to send';
  }
}

// Every payout a store is waiting on, e.g. when it has just added its bank
// account. Oldest first.
export async function sendPendingFor(cfg, tenantId) {
  const pending = await db(cfg).select(
    'payouts',
    `tenant_id=eq.${tenantId}&status=eq.pending&select=*&order=created_at.asc&limit=100`
  );
  const results = [];
  for (const p of pending ?? []) results.push(await sendPayout(cfg, p));
  return results;
}

// The hourly sweep's half: every pending payout on the platform.
export async function sendAllPending(cfg, { limit = 100 } = {}) {
  const pending = await db(cfg).select(
    'payouts',
    `status=eq.pending&attempts=lt.${MAX_ATTEMPTS}&select=*&order=created_at.asc&limit=${limit}`
  );
  let sent = 0;
  for (const p of pending ?? []) {
    try {
      if ((await sendPayout(cfg, p)) === 'sent') sent += 1;
    } catch (err) {
      console.error('payout sweep: failed on', p.reference, err?.message ?? err);
    }
  }
  return { checked: pending?.length ?? 0, sent };
}

// Paystack's word on a transfer: transfer.success, transfer.failed or
// transfer.reversed. Matched by the reference sendPayout() gave it.
export async function settleTransfer(cfg, event) {
  const reference = event?.data?.reference;
  if (!reference) return { ignored: 'no reference' };

  const payout = await db(cfg).one(
    'payouts',
    // Sent lowercased (Paystack's rule); ours are upper case throughout.
    `reference=eq.${encodeURIComponent(String(reference).toUpperCase())}&select=id,tenant_id,amount,status,reference`
  );
  if (!payout) return { ignored: 'no such payout' };

  if (event.event === 'transfer.success') {
    const rows = await db(cfg).update(
      'payouts',
      `id=eq.${payout.id}&status=in.(sending,pending)`,
      { status: 'paid', paid_at: new Date().toISOString(), failure_reason: null }
    );
    return { payout, status: rows.length ? 'paid' : 'unchanged', newlyPaid: rows.length > 0 };
  }

  // Failed or reversed: the money is back in the platform's balance. Pending
  // again, so it is retried; the reason stays visible.
  const reason = event.event === 'transfer.reversed' ? 'Transfer reversed by the bank' : 'Transfer failed';
  await db(cfg).update(
    'payouts',
    `id=eq.${payout.id}&status=in.(sending,paid)`,
    { status: 'pending', paid_at: null, failure_reason: String(event.data?.reason ?? reason).slice(0, 200) },
    { returning: false }
  );
  return { payout, status: 'pending' };
}

export function paidOutMessage({ amount, bank, last4 }) {
  return `💸 ${formatNaira(amount)} has been paid to your ${bank} account ending ${last4}.`;
}
