import { require_ } from '../lib/env.js';
import { db } from '../lib/supabase.js';
import { json } from '../lib/http.js';
import { requireMember, refuseMember, NotMember } from '../lib/member.js';
import { refundOrder, refundPreview, RefundError } from '../lib/refunds.js';

// POST /api/orders/refund { tenant, order, reason?, relist?, preview? }
//
// A store giving its buyer their money back: the item turned out to be sold
// already, or can't be delivered. Only while Vendwyze still holds the payment
// (lib/refunds.js); after that the buyer opens a dispute. Owners and managers
// only, the same people who can see payouts.
//
// With preview: true, says what the refund would do and changes nothing.

export async function handleOrders(request, env, path) {
  const rest = path.slice('/api/orders'.length) || '/';
  if (rest === '/refund' && request.method === 'POST') return refund(request, env);
  return json({ error: 'Not found' }, 404);
}

async function refund(request, env) {
  const cfg = require_(env, 'supabaseUrl', 'serviceKey');
  const body = await request.json().catch(() => ({}));
  const tenantId = body?.tenant;
  const orderId = String(body?.order ?? '');

  let member;
  try {
    member = await requireMember(request, cfg, tenantId, { roles: ['owner', 'manager'] });
  } catch (err) {
    if (err instanceof NotMember) return refuseMember(err);
    throw err;
  }
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) return json({ error: 'Bad order' }, 400);

  const order = await db(cfg).one(
    'orders',
    `id=eq.${orderId}&tenant_id=eq.${tenantId}&select=id,tenant_id,order_code,product_id,buyer_id,amount,status,escrow_status,payment_ref,paid_at`
  );
  if (!order) return json({ error: 'No such order' }, 404);

  if (body?.preview) return json(await refundPreview(cfg, order));

  try {
    const done = await refundOrder(cfg, order, {
      reason: body?.reason,
      via: 'store',
      by: member.userId,
      relist: body?.relist === true,
    });
    return json({ ok: true, refund: publicRefund(done) });
  } catch (err) {
    if (err instanceof RefundError) return json({ error: err.message }, err.status);
    throw err;
  }
}

export function publicRefund(r) {
  return {
    id: r.id,
    status: r.status,
    paid: Number(r.paid ?? r.amount),
    fee: Number(r.fee ?? 0),
    amount: Number(r.amount),
    failure_reason: r.failure_reason ?? null,
  };
}
