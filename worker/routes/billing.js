import { require_, originOf } from '../lib/env.js';
import { db } from '../lib/supabase.js';
import { json } from '../lib/http.js';
import { requireMember, refuseMember, NotMember } from '../lib/member.js';
import { initializeTransaction, fetchTransaction } from '../lib/paystack.js';
import { nairaToKobo } from '../lib/money.js';
import {
  priceFor,
  ensureInvoice,
  settleInvoice,
  payPageUrl,
  ownerChat,
  PLAN_PRICES,
  TRIAL_DAYS,
} from '../lib/billing.js';
import { say } from './waha.js';

// The plan fee, from the store's side.
//
//   GET  /api/billing?tenant=…              the Billing page: plan, price,
//                                           status, card, invoices
//   POST /api/billing/pay-now { tenant }    open this month's invoice early
//   POST /api/billing/auto-renew { tenant, on }
//   GET  /api/billing/pay/:ref              the pay page (public: the link
//   POST /api/billing/pay/:ref              travels on WhatsApp)
//
// The pay page needs no login: its address is the invoice's unguessable
// reference, and all it lets anybody do is pay that store's fee.

export async function handleBilling(request, env, path) {
  const rest = path.slice('/api/billing'.length) || '/';
  const method = request.method;
  if (rest === '/' && method === 'GET') return summary(request, env);
  if (rest === '/pay-now' && method === 'POST') return payNow(request, env);
  if (rest === '/auto-renew' && method === 'POST') return autoRenew(request, env);
  const pay = rest.match(/^\/pay\/(utb_[a-z0-9]{12,40})$/);
  if (pay && method === 'GET') return payPage(request, env, pay[1]);
  if (pay && method === 'POST') return startPayment(request, env, pay[1]);
  return json({ error: 'Not found' }, 404);
}

// Sending a billing message to the owner, on the platform number.
export function ownerSay(cfg) {
  return (tenant, text) => {
    const to = ownerChat(tenant);
    return to ? say(cfg, tenant, to, text) : Promise.resolve(false);
  };
}

async function member(request, env, tenantId, roles) {
  const cfg = require_(env, 'supabaseUrl', 'serviceKey');
  cfg.publicOrigin = originOf(request, cfg);
  try {
    await requireMember(request, cfg, tenantId, { roles });
    return { cfg };
  } catch (err) {
    if (err instanceof NotMember) return { refusal: refuseMember(err) };
    throw err;
  }
}

const TENANT_FIELDS = 'id,slug,name,tier,status,whatsapp_number,billing_status,paid_until,plan_price,auto_renew';

async function summary(request, env) {
  const tenantId = new URL(request.url).searchParams.get('tenant');
  const { cfg, refusal } = await member(request, env, tenantId, ['owner', 'manager']);
  if (refusal) return refusal;

  const [tenant, card, invoices] = await Promise.all([
    db(cfg).one('tenants', `id=eq.${tenantId}&select=${TENANT_FIELDS}`),
    db(cfg).one('billing_cards', `tenant_id=eq.${tenantId}&select=card_brand,card_last4,exp_month,exp_year`),
    db(cfg).select(
      'plan_invoices',
      `tenant_id=eq.${tenantId}&select=id,tier,amount,period_start,period_end,status,payment_ref,paid_at,paid_via,created_at` +
        '&order=period_start.desc&limit=12'
    ),
  ]);
  if (!tenant) return json({ error: 'No such store' }, 404);

  const open = invoices.find((i) => i.status === 'open') ?? null;
  return json({
    tier: tenant.tier,
    price: priceFor(tenant),
    standard_prices: PLAN_PRICES,
    trial_days: TRIAL_DAYS,
    status: tenant.status === 'onboarding' ? 'awaiting_approval' : priceFor(tenant) === 0 ? 'free' : tenant.billing_status,
    paid_until: tenant.paid_until,
    auto_renew: Boolean(tenant.auto_renew && card),
    card: card ? { brand: card.card_brand, last4: card.card_last4, exp: [card.exp_month, card.exp_year].filter(Boolean).join('/') } : null,
    open_invoice: open ? { ...open, pay_url: payPageUrl(cfg, open) } : null,
    invoices: invoices.map(({ payment_ref, ...i }) => i),
  });
}

async function payNow(request, env) {
  const body = await request.json().catch(() => ({}));
  const { cfg, refusal } = await member(request, env, body?.tenant, ['owner', 'manager']);
  if (refusal) return refusal;

  const tenant = await db(cfg).one('tenants', `id=eq.${body.tenant}&select=${TENANT_FIELDS}`);
  if (!tenant || tenant.status !== 'active') return json({ error: 'Your store needs to be approved first.' }, 409);
  if (!priceFor(tenant)) return json({ error: "Your store doesn't pay a plan fee." }, 409);
  if (!tenant.paid_until) return json({ error: 'Your free trial starts when your store is approved.' }, 409);

  const invoice = await ensureInvoice(cfg, tenant, { force: true });
  return json({ ok: true, pay_url: payPageUrl(cfg, invoice) });
}

