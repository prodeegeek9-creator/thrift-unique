import { require_ } from '../lib/env.js';
import { db } from '../lib/supabase.js';
import { sign, verify } from '../lib/sign.js';
import { byId, releaseEscrow } from '../lib/orders.js';
import { json } from '../lib/http.js';

// How escrow actually releases.
//
// The buyer has no account, so there is nobody for a policy to identify and
// the signature is the entire authorisation. It carries the order and the
// tenant, expires, and is spent once — `confirmed_at` is the single-use marker,
// so a forwarded link cannot release the same funds twice.
//
// Seven days matches the confirmation window: a link that outlives the window
// it exists for is a link that releases money nobody is still thinking about.
const TOKEN_TTL_SECONDS = 7 * 24 * 3600;

export async function mintConfirmToken(env, order) {
  const cfg = require_(env, 'tokenSecret');
  return confirmToken(cfg, order);
}

// The same, from a config already resolved: the buyer's "it arrived" link,
// sent to them when an escrow order is paid.
export async function confirmToken(cfg, order) {
  return sign(cfg.tokenSecret, { t: order.tenant_id, o: order.id }, TOKEN_TTL_SECONDS);
}

// GET /api/confirm/:token — what the page renders before the button is pressed.
//
// Deliberately narrow. A confirmation page needs the item, the amount and who
// sold it; it does not need the buyer's own phone number read back to them,
// the commission, or anything else on the row. Anyone holding the link sees
// this, and links get forwarded.
export async function getConfirmable(token, env) {
  const cfg = require_(env, 'supabaseUrl', 'serviceKey', 'tokenSecret');

  const claims = await verify(cfg.tokenSecret, token);
  if (!claims) return json({ error: 'This link has expired or is not valid.' }, 401);

  const order = await byId(cfg, claims.t, claims.o);
  if (!order) return json({ error: 'That order no longer exists.' }, 404);

  const [product, tenant] = await Promise.all([
    db(cfg).one('products', `id=eq.${order.product_id}&select=title,images,condition`),
    db(cfg).one('tenants', `id=eq.${order.tenant_id}&select=name`),
  ]);

  return json({
    order_code: order.order_code,
    amount: order.amount,
    status: order.status,
    escrow_status: order.escrow_status,
    confirm_deadline: order.confirm_deadline,
    already_confirmed: Boolean(order.confirmed_at),
    product: product ?? null,
    seller: tenant?.name ?? null,
  });
}

// POST /api/confirm/:token — the button.
//
// Releasing is idempotent underneath (releaseEscrow only matches an order
// still holding funds), so a double-tap on a slow connection cannot pay twice.
export async function confirmReceipt(token, env) {
  const cfg = require_(env, 'supabaseUrl', 'serviceKey', 'tokenSecret');

  const claims = await verify(cfg.tokenSecret, token);
  if (!claims) return json({ error: 'This link has expired or is not valid.' }, 401);

  const order = await byId(cfg, claims.t, claims.o);
  if (!order) return json({ error: 'That order no longer exists.' }, 404);

  if (order.escrow_status !== 'held') {
    // Already done, or never held in the first place. Not an error to the
    // person pressing the button — the outcome they wanted is the case.
    return json({ ok: true, already: true, status: order.status });
  }

  const { released } = await releaseEscrow(cfg, order, { reason: 'buyer_confirmed' });

  return json({ ok: true, released, status: released ? 'completed' : order.status });
}
