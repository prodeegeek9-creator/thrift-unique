import { require_, originOf } from '../lib/env.js';
import { approveStore } from '../lib/provision.js';
import { approvedMessage } from '../lib/bot.js';
import { sendText, getSession, phoneFromChatId } from '../lib/waha.js';
import { TIERS, FLAG_MIN_TIER, planIncludes } from '../lib/plans.js';
import { normalizeNumber } from '../lib/phone.js';
import { sendPayout, MAX_ATTEMPTS } from '../lib/transfers.js';
import { startTrial, ensureInvoice, settleInvoice, priceFor } from '../lib/billing.js';
import { ownerSay } from './billing.js';
import { db, SupabaseError } from '../lib/supabase.js';
import { json } from '../lib/http.js';
import { requireOperator, refuse, audit, NotOperator } from '../lib/operator.js';
import { releaseEscrow } from '../lib/orders.js';
import { split } from '../lib/money.js';
import { listTeam, addToTeam, changeTeam, teamLink } from './adminTeam.js';

// The platform-operator console's API.
//
// Everything here reads across tenants, which nothing else in the system may
// do. The privilege comes from requireOperator() and nowhere else, and every
// route that changes something writes an audit row.

export async function handleAdmin(request, env, path) {
  const cfg = require_(env, 'supabaseUrl', 'serviceKey');
  const method = request.method;

  // Owner level for anything that moves money or changes what a tenant pays.
  const needsOwner =
    method === 'POST' && !/\/disputes\/[^/]+\/resolve$/.test(path);

  let op;
  try {
    op = await requireOperator(request, cfg, { level: needsOwner ? 'owner' : 'support' });
  } catch (err) {
    if (err instanceof NotOperator) return refuse(err);
    throw err;
  }

  const rest = path.slice('/api/admin'.length) || '/';

  if (rest === '/me' && method === 'GET') {
    return json({ level: op.level, email: op.email, user_id: op.userId });
  }

  if (rest === '/team' && method === 'GET') return listTeam(cfg, op);
  if (rest === '/team' && method === 'POST') {
    cfg.publicOrigin = originOf(request, cfg);
    return addToTeam(request, cfg, op);
  }
  const teamMember = rest.match(/^\/team\/([0-9a-f-]{36})$/i);
  if (teamMember && method === 'POST') return changeTeam(request, cfg, op, teamMember[1]);
  const teamLinkFor = rest.match(/^\/team\/([0-9a-f-]{36})\/link$/i);
  if (teamLinkFor && method === 'POST') {
    cfg.publicOrigin = originOf(request, cfg);
    return teamLink(cfg, op, teamLinkFor[1]);
  }

  if (rest === '/overview' && method === 'GET') return overview(cfg, request);
  if (rest === '/tenants' && method === 'GET') return listTenants(cfg);
  if (rest === '/escrow' && method === 'GET') return releaseQueue(cfg);
  if (rest === '/disputes' && method === 'GET') return listDisputes(cfg);
  if (rest === '/audit' && method === 'GET') return listAudit(cfg);

  const tenantDetail = rest.match(/^\/tenants\/([0-9a-f-]{36})$/i);
  if (tenantDetail && method === 'GET') return tenantView(cfg, tenantDetail[1]);

  const flag = rest.match(/^\/tenants\/([0-9a-f-]{36})\/flags$/i);
  if (flag && method === 'POST') return setFlag(request, cfg, op, flag[1]);

  const status = rest.match(/^\/tenants\/([0-9a-f-]{36})\/status$/i);
  if (status && method === 'POST') return setStatus(request, cfg, op, status[1]);

  const plan = rest.match(/^\/tenants\/([0-9a-f-]{36})\/plan$/i);
  if (plan && method === 'POST') return setPlan(request, cfg, op, plan[1]);

  const details = rest.match(/^\/tenants\/([0-9a-f-]{36})\/details$/i);
  if (details && method === 'POST') return setDetails(request, cfg, op, details[1]);

  const recorded = rest.match(/^\/tenants\/([0-9a-f-]{36})\/billing\/record$/i);
  if (recorded && method === 'POST') return recordPlanPayment(request, cfg, op, recorded[1]);

  const paused = rest.match(/^\/tenants\/([0-9a-f-]{36})\/payouts-paused$/i);
  if (paused && method === 'POST') return setPayoutsPaused(request, cfg, op, paused[1]);

  const retry = rest.match(/^\/payouts\/([0-9a-f-]{36})\/retry$/i);
  if (retry && method === 'POST') return retryPayout(cfg, op, retry[1]);

  const release = rest.match(/^\/escrow\/([0-9a-f-]{36})\/release$/i);
  if (release && method === 'POST') return forceRelease(request, cfg, op, release[1]);

  const resolve = rest.match(/^\/disputes\/([0-9a-f-]{36})\/resolve$/i);
  if (resolve && method === 'POST') return resolveDispute(request, cfg, op, resolve[1]);

  return json({ error: 'Not found' }, 404);
}