// Turning auto-renew off forgets the card; turning it on needs one, which is
// saved by paying once with "renew automatically" ticked.
async function autoRenew(request, env) {
  const body = await request.json().catch(() => ({}));
  const { cfg, refusal } = await member(request, env, body?.tenant, ['owner']);
  if (refusal) return refusal;
  const on = body?.on === true;

  if (on) {
    const card = await db(cfg).one('billing_cards', `tenant_id=eq.${body.tenant}&select=tenant_id`);
    if (!card) return json({ error: 'Pay once by card with "Renew automatically" ticked to save a card.' }, 409);
  } else {
    await db(cfg).del('billing_cards', `tenant_id=eq.${body.tenant}`);
  }
  await db(cfg).update('tenants', `id=eq.${body.tenant}`, { auto_renew: on }, { returning: false });
  return json({ ok: true, auto_renew: on });
}

// ── THE PAY PAGE ─────────────────────────────────────────────────────────────

async function invoiceByRef(cfg, ref) {
  const invoice = await db(cfg).one('plan_invoices', `payment_ref=eq.${ref}&select=*`);
  if (!invoice) return {};
  const tenant = await db(cfg).one('tenants', `id=eq.${invoice.tenant_id}&select=${TENANT_FIELDS}`);
  return { invoice, tenant };
}

async function payPage(request, env, ref) {
  const cfg = require_(env, 'supabaseUrl', 'serviceKey');
  let { invoice, tenant } = await invoiceByRef(cfg, ref);
  if (!invoice) return json({ error: 'No such invoice.' }, 404);

  // Back from Paystack: check the payment ourselves if the webhook is late.
  const reference = new URL(request.url).searchParams.get('reference');
  if (invoice.status === 'open' && reference && reference.startsWith(ref) && cfg.paystackKey) {
    const verified = await fetchTransaction(cfg.paystackKey, reference).catch(() => null);
    if (verified?.status === 'success') {
      cfg.publicOrigin = originOf(request, cfg);
      await settlePlanPayment(cfg, verified);
      ({ invoice, tenant } = await invoiceByRef(cfg, ref));
    }
  }

  return json({
    store: tenant?.name ?? null,
    tier: invoice.tier,
    amount: Number(invoice.amount),
    period_start: invoice.period_start,
    period_end: invoice.period_end,
    status: invoice.status,
    paused: tenant?.billing_status === 'paused',
  });
}

async function startPayment(request, env, ref) {
  const cfg = require_(env, 'supabaseUrl', 'serviceKey');
  if (!cfg.paystackKey) return json({ error: "Payments aren't set up yet." }, 503);
  cfg.publicOrigin = originOf(request, cfg);

  const { invoice, tenant } = await invoiceByRef(cfg, ref);
  if (!invoice) return json({ error: 'No such invoice.' }, 404);
  if (invoice.status !== 'open') return json({ error: 'This invoice is already paid.' }, 409);

  const body = await request.json().catch(() => ({}));
  const owner = await db(cfg).one('tenant_members', `tenant_id=eq.${invoice.tenant_id}&role=eq.owner&select=email`);
  const email = owner?.email || `store-${tenant?.slug ?? 'unknown'}@${new URL(cfg.publicOrigin ?? 'https://example.com').hostname}`;

  try {
    const checkout = await initializeTransaction(cfg.paystackKey, {
      email,
      amountKobo: nairaToKobo(invoice.amount),
      // One reference per attempt (Paystack will not reuse one); the invoice
      // travels in the metadata and as the prefix.
      reference: `${ref}_${crypto.randomUUID().slice(0, 6)}`,
      callbackUrl: `${cfg.publicOrigin ?? ''}/billing/pay/${ref}`,
      metadata: { kind: 'plan', invoice_ref: ref, auto_renew: body?.auto_renew === true, email },
    });
    return json({ ok: true, url: checkout.authorization_url });
  } catch (err) {
    console.error('plan payment initialize failed:', err?.message ?? err);
    return json({ error: "Couldn't start the payment. Try again in a minute." }, 502);
  }
}

// A plan payment Paystack confirmed: from the webhook (routes/paystack.js) or
// the pay page. `data` is Paystack's transaction.
export async function settlePlanPayment(cfg, data) {
  const ref = data?.metadata?.invoice_ref ?? String(data?.reference ?? '').split('_').slice(0, 2).join('_');
  const invoice = await db(cfg).one('plan_invoices', `payment_ref=eq.${ref}&select=*`);
  if (!invoice) return { ignored: 'no such invoice' };

  // Paid in full, or not at all.
  if (Number(data.amount) < nairaToKobo(invoice.amount)) {
    console.error('plan payment short:', ref, data.amount);
    return { ignored: 'amount short' };
  }

  const result = await settleInvoice(cfg, invoice, {
    via: 'link',
    authorization: data.authorization ?? null,
    email: data.customer?.email ?? data.metadata?.email ?? null,
    autoRenew: data.metadata?.auto_renew === true,
    say: ownerSay(cfg),
  });
  return { invoice: ref, ...result };
}
