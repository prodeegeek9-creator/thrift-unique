import { require_, originOf } from '../lib/env.js';
import { db } from '../lib/supabase.js';
import { json } from '../lib/http.js';
import { requireMember, refuseMember, NotMember } from '../lib/member.js';
import { parsePrice } from '../lib/bot.js';
import { approvedSellerMessage, declinedSellerMessage, paidConsignorMessage } from '../lib/intake.js';
import { postToStatus, say } from './waha.js';

// Deciding on an item somebody brought to the store.
//
// POST /api/submissions/decide { tenant, id, decision, price?, reason? }
//
// Through the Worker rather than straight to Supabase because both outcomes
// end in a WhatsApp message to the seller, from the store's own session, and
// approving also posts to the store's Status: the WAHA key those need never
// reaches the browser. Anyone on the team who can list items can decide, the
// same line the products policy draws.

const ROLES = ['owner', 'manager', 'staff'];
const MAX_REASON = 300;

export async function handleSubmissions(request, env, path) {
  const rest = path.slice('/api/submissions'.length) || '/';
  if (rest === '/decide' && request.method === 'POST') return decide(request, env);
  if (rest === '/paid' && request.method === 'POST') return markPaid(request, env);
  return json({ error: 'Not found' }, 404);
}

async function decide(request, env) {
  const cfg = require_(env, 'supabaseUrl', 'serviceKey');
  cfg.publicOrigin = originOf(request, cfg);

  const body = await request.json().catch(() => ({}));
  const tenantId = body?.tenant;
  const id = String(body?.id ?? '');
  const decision = body?.decision;

  let member;
  try {
    member = await requireMember(request, cfg, tenantId, { roles: ROLES });
  } catch (err) {
    if (err instanceof NotMember) return refuseMember(err);
    throw err;
  }

  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: 'Bad submission' }, 400);
  if (!['approve', 'decline'].includes(decision)) return json({ error: 'Bad decision' }, 400);

  const submission = await db(cfg).one(
    'submissions',
    `id=eq.${id}&tenant_id=eq.${tenantId}&select=*`
  );
  if (!submission) return json({ error: 'No such item' }, 404);
  if (submission.status !== 'pending') {
    return json({ error: 'Somebody already decided on this one.' }, 409);
  }

  const tenant = await db(cfg).one(
    'tenants',
    `id=eq.${tenantId}&select=id,slug,name,status,waha_session,waha_status`
  );

  return decision === 'approve'
    ? approve(cfg, member, tenant, submission, body)
    : decline(cfg, member, tenant, submission, body);
}

// Claimed before anything else happens, by an update that only matches a
// pending row: two people pressing Approve at once make one product, and the
// second is told somebody got there first.
async function claim(cfg, member, submission, patch) {
  const rows = await db(cfg).update(
    'submissions',
    `id=eq.${submission.id}&status=eq.pending`,
    { ...patch, decided_by: member.userId, decided_at: new Date().toISOString() }
  );
  return rows.length > 0;
}