// ── READS ────────────────────────────────────────────────────────────────────

async function overview(cfg, request) {
  const [tenants, orders, held, disputes, platform, owed] = await Promise.all([
    db(cfg).select('tenants', 'select=id,tier,status,waha_session,waha_status,billing_status'),
    db(cfg).select('orders', 'status=in.(paid,completed)&select=amount,commission'),
    db(cfg).select('orders', 'escrow_status=eq.held&select=amount,confirm_deadline'),
    db(cfg).select('disputes', 'status=in.(open,under_review)&select=id'),
    platformHealth(cfg, request),
    db(cfg).select('payouts', 'status=in.(pending,sending)&select=amount,status,failure_reason,attempts'),
  ]);

  const gross = sum(orders, (o) => Number(o.amount));
  const now = Date.now();

  return json({
    tenants: {
      total: tenants.length,
      active: tenants.filter((t) => t.status === 'active').length,
      awaiting: tenants.filter((t) => t.status === 'onboarding').length,
      pastDue: tenants.filter((t) => t.status === 'active' && t.billing_status === 'past_due').length,
      paused: tenants.filter((t) => t.status === 'active' && t.billing_status === 'paused').length,
      byTier: countBy(tenants, (t) => t.tier),
    },
    gmv: gross,
    // The platform's own revenue: the sum of what was actually charged, not a
    // rate applied to the total. Commission is per tenant and negotiable, so
    // the two are not the same number.
    //
    // Settled only. An order still in escrow has not earned anybody anything
    // yet — that hold can still be refunded to the buyer, and counting it here
    // would make the platform's revenue go *down* when a dispute is resolved,
    // which is a number nobody can reconcile against a bank statement.
    commission: sum(orders, (o) => Number(o.commission)),
    orders: orders.length,
    escrow: {
      held: held.length,
      amount: sum(held, (o) => Number(o.amount)),
      // What the platform stands to earn once these holds release. Reported
      // separately rather than folded into `commission` so the two questions —
      // what have we earned, what is still contingent — have separate answers.
      commissionPending: sum(held, (o) => Number(o.commission)),
      // Holds already past their deadline. A number above zero here means the
      // sweep is not running, which is otherwise completely silent.
      overdue: held.filter((o) => o.confirm_deadline && new Date(o.confirm_deadline) < now).length,
    },
    openDisputes: disputes.length,
    platform,
    // Money the platform owes stores and has not yet got to them. `stuck` is
    // the number to act on: Paystack refused, or it ran out of attempts.
    payouts: {
      owed: owed.length,
      amount: sum(owed, (p) => Number(p.amount)),
      stuck: owed.filter((p) => p.status === 'pending' && (p.failure_reason || p.attempts >= MAX_ATTEMPTS)).length,
    },

    // WhatsApp, across the platform.
    //
    // `broken` is the number that matters and the reason this is counted at
    // all: a seller whose phone was unlinked from WhatsApp's own Linked
    // Devices list still has a session and reaches nobody, and nothing else
    // in the system notices. They will not report it as an outage — they will
    // report that sales went quiet, weeks later.
    whatsapp: {
      linked: tenants.filter((t) => t.waha_session).length,
      working: tenants.filter((t) => t.waha_status === 'WORKING').length,
      broken: tenants.filter(
        (t) => t.waha_session && !['WORKING', 'STARTING', 'SCAN_QR_CODE'].includes(t.waha_status)
      ).length,
    },
  });
}

