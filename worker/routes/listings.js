import { require_, originOf } from '../lib/env.js';
import { db } from '../lib/supabase.js';
import { json } from '../lib/http.js';
import { requireMember, refuseMember, NotMember } from '../lib/member.js';
import { postToStatus } from './waha.js';
import { makePaymentLink } from '../lib/paylinks.js';
import { parsePrice } from '../lib/bot.js';

// Listing actions that need the Worker.
//
// POST /api/listings/status { tenant, id }
// POST /api/listings/payment-link { tenant, id, price? }
//
// Posting a listing to the store's WhatsApp Status, for items added from the
// dashboard (the bot does it by itself for items listed over WhatsApp), or to
// post one again. Through the Worker because it uses the store's WAHA session,
// whose key the browser never holds. Anybody who can list can post.

const ROLES = ['owner', 'manager', 'staff'];

export async function handleListings(request, env, path) {
  const rest = path.slice('/api/listings'.length) || '/';
  if (rest === '/status' && request.method === 'POST') return postStatus(request, env);
  if (rest === '/payment-link' && request.method === 'POST') return paymentLink(request, env);
  return json({ error: 'Not found' }, 404);
}

async function postStatus(request, env) {
  const cfg = require_(env, 'supabaseUrl', 'serviceKey');
  cfg.publicOrigin = originOf(request, cfg);

  const body = await request.json().catch(() => ({}));
  const tenantId = body?.tenant;
  const id = String(body?.id ?? '');

  try {
    await requireMember(request, cfg, tenantId, { roles: ROLES });
  } catch (err) {
    if (err instanceof NotMember) return refuseMember(err);
    throw err;
  }
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: 'Bad listing' }, 400);

  const [tenant, product] = await Promise.all([
    db(cfg).one('tenants', `id=eq.${tenantId}&select=id,slug,name,status,waha_session,waha_status`),
    db(cfg).one(
      'products',
      `id=eq.${id}&tenant_id=eq.${tenantId}&select=id,public_code,title,price,condition,images,status`
    ),
  ]);
  if (!product) return json({ error: 'No such listing' }, 404);

  // Each refusal says what to do about it, because the button is the only
  // place the seller will find out.
  if (product.status !== 'active') return json({ error: 'Only live listings can be posted.' }, 409);
  if (tenant.status !== 'active') {
    return json({ error: 'Your store is waiting for approval. Posting opens once it is live.' }, 409);
  }
  if (!tenant.waha_session || tenant.waha_status !== 'WORKING') {
    return json({ error: 'Link your WhatsApp in Channels first.' }, 409);
  }
  if (!product.images?.length) return json({ error: 'Add a photo first. Status posts need one.' }, 409);

  const posted = await postToStatus(cfg, tenant, product);
  if (!posted) return json({ error: "WhatsApp didn't accept that post. Try again in a minute." }, 502);
  return json({ ok: true, posted: true });
}

// A link a store sends a buyer in chat, at a price they agreed there (or the
// listed price), which opens a checkout for exactly that. Anybody who can list
// can make one.
async function paymentLink(request, env) {
  const cfg = require_(env, 'supabaseUrl', 'serviceKey');
  cfg.publicOrigin = originOf(request, cfg);
  if (!cfg.tokenSecret || !cfg.paystackKey) {
    return json({ error: "Online payment isn't set up yet." }, 503);
  }

  const body = await request.json().catch(() => ({}));
  const tenantId = body?.tenant;
  const id = String(body?.id ?? '');

  try {
    await requireMember(request, cfg, tenantId, { roles: ROLES });
  } catch (err) {
    if (err instanceof NotMember) return refuseMember(err);
    throw err;
  }
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: 'Bad listing' }, 400);

  const [tenant, product] = await Promise.all([
    db(cfg).one('tenants', `id=eq.${tenantId}&select=id,status`),
    db(cfg).one('products', `id=eq.${id}&tenant_id=eq.${tenantId}&select=id,public_code,price,status`),
  ]);
  if (!product) return json({ error: 'No such listing' }, 404);
  if (product.status !== 'active') return json({ error: 'Only live listings can be paid for.' }, 409);
  if (tenant?.status !== 'active') {
    return json({ error: 'Your store is waiting for approval. Payments open once it is live.' }, 409);
  }

  const price =
    body?.price == null || body.price === '' ? Number(product.price) : parsePrice(String(body.price));
  if (price == null) return json({ error: 'Enter a price, e.g. 30000 or 30k.' }, 400);

  const url = await makePaymentLink(cfg, product, price);
  return json({ ok: true, url, price });
}
