import { require_ } from '../lib/env.js';
import { db } from '../lib/supabase.js';
import { json } from '../lib/http.js';
import { requireOperator, refuse, audit, NotOperator } from '../lib/operator.js';
import { releaseEscrow } from '../lib/orders.js';
import { split } from '../lib/money.js';

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
    return json({ level: op.level, email: op.email });
  }

  if (rest === '/overview' && method === 'GET') return overview(cfg);
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

  const release = rest.match(/^\/escrow\/([0-9a-f-]{36})\/release$/i);
  if (release && method === 'POST') return forceRelease(request, cfg, op, release[1]);

  const resolve = rest.match(/^\/disputes\/([0-9a-f-]{36})\/resolve$/i);
  if (resolve && method === 'POST') return resolveDispute(request, cfg, op, resolve[1]);

  return json({ error: 'Not found' }, 404);
}

// ── READS ────────────────────────────────────────────────────────────────────

async function overview(cfg) {
  const [tenants, orders, held, disputes] = await Promise.all([
    db(cfg).select('tenants', 'select=id,tier,status,waha_session,waha_status'),
    db(cfg).select('orders', 'status=in.(paid,completed)&select=amount,commission'),
    db(cfg).select('orders', 'escrow_status=eq.held&select=amount,confirm_deadline'),
    db(cfg).select('disputes', 'status=in.(open,under_review)&select=id'),
  ]);

  const gross = sum(orders, (o) => Number(o.amount));
  const now = Date.now();

  return json({
    tenants: {
      total: tenants.length,
      active: tenants.filter((t) => t.status === 'active').length,
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

async function listTenants(cfg) {
  const tenants = await db(cfg).select(
    'tenants',
    'select=id,slug,name,tier,status,commission_pct,whatsapp_number,waha_session,' +
      'waha_status,created_at' +
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
  const [tenant, flags, members, orders] = await Promise.all([
    db(cfg).one('tenants', `id=eq.${tenantId}&select=*`),
    db(cfg).select('tenant_features', `tenant_id=eq.${tenantId}&select=flag,enabled&order=flag.asc`),
    db(cfg).select('tenant_members', `tenant_id=eq.${tenantId}&select=user_id,role,created_at`),
    db(cfg).select('orders', `tenant_id=eq.${tenantId}&select=amount,commission,status,escrow_status`),
  ]);

  if (!tenant) return json({ error: 'No such tenant' }, 404);

  // The Paystack subaccount is a credential and does not belong in a console
  // response, even an operator's. Nothing here needs it.
  delete tenant.paystack_subaccount;

  return json({
    tenant,
    flags,
    members,
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

async function setStatus(request, cfg, op, tenantId) {
  const { status } = await request.json().catch(() => ({}));
  if (!['onboarding', 'active', 'suspended'].includes(status)) {
    return json({ error: 'Bad status' }, 400);
  }

  await db(cfg).update('tenants', `id=eq.${tenantId}`, { status }, { returning: false });
  await audit(cfg, op.userId, 'tenant.status', { tenantId, detail: { status } });

  return json({ ok: true, status });
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