// The platform number, which every store signs up and lists through. Two
// views of it, because either can be wrong while the other looks fine:
//
//   what WAHA says    the session's state, the number it is logged in as,
//                     and where it sends messages
//   what we saw       when a webhook last actually reached this Worker
//
// WAHA can say WORKING while every message it sends is turned away before
// the Worker runs; only the second view shows that.
async function platformHealth(cfg, request) {
  const session = cfg.wahaSession || null;
  const out = {
    session,
    configured: Boolean(cfg.wahaUrl && session),
    status: null,
    number: null,
    name: null,
    webhooks: [],
    expectedWebhook: null,
    webhookOk: null,
    lastEventAt: null,
    lastMessageAt: null,
    error: null,
  };
  if (!out.configured) return out;

  const origin = originOf(request, cfg);
  out.expectedWebhook = origin ? `${origin}/api/waha/webhook` : null;

  const [live, activity] = await Promise.all([
    withTimeout(getSession(cfg, session), 5000).catch((err) => ({ error: err?.message ?? 'unreachable' })),
    db(cfg).one('webhook_activity', `session=eq.${encodeURIComponent(session)}&select=*`).catch(() => null),
  ]);

  if (live?.error) {
    out.status = 'UNREACHABLE';
    out.error = String(live.error).slice(0, 200);
  } else if (!live) {
    out.status = 'MISSING';
  } else {
    out.status = live.status ?? null;
    out.number = phoneFromChatId(live.me?.id) ?? null;
    out.name = live.me?.pushName ?? null;
    out.webhooks = (live.config?.webhooks ?? []).map((w) => w.url).filter(Boolean);
    out.webhookOk = out.expectedWebhook ? out.webhooks.includes(out.expectedWebhook) : null;
  }

  out.lastEventAt = activity?.last_event_at ?? null;
  out.lastMessageAt = activity?.last_message_at ?? null;
  return out;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer in ${ms / 1000}s`)), ms)),
  ]);
}

async function listTenants(cfg) {
  const tenants = await db(cfg).select(
    'tenants',
    'select=id,slug,name,tier,status,commission_pct,whatsapp_number,waha_session,' +
      'waha_status,store_type,category,billing_status,paid_until,plan_price,created_at' +
      '&order=created_at.desc&limit=200'
  );

  // Order counts per tenant, in one query rather than one per row.
  const orders = await db(cfg).select('orders', 'select=tenant_id,amount,status&limit=10000');
  const byTenant = {};
  for (const o of orders) {
    const t = (byTenant[o.tenant_id] ||= { orders: 0, gmv: 0 });
    t.orders += 1;
    if (o.status === 'paid' || o.status === 'completed') t.gmv += Number(o.amount) || 0;
  }

  return json(
    tenants.map((t) => ({ ...t, stats: byTenant[t.id] ?? { orders: 0, gmv: 0 } }))
  );
}

async function tenantView(cfg, tenantId) {
  const [tenant, flags, members, orders, products, submissions, payoutAccount, payouts, planInvoices] = await Promise.all([
    db(cfg).one('tenants', `id=eq.${tenantId}&select=*`),
    db(cfg).select('tenant_features', `tenant_id=eq.${tenantId}&select=flag,enabled&order=flag.asc`),
    db(cfg).select(
      'tenant_members',
      `tenant_id=eq.${tenantId}&select=user_id,role,email,display_name,accepted_at,created_at`
    ),
    db(cfg).select('orders', `tenant_id=eq.${tenantId}&select=amount,commission,status,escrow_status`),
    // What the store has up, and what is waiting on it. Capped: this is a look
    // inside, not a second copy of the store's own dashboard.
    db(cfg).select(
      'products',
      `tenant_id=eq.${tenantId}&select=id,public_code,title,price,status,images,created_at` +
        '&order=created_at.desc&limit=500'
    ),
    db(cfg).select(
      'submissions',
      `tenant_id=eq.${tenantId}&select=id,title,asking_price,seller_name,status,images,created_at` +
        '&order=created_at.desc&limit=200'
    ),
    // Never the recipient code: it is what a transfer is sent with.
    db(cfg).one(
      'payout_accounts',
      `tenant_id=eq.${tenantId}&select=bank_name,account_last4,account_name,updated_at`
    ),
    db(cfg).select(
      'payouts',
      `tenant_id=eq.${tenantId}&select=id,amount,commission,status,reference,failure_reason,attempts,sent_at,paid_at,created_at` +
        '&order=created_at.desc&limit=20'
    ),
    db(cfg).select(
      'plan_invoices',
      `tenant_id=eq.${tenantId}&select=id,tier,amount,period_start,period_end,status,paid_at,paid_via` +
        '&order=period_start.desc&limit=12'
    ),
  ]);

  if (!tenant) return json({ error: 'No such tenant' }, 404);

  // The Paystack subaccount is a credential and does not belong in a console
  // response, even an operator's. Nothing here needs it.
  delete tenant.paystack_subaccount;

  // Who is asking, for a store waiting on approval: the email the owner login
  // will be made for, and when they signed up.
  const signup =
    tenant.status === 'onboarding' && tenant.whatsapp_number
      ? await db(cfg).one(
          'signups',
          `phone=eq.${tenant.whatsapp_number}&state=eq.pending&select=email,created_at`
        )
      : null;

  const countStatus = (rows) => countBy(rows, (r) => r.status);

  return json({
    tenant,
    signup,
    flags,
    members,
    listings: {
      counts: countStatus(products),
      recent: products.slice(0, 24),
    },
    payoutAccount,
    payouts,
    billing: { price: priceFor(tenant), invoices: planInvoices },
    submissions: {
      counts: countStatus(submissions),
      pending: submissions.filter((x) => x.status === 'pending').slice(0, 20),
    },
    stats: {
      orders: orders.length,
      gmv: sum(orders.filter((o) => ['paid', 'completed'].includes(o.status)), (o) => Number(o.amount)),
      commission: sum(orders, (o) => Number(o.commission)),
      held: orders.filter((o) => o.escrow_status === 'held').length,
    },
  });
}

async function releaseQueue(cfg) {
  const orders = await db(cfg).select(
    'orders',
    'escrow_status=eq.held&select=id,tenant_id,order_code,amount,commission,paid_at,' +
      'confirm_deadline,product:products(title),buyer:buyers(name,phone)' +
      '&order=confirm_deadline.asc&limit=200'
  );

  const names = await tenantNames(cfg, orders.map((o) => o.tenant_id));
  const now = Date.now();

  return json(
    orders.map((o) => ({
      ...o,
      tenant_name: names[o.tenant_id] ?? null,
      overdue: Boolean(o.confirm_deadline && new Date(o.confirm_deadline) < now),
      seller_receives: split(o.amount, pctFrom(o)).net,
    }))
  );
}

async function listDisputes(cfg) {
  const disputes = await db(cfg).select(
    'disputes',
    'select=id,tenant_id,order_id,reason,status,outcome,resolution,opened_by,created_at,' +
      'order:orders(order_code,amount,status,escrow_status,payment_ref)' +
      '&order=status.asc,created_at.desc&limit=200'
  );

  const names = await tenantNames(cfg, disputes.map((d) => d.tenant_id));
  return json(disputes.map((d) => ({ ...d, tenant_name: names[d.tenant_id] ?? null })));
}

async function listAudit(cfg) {
  const rows = await db(cfg).select(
    'operator_audit',
    'select=id,actor,action,tenant_id,subject,detail,created_at&order=created_at.desc&limit=100'
  );
  return json(rows);
}

// ── WRITES ───────────────────────────────────────────────────────────────────

async function setFlag(request, cfg, op, tenantId) {
  const { flag, enabled } = await request.json().catch(() => ({}));
  if (typeof flag !== 'string' || typeof enabled !== 'boolean') {
    return json({ error: 'Need { flag, enabled }' }, 400);
  }

  // Upsert by hand: a flag row may not exist yet if the tenant predates it.
  const existing = await db(cfg).one(
    'tenant_features',
    `tenant_id=eq.${tenantId}&flag=eq.${encodeURIComponent(flag)}&select=flag`
  );

  if (existing) {
    await db(cfg).update(
      'tenant_features',
      `tenant_id=eq.${tenantId}&flag=eq.${encodeURIComponent(flag)}`,
      { enabled },
      { returning: false }
    );
  } else {
    await db(cfg).insert('tenant_features', { tenant_id: tenantId, flag, enabled }, { returning: false });
  }

  await audit(cfg, op.userId, 'flag.set', { tenantId, subject: flag, detail: { enabled } });
  return json({ ok: true, flag, enabled });
}

// Moving a store to another plan, and what it pays.
//
// The features are reset to the new plan's: this is the deliberate "move
// between tiers" operation seed_tenant_features() leaves to somebody else, so
// an override set by hand is replaced. Flags can be adjusted again after.
async function setPlan(request, cfg, op, tenantId) {
  const body = await request.json().catch(() => ({}));
  const tier = body?.tier;
  const commission = Number(body?.commission_pct);
  // The monthly fee: undefined leaves it, null goes back to the plan's price,
  // a number (0 for free) is a price agreed with this store.
  let planPrice;
  if (body?.plan_price === null || body?.plan_price === '') planPrice = null;
  else if (body?.plan_price !== undefined) {
    planPrice = Number(body.plan_price);
    if (!Number.isFinite(planPrice) || planPrice < 0 || planPrice > 10_000_000) {
      return json({ error: 'The plan fee is an amount in naira, 0 for free.' }, 400);
    }
  }

  if (!TIERS.includes(tier)) return json({ error: 'Pick a plan.' }, 400);
  if (!Number.isFinite(commission) || commission < 0 || commission > 100) {
    return json({ error: 'Commission is a percentage between 0 and 100.' }, 400);
  }
  const pct = Math.round(commission * 100) / 100;

  const tenant = await db(cfg).one('tenants', `id=eq.${tenantId}&select=id,tier,commission_pct,plan_price`);
  if (!tenant) return json({ error: 'No such tenant' }, 404);

  await db(cfg).update(
    'tenants',
    `id=eq.${tenantId}`,
    { tier, commission_pct: pct, ...(planPrice !== undefined ? { plan_price: planPrice } : {}) },
    { returning: false }
  );

  for (const flag of Object.keys(FLAG_MIN_TIER)) {
    await db(cfg).insert(
      'tenant_features',
      { tenant_id: tenantId, flag, enabled: planIncludes(tier, flag) },
      { onConflict: 'tenant_id,flag', merge: true, returning: false }
    );
  }

  await audit(cfg, op.userId, 'tenant.plan', {
    tenantId,
    detail: {
      from: { tier: tenant.tier, commission_pct: Number(tenant.commission_pct), plan_price: tenant.plan_price ?? null },
      to: { tier, commission_pct: pct, ...(planPrice !== undefined ? { plan_price: planPrice } : {}) },
    },
  });

  return json({ ok: true, tier, commission_pct: pct });
}

// A plan fee paid some other way (a transfer to the platform's account, cash):
// the operator records it, which settles the month and restores a paused
// store, exactly as a Paystack payment would.
async function recordPlanPayment(request, cfg, op, tenantId) {
  const { note } = await request.json().catch(() => ({}));
  const tenant = await db(cfg).one(
    'tenants',
    `id=eq.${tenantId}&select=id,slug,name,tier,status,whatsapp_number,billing_status,paid_until,plan_price,auto_renew`
  );
  if (!tenant) return json({ error: 'No such tenant' }, 404);
  if (!priceFor(tenant)) return json({ error: 'This store pays no plan fee.' }, 409);
  if (!tenant.paid_until) return json({ error: 'This store has not been approved yet.' }, 409);

  const invoice = await ensureInvoice(cfg, tenant, { force: true });
  const result = await settleInvoice(cfg, invoice, { via: 'manual', say: ownerSay(cfg) });
  await audit(cfg, op.userId, 'billing.record', {
    tenantId,
    subject: invoice.payment_ref,
    detail: { amount: Number(invoice.amount), period_end: invoice.period_end, note: note ?? null },
  });
  return json({ ok: result.settled, paid_until: result.paidUntil ?? null });
}

// Holding a store's payouts: they keep accruing, and wait. Released by
// unpausing, which also sends what is owed.
async function setPayoutsPaused(request, cfg, op, tenantId) {
  const { paused } = await request.json().catch(() => ({}));
  if (typeof paused !== 'boolean') return json({ error: 'Need { paused }' }, 400);

  const rows = await db(cfg).update('tenants', `id=eq.${tenantId}`, { payouts_paused: paused });
  if (!rows.length) return json({ error: 'No such tenant' }, 404);

  await audit(cfg, op.userId, paused ? 'payouts.pause' : 'payouts.resume', { tenantId });

  let sent = 0;
  if (!paused) {
    const pending = await db(cfg).select(
      'payouts',
      `tenant_id=eq.${tenantId}&status=eq.pending&select=*&order=created_at.asc&limit=100`
    );
    for (const p of pending) if ((await sendPayout(cfg, p).catch(() => null)) === 'sent') sent += 1;
  }
  return json({ ok: true, paused, sent });
}

// One more go at a payout that is stuck: Paystack refused it, or it used up
// its attempts. The attempt count starts again.
async function retryPayout(cfg, op, payoutId) {
  const payout = await db(cfg).one('payouts', `id=eq.${payoutId}&select=*`);
  if (!payout) return json({ error: 'No such payout' }, 404);
  if (payout.status !== 'pending') return json({ error: `This payout is ${payout.status}, not waiting.` }, 409);

  await db(cfg).update('payouts', `id=eq.${payoutId}`, { attempts: 0 }, { returning: false });
  const result = await sendPayout(cfg, { ...payout, attempts: 0 });

  await audit(cfg, op.userId, 'payouts.retry', {
    tenantId: payout.tenant_id,
    subject: payout.reference,
    detail: { result },
  });
  return json({ ok: result === 'sent', result });
}

const STORE_TYPES = ['consignment', 'brand'];
const CATEGORIES = ['thrift', 'fashion', 'bags-shoes', 'beauty', 'gadgets', 'home', 'other'];

// Correcting a store's details: its name, number, type and category. The slug
// stays: it is inside every link the store has already shared.
async function setDetails(request, cfg, op, tenantId) {
  const body = await request.json().catch(() => ({}));

  const tenant = await db(cfg).one(
    'tenants',
    `id=eq.${tenantId}&select=id,name,status,whatsapp_number,store_type,category`
  );
  if (!tenant) return json({ error: 'No such tenant' }, 404);

  const patch = {};

  if (body.name !== undefined) {
    const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 60) return json({ error: 'A name is 2 to 60 characters.' }, 400);
    patch.name = name;
  }

  if (body.whatsapp_number !== undefined) {
    const number = normalizeNumber(body.whatsapp_number);
    if (number === undefined) {
      return json({ error: "That isn't a WhatsApp number. Use e.g. 08012345678 or 2348012345678." }, 400);
    }
    patch.whatsapp_number = number;
  }

  if (body.store_type !== undefined) {
    if (body.store_type !== null && !STORE_TYPES.includes(body.store_type)) {
      return json({ error: 'Bad store type' }, 400);
    }
    patch.store_type = body.store_type;
  }

  if (body.category !== undefined) {
    if (body.category !== null && !CATEGORIES.includes(body.category)) {
      return json({ error: 'Bad category' }, 400);
    }
    patch.category = body.category;
  }

  if (!Object.keys(patch).length) return json({ error: 'Nothing to change.' }, 400);

  try {
    await db(cfg).update('tenants', `id=eq.${tenantId}`, patch, { returning: false });
  } catch (err) {
    if (err instanceof SupabaseError && err.status === 409) {
      return json({ error: 'That number already belongs to another store.' }, 409);
    }
    throw err;
  }

  // A store still waiting for approval finds its sign-up by number, which is
  // how approval knows whom to create and where to send the news.
  const moved = patch.whatsapp_number && patch.whatsapp_number !== tenant.whatsapp_number;
  if (moved && tenant.status === 'onboarding' && tenant.whatsapp_number) {
    await db(cfg)
      .update('signups', `phone=eq.${tenant.whatsapp_number}`, { phone: patch.whatsapp_number }, { returning: false })
      .catch((err) => console.warn('signup not moved:', err?.message ?? err));
  }

  const from = Object.fromEntries(Object.keys(patch).map((k) => [k, tenant[k] ?? null]));
  await audit(cfg, op.userId, 'tenant.details', { tenantId, detail: { from, to: patch } });

  return json({ ok: true, ...patch });
}

async function setStatus(request, cfg, op, tenantId) {
  const { status } = await request.json().catch(() => ({}));
  if (!['onboarding', 'active', 'suspended'].includes(status)) {
    return json({ error: 'Bad status' }, 400);
  }

  const tenant = await db(cfg).one(
    'tenants',
    `id=eq.${tenantId}&select=id,slug,name,tier,status,whatsapp_number`
  );
  if (!tenant) return json({ error: 'No such tenant' }, 404);

  // Approving a store that signed up over WhatsApp: its owner account is made
  // now, before the status flips, so a failure leaves it pending to try again
  // rather than live with nobody able to sign in.
  let approval = null;
  if (tenant.status === 'onboarding' && status === 'active') {
    cfg.publicOrigin = originOf(request, cfg);
    try {
      approval = await approveStore(cfg, tenant, { origin: cfg.publicOrigin });
    } catch (err) {
      console.error('approval failed:', err?.message ?? err);
      return json({ error: 'Could not create the owner account. Nothing changed; try again.' }, 502);
    }
  }

  await db(cfg).update('tenants', `id=eq.${tenantId}`, { status }, { returning: false });

  // Approval starts the free period (once; see startTrial).
  if (approval) await startTrial(cfg, tenantId).catch((err) => console.error('trial not started:', err?.message ?? err));

  let notified = null;
  if (approval) {
    notified = await tellApproved(cfg, tenant, approval);
    await db(cfg).del('signups', `phone=eq.${tenant.whatsapp_number}`);
  }

  await audit(cfg, op.userId, approval ? 'tenant.approve' : 'tenant.status', {
    tenantId,
    detail: approval ? { status, notified, existing_account: approval.existingAccount } : { status },
  });

  return json({
    ok: true,
    status,
    notified,
    // Only when WhatsApp could not deliver it, so the operator can pass it on
    // some other way. It is a login link; it is not echoed otherwise.
    link: notified === false ? approval.link : null,
  });
}

async function tellApproved(cfg, tenant, { signup, link }) {
  if (!cfg.wahaUrl) return false;
  try {
    await sendText(
      cfg,
      cfg.wahaSession,
      signup.chat_id,
      approvedMessage({
        name: tenant.name,
        slug: tenant.slug,
        link,
        email: signup.email,
        origin: cfg.publicOrigin,
      })
    );
    return true;
  } catch (err) {
    console.error('approval message failed:', err?.message ?? err);
    return false;
  }
}

// Releasing a hold by hand — a buyer who confirmed by phone, or a dispute
// settled in the seller's favour.
//
// Goes through the same releaseEscrow() the sweep and the confirm link use, so
// there is one code path that pays a seller and one place where that can be
// wrong.
async function forceRelease(request, cfg, op, orderId) {
  const { reason } = await request.json().catch(() => ({}));

  const order = await db(cfg).one(
    'orders',
    `id=eq.${orderId}&select=id,tenant_id,order_code,amount,commission,escrow_status,confirmed_at`
  );
  if (!order) return json({ error: 'No such order' }, 404);
  if (order.escrow_status !== 'held') {
    return json({ ok: true, already: true, escrow_status: order.escrow_status });
  }

  const { released } = await releaseEscrow(cfg, order, { reason: 'operator' });

  await audit(cfg, op.userId, 'escrow.release', {
    tenantId: order.tenant_id,
    subject: order.order_code,
    detail: { reason: reason ?? null, amount: order.amount },
  });

  return json({ ok: true, released });
}

// Resolving a dispute, which is the one thing a tenant may never do to a
// dispute raised against them — the policies allow insert only.
//
// Three outcomes, and only one of them moves money back:
//   released   the seller was right; the hold goes to them
//   refunded   the buyer was right; the hold is returned
//   no_action  nothing was owed either way
async function resolveDispute(request, cfg, op, disputeId) {
  const { outcome, resolution } = await request.json().catch(() => ({}));
  if (!['released', 'refunded', 'no_action'].includes(outcome)) {
    return json({ error: 'Bad outcome' }, 400);
  }

  const dispute = await db(cfg).one(
    'disputes',
    `id=eq.${disputeId}&select=id,tenant_id,order_id,status`
  );
  if (!dispute) return json({ error: 'No such dispute' }, 404);
  if (dispute.status === 'resolved') {
    return json({ ok: true, already: true });
  }

  const order = await db(cfg).one(
    'orders',
    `id=eq.${dispute.order_id}&select=id,tenant_id,order_code,amount,commission,escrow_status,confirmed_at,payment_ref`
  );

  let moved = null;

  if (outcome === 'released' && order?.escrow_status === 'held') {
    const { released } = await releaseEscrow(cfg, order, { reason: 'dispute_resolved' });
    moved = released ? 'released' : null;
  }

  if (outcome === 'refunded' && order?.escrow_status === 'held') {
    // Only the hold is reversed here. Returning the money to the buyer's card
    // is a Paystack refund and deliberately NOT fired automatically from a
    // console click — a refund is irreversible and belongs behind its own
    // deliberate step. The state change records the decision; the transfer is
    // made against payment_ref, which is carried in the audit row so whoever
    // does it has the reference to hand.
    await db(cfg).update(
      'orders',
      `id=eq.${order.id}&escrow_status=eq.held`,
      { escrow_status: 'refunded', status: 'refunded' },
      { returning: false }
    );
    moved = 'refunded';
  }

  await db(cfg).update(
    'disputes',
    `id=eq.${disputeId}`,
    {
      status: 'resolved',
      outcome,
      resolution: resolution ?? null,
      resolved_by: op.userId,
      resolved_at: new Date().toISOString(),
    },
    { returning: false }
  );

  await audit(cfg, op.userId, 'dispute.resolve', {
    tenantId: dispute.tenant_id,
    subject: order?.order_code ?? disputeId,
    detail: { outcome, moved, payment_ref: order?.payment_ref ?? null, resolution: resolution ?? null },
  });

  return json({ ok: true, outcome, moved });
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function tenantNames(cfg, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return {};

  const rows = await db(cfg).select('tenants', `id=in.(${unique.join(',')})&select=id,name`);
  return Object.fromEntries(rows.map((t) => [t.id, t.name]));
}

function pctFrom(order) {
  const gross = Number(order.amount) || 0;
  if (!gross) return 0;
  return ((Number(order.commission) || 0) / gross) * 100;
}

function sum(rows, pick) {
  return (rows ?? []).reduce((n, r) => n + (pick(r) || 0), 0);
}

function countBy(rows, pick) {
  const out = {};
  for (const r of rows) out[pick(r)] = (out[pick(r)] ?? 0) + 1;
  return out;
}