async function approve(cfg, member, tenant, submission, body) {
  // The store's price, which may be above what the seller asked; that
  // difference is the store's margin. Defaults to the asking price.
  const price = body?.price == null || body.price === '' ? Number(submission.asking_price) : parsePrice(body.price);
  if (price == null) return json({ error: 'Enter a price, e.g. 15000 or 15k.' }, 400);

  if (!(await claim(cfg, member, submission, { status: 'approved' }))) {
    return json({ error: 'Somebody already decided on this one.' }, 409);
  }

  let product;
  try {
    product = await db(cfg).insert('products', {
      tenant_id: tenant.id,
      title: submission.title,
      price,
      condition: submission.condition,
      images: submission.images ?? [],
      status: 'active',
      quantity_available: 1,
    });
  } catch (err) {
    // Put it back in the queue rather than leave it approved with nothing
    // behind it.
    console.error('submission product insert failed:', err?.message ?? err);
    await db(cfg)
      .update(
        'submissions',
        `id=eq.${submission.id}`,
        { status: 'pending', decided_by: null, decided_at: null },
        { returning: false }
      )
      .catch(() => {});
    return json({ error: 'Could not create the listing. Try again.' }, 502);
  }

  await db(cfg).update(
    'submissions',
    `id=eq.${submission.id}`,
    { product_id: product.id },
    { returning: false }
  );

  // Public only once the store is: an unapproved store's links answer "not
  // found", so neither Status nor the seller gets one yet.
  const live = tenant.status === 'active';
  const posted = live ? await postToStatus(cfg, tenant, product) : null;
  const link = live && cfg.publicOrigin ? `${cfg.publicOrigin}/p/${product.public_code}` : null;

  const notified = await tellSeller(
    cfg,
    tenant,
    submission,
    approvedSellerMessage({ store: tenant.name, title: submission.title, price, link })
  );

  return json({ ok: true, status: 'approved', product_id: product.id, public_code: product.public_code, posted, notified });
}

async function decline(cfg, member, tenant, submission, body) {
  const reason = String(body?.reason ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_REASON) || null;

  if (!(await claim(cfg, member, submission, { status: 'declined', decline_reason: reason }))) {
    return json({ error: 'Somebody already decided on this one.' }, 409);
  }

  const notified = await tellSeller(
    cfg,
    tenant,
    submission,
    declinedSellerMessage({ store: tenant.name, title: submission.title, reason })
  );

  return json({ ok: true, status: 'declined', notified });
}

// From the store's own number, where the seller offered the item. A store
// whose WhatsApp has since been unlinked cannot answer, and the dashboard
// says so rather than pretending.
async function tellSeller(cfg, tenant, submission, text) {
  if (!tenant.waha_session || tenant.waha_status !== 'WORKING') return false;
  return say(cfg, tenant, submission.seller_chat_id, text, { session: tenant.waha_session });
}

// POST /api/submissions/paid { tenant, id, note? }
//
// The store has paid a consignor for an item that sold. The platform does not
// move this money: the store pays them the way it always has, and this records
// it and tells the consignor on WhatsApp. Owner and manager, because it is a
// statement about money.
async function markPaid(request, env) {
  const cfg = require_(env, 'supabaseUrl', 'serviceKey');
  const body = await request.json().catch(() => ({}));
  const tenantId = body?.tenant;
  const id = String(body?.id ?? '');

  let member;
  try {
    member = await requireMember(request, cfg, tenantId, { roles: ['owner', 'manager'] });
  } catch (err) {
    if (err instanceof NotMember) return refuseMember(err);
    throw err;
  }
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: 'Bad item' }, 400);

  const submission = await db(cfg).one('submissions', `id=eq.${id}&tenant_id=eq.${tenantId}&select=*`);
  if (!submission) return json({ error: 'No such item' }, 404);
  if (!submission.sold_at) return json({ error: "This item hasn't sold yet." }, 409);
  if (submission.consignor_paid_at) return json({ error: 'Already marked as paid.' }, 409);

  const note = String(body?.note ?? '').trim().replace(/\s+/g, ' ').slice(0, 200) || null;

  // Only an unpaid row matches, so two presses record one payment and send
  // one message.
  const rows = await db(cfg).update(
    'submissions',
    `id=eq.${id}&consignor_paid_at=is.null`,
    { consignor_paid_at: new Date().toISOString(), consignor_paid_by: member.userId, consignor_paid_note: note }
  );
  if (!rows.length) return json({ error: 'Already marked as paid.' }, 409);

  const tenant = await db(cfg).one('tenants', `id=eq.${tenantId}&select=id,name,waha_session,waha_status`);
  const notified = await tellSeller(
    cfg,
    tenant,
    submission,
    paidConsignorMessage({
      store: tenant.name,
      title: submission.title,
      amount: submission.owed_amount ?? submission.asking_price,
      note,
    })
  );

  return json({ ok: true, notified });
}
