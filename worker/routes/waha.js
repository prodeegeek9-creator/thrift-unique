import { require_ } from '../lib/env.js';
import { db } from '../lib/supabase.js';
import { json } from '../lib/http.js';
import { timingSafeEqual } from '../lib/paystack.js';
import { requireMember, refuseMember, NotMember } from '../lib/member.js';
import { storeImage, publicUrl, MediaError } from '../lib/media.js';
import { step, listedMessage, unknownStoreMessage, formatNaira, conditionLabel } from '../lib/bot.js';
import {
  parseEvent,
  phoneFromChatId,
  sessionName,
  sendText,
  postImageStatus,
  createSession,
  getSession,
  startSession,
  deleteSession,
  getQR,
  WahaError,
} from '../lib/waha.js';

// WhatsApp, in both directions.
//
// There are two kinds of session and they do different jobs, which is the
// thing to hold on to when reading this file:
//
//   the platform session   one number, every seller. This is what the "Open
//                          WhatsApp" button deep-links to, and where the
//                          listing conversation happens. An inbound message
//                          here is resolved to a store by the sender's number
//                          against tenants.whatsapp_number.
//
//   a tenant session       the seller's own WhatsApp, linked by scanning a QR
//                          code. It exists to post to their Status — which is
//                          the Starter tier's entire distribution channel, and
//                          is impossible from a platform number, because
//                          Status goes to *their* contacts.
//
// Inbound traffic on a tenant session is deliberately ignored. That session is
// the seller's real WhatsApp with their real customers in it, and a bot
// answering their buyers on their behalf is not something to switch on by
// accident.

export async function handleWaha(request, env, path) {
  const method = request.method;
  const rest = path.slice('/api/waha'.length) || '/';

  if (rest === '/webhook' && method === 'POST') {
    return webhook(request, env);
  }

  if (rest === '/session') {
    if (method === 'GET') return sessionStatus(request, env);
    if (method === 'POST') return linkSession(request, env);
    if (method === 'DELETE') return unlinkSession(request, env);
    return json({ error: 'Method not allowed' }, 405);
  }

  return json({ error: 'Not found' }, 404);
}

// ── INBOUND ──────────────────────────────────────────────────────────────────

// POST /api/waha/webhook
//
// Answers 200 to almost everything, on purpose. WAHA retries what it believes
// failed, and a retry re-runs the conversation — so once a message has been
// recorded, every later failure is logged and swallowed rather than turned
// into a status code that asks for the whole thing again. A wrong secret is
// the one thing that gets a refusal.
async function webhook(request, env) {
  const cfg = require_(env, 'supabaseUrl', 'serviceKey');

  const body = await request.json().catch(() => null);
  const event = parseEvent(body);
  if (!event) return json({ ok: true, ignored: 'not an event we act on' });

  const authorised = await checkSecret(request, cfg, event.session);
  if (!authorised) {
    console.warn('waha webhook: bad secret for session', event.session);
    return json({ error: 'Not authorised' }, 403);
  }

  if (event.kind === 'status') return recordStatus(cfg, event);

  // The listing flow lives on the platform session only — see the note at the
  // top of this file.
  if (event.session !== cfg.wahaSession) {
    return json({ ok: true, ignored: 'tenant session' });
  }

  return message(cfg, event);
}

// Which secret applies depends on which session sent the event, so the session
// name has to be read from the body before anything is verified. That is
// unavoidable and safe: it selects a secret, it does not grant anything, and
// nothing is written before the comparison below.
async function checkSecret(request, cfg, session) {
  const presented = request.headers.get('X-Thrift-Secret') || '';
  if (!presented) return false;

  if (session && session === cfg.wahaSession) {
    return Boolean(cfg.wahaWebhookSecret) && timingSafeEqual(presented, cfg.wahaWebhookSecret);
  }

  const tenant = await db(cfg).one(
    'tenants',
    `waha_session=eq.${encodeURIComponent(session ?? '')}&select=id`
  );
  if (!tenant) return false;

  // The secret lives in its own table rather than on `tenants`, because the
  // table-level grant on `tenants` covers every column — see migration 0012.
  const row = await db(cfg).one(
    'whatsapp_secrets',
    `tenant_id=eq.${tenant.id}&select=webhook_secret`
  );
  if (!row?.webhook_secret) return false;

  return timingSafeEqual(presented, row.webhook_secret);
}

// A session changed state: starting, waiting for a scan, working, dead.
//
// Worth storing because it is the only way anyone finds out that a seller's
// WhatsApp quietly logged itself out — which shows as listings that stop
// reaching Status with no error anywhere.
async function recordStatus(cfg, event) {
  if (!event.session || !event.status) return json({ ok: true });

  await db(cfg).update(
    'tenants',
    `waha_session=eq.${encodeURIComponent(event.session)}`,
    { waha_status: event.status },
    { returning: false }
  );

  return json({ ok: true, status: event.status });
}

async function message(cfg, event) {
  const phone = phoneFromChatId(event.from);
  if (!phone) return json({ ok: true, ignored: 'no sender' });

  const tenant = await db(cfg).one(
    'tenants',
    `whatsapp_number=eq.${phone}&select=id,slug,name,status,whatsapp_number,waha_session,waha_status`
  );

  // Somebody messaged the bot from a number no store is registered to. One
  // reply pointing at sign-up, and nothing is stored — there is no tenant to
  // store it against, and bot_conversations is scoped by one.
  if (!tenant) {
    await say(cfg, null, event.from, unknownStoreMessage(cfg.publicOrigin));
    return json({ ok: true, ignored: 'unknown number' });
  }

  if (tenant.status === 'suspended') {
    await say(cfg, tenant, event.from, 'This store is suspended. Please get in touch with support.');
    return json({ ok: true, ignored: 'suspended' });
  }

  // The replay guard. WAHA retries a webhook it thinks failed, and a retried
  // "yes" that creates a second product is the kind of bug a seller notices
  // and cannot explain. The unique index on external_id is what makes the
  // second delivery a no-op; the insert returning null is how we learn it was
  // one.
  const externalId = inboundId(event);
  const logged = await db(cfg).insert(
    'bot_messages',
    {
      tenant_id: tenant.id,
      chat_id: event.from,
      external_id: externalId,
      direction: 'in',
      body: event.body ?? null,
      has_media: Boolean(event.hasMedia),
    },
    { onConflict: 'external_id' }
  );
  if (!logged) return json({ ok: true, replayed: true });

  const conversation = await db(cfg).one(
    'bot_conversations',
    `tenant_id=eq.${tenant.id}&chat_id=eq.${encodeURIComponent(event.from)}` +
      '&select=state,draft,updated_at'
  );

  const result = step(conversation, event, { tenant, origin: cfg.publicOrigin });

  // The conversation is saved before anything is sent. If sending fails, the
  // seller has to repeat themselves once; if saving failed after sending, they
  // would be answering a question the bot has already forgotten.
  await persist(cfg, tenant, event.from, conversation, result);

  for (const reply of result.replies) {
    await say(cfg, tenant, event.from, reply);
  }

  if (result.action?.type === 'create_product') {
    await listItem(cfg, tenant, event.from, result.action);
  }

  return json({ ok: true });
}

// What the product actually becomes.
//
// Everything that can fail here fails after the conversation has already been
// reset to idle, so a seller is never stuck mid-flow because a photo would not
// upload. They are told, and they can send it again.
async function listItem(cfg, tenant, chatId, action) {
  let images = [];
  try {
    images = await uploadAll(cfg, tenant.id, action.images);
  } catch (err) {
    console.error('listing media failed:', err?.message ?? err);
  }

  if (!images.length && action.images?.length) {
    await say(cfg, tenant, chatId, "I couldn't save those photos. Send the item again and I'll retry.");
    return;
  }

  let product;
  try {
    product = await db(cfg).insert('products', {
      tenant_id: tenant.id,
      title: action.product.title,
      price: action.product.price,
      condition: action.product.condition,
      allow_negotiation: action.product.allow_negotiation,
      images,
      // Live immediately. There is no approval queue — the seller pays for the
      // account and the listings are theirs; see the note on product_status in
      // the catalog migration.
      status: 'active',
      quantity_available: 1,
    });
  } catch (err) {
    console.error('listing insert failed:', err?.message ?? err);
    await say(cfg, tenant, chatId, "Something went wrong saving that. Try again in a moment.");
    return;
  }

  const posted = await postToStatus(cfg, tenant, product);
  await say(cfg, tenant, chatId, listedMessage(product, { origin: cfg.publicOrigin, posted }));
}

async function uploadAll(cfg, tenantId, images) {
  const out = [];
  for (const image of images ?? []) {
    try {
      out.push(await storeImage(cfg, tenantId, image));
    } catch (err) {
      // One bad photo out of four should not lose the other three.
      if (!(err instanceof MediaError)) throw err;
      console.warn('skipped an image:', err.message);
    }
  }
  return out;
}

// The Starter tier's distribution, and the reason tenant sessions exist at all.
//
// Returns true, false or null: posted, could not post, or nothing to post to.
// The seller is told which, because believing your listings are reaching your
// contacts when they are not is the worst way for this to fail.
async function postToStatus(cfg, tenant, product) {
  if (!tenant.waha_session || tenant.waha_status !== 'WORKING') return false;
  if (!product.images?.length) return null;
  if (!cfg.wahaUrl) return false;

  const link = cfg.publicOrigin ? `${cfg.publicOrigin}/p/${product.public_code}` : null;
  const caption = [
    product.title,
    `${formatNaira(product.price)} · ${conditionLabel(product.condition)}`,
    link,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    await postImageStatus(cfg, tenant.waha_session, {
      url: publicUrl(cfg, product.images[0]),
      caption,
    });
    return true;
  } catch (err) {
    console.error('status post failed:', err?.message ?? err);
    return false;
  }
}

async function persist(cfg, tenant, chatId, previous, result) {
  const patch = { state: result.state, draft: result.draft ?? {} };

  if (previous) {
    await db(cfg).update(
      'bot_conversations',
      `tenant_id=eq.${tenant.id}&chat_id=eq.${encodeURIComponent(chatId)}`,
      patch,
      { returning: false }
    );
    return;
  }

  await db(cfg).insert(
    'bot_conversations',
    { tenant_id: tenant.id, chat_id: chatId, ...patch },
    { onConflict: 'tenant_id,chat_id', returning: false }
  );
}

// Send, and record what was sent.
//
// The log write is best-effort on purpose: a message the seller has already
// received is not un-sent by a failed insert, and throwing here would make
// WAHA retry the whole conversation turn.
async function say(cfg, tenant, chatId, text) {
  if (!cfg.wahaUrl) {
    console.warn('waha not configured; would have sent:', text.slice(0, 80));
    return;
  }

  try {
    await sendText(cfg, cfg.wahaSession, chatId, text);
  } catch (err) {
    console.error('send failed:', err?.message ?? err);
    return;
  }

  if (!tenant) return;

  try {
    await db(cfg).insert(
      'bot_messages',
      {
        tenant_id: tenant.id,
        chat_id: chatId,
        external_id: `out:${crypto.randomUUID()}`,
        direction: 'out',
        body: text,
      },
      { returning: false }
    );
  } catch (err) {
    console.warn('outbound log failed:', err?.message ?? err);
  }
}

// A stable identity for a message, whichever engine delivered it.
//
// WEBJS and GOWS give a message id; NOWEB has been seen without one. The
// fallback is the sender plus WhatsApp's own send timestamp, which a retry
// carries unchanged — so a replay still collides, which is the entire point.
function inboundId(event) {
  if (event.id) return String(event.id);
  return `${event.from}:${event.timestamp ?? 'na'}`;
}

// ── SESSION MANAGEMENT ───────────────────────────────────────────────────────

// GET /api/waha/session?tenant=<id>
//
// What the Channels screen shows: whether this store's WhatsApp is linked,
// and, while it is waiting, the QR code to scan.
async function sessionStatus(request, env) {
  const cfg = require_(env, 'supabaseUrl', 'serviceKey');
  const tenantId = new URL(request.url).searchParams.get('tenant');

  let member;
  try {
    member = await requireMember(request, cfg, tenantId);
  } catch (err) {
    if (err instanceof NotMember) return refuseMember(err);
    throw err;
  }

  const tenant = await db(cfg).one(
    'tenants',
    `id=eq.${member.tenantId}&select=id,slug,name,waha_session,waha_status`
  );
  if (!tenant) return json({ error: 'No such store' }, 404);

  if (!tenant.waha_session || !cfg.wahaUrl) {
    return json({ linked: false, status: tenant.waha_status ?? null, qr: null });
  }

  // WAHA is the authority on session state, not our column — the column is a
  // cache fed by webhooks, and a webhook that never arrived is exactly the
  // case this screen exists to surface.
  let live = null;
  try {
    live = await getSession(cfg, tenant.waha_session);
  } catch (err) {
    console.error('waha session read failed:', err?.message ?? err);
    return json({ linked: true, status: tenant.waha_status ?? null, qr: null, unreachable: true });
  }

  const status = live?.status ?? live?.state ?? tenant.waha_status ?? null;

  // Keep the cached column honest while we are here. Cheap, and it means the
  // operator console's view is not stale for the one tenant somebody is
  // actively looking at.
  if (status && status !== tenant.waha_status) {
    await db(cfg)
      .update('tenants', `id=eq.${tenant.id}`, { waha_status: status }, { returning: false })
      .catch(() => {});
  }

  const qr =
    status === 'SCAN_QR_CODE' ? await getQR(cfg, tenant.waha_session).catch(() => null) : null;

  return json({
    linked: Boolean(live),
    status,
    qr,
    // WORKING means messages actually flow. Anything else is "not yet".
    healthy: status === 'WORKING',
  });
}

// POST /api/waha/session { tenant }
//
// Creates the session and starts it, so the next poll has a QR to show.
// Owner only: linking a WhatsApp account is the store's identity, not a
// listings task.
async function linkSession(request, env) {
  const cfg = require_(env, 'supabaseUrl', 'serviceKey', 'wahaUrl', 'publicOrigin');
  const { tenant: tenantId } = await request.json().catch(() => ({}));

  let member;
  try {
    member = await requireMember(request, cfg, tenantId, { roles: ['owner'] });
  } catch (err) {
    if (err instanceof NotMember) return refuseMember(err);
    throw err;
  }

  const tenant = await db(cfg).one(
    'tenants',
    `id=eq.${member.tenantId}&select=id,slug,name,waha_session`
  );
  if (!tenant) return json({ error: 'No such store' }, 404);

  // One secret per tenant, minted once and kept. A leaked value then costs one
  // seller's inbound traffic rather than every seller's.
  const held = await db(cfg).one(
    'whatsapp_secrets',
    `tenant_id=eq.${tenant.id}&select=webhook_secret`
  );
  const secret = held?.webhook_secret ?? crypto.randomUUID().replace(/-/g, '');
  const name = sessionName(tenant);

  try {
    const existing = await getSession(cfg, name);
    if (!existing) {
      await createSession(cfg, tenant, {
        webhookUrl: `${cfg.publicOrigin}/api/waha/webhook`,
        secret,
      });
    }
    await startSession(cfg, name).catch((err) => {
      // Starting a session that is already running is a 4xx, not a problem.
      if (!(err instanceof WahaError)) throw err;
    });
  } catch (err) {
    console.error('waha link failed:', err?.message ?? err);
    return json({ error: 'Could not reach WhatsApp. Try again shortly.' }, 502);
  }

  if (!held) {
    await db(cfg).insert(
      'whatsapp_secrets',
      { tenant_id: tenant.id, webhook_secret: secret },
      { onConflict: 'tenant_id', returning: false }
    );
  }

  await db(cfg).update(
    'tenants',
    `id=eq.${tenant.id}`,
    { waha_session: name, waha_status: 'STARTING' },
    { returning: false }
  );

  return json({ linked: true, status: 'STARTING', session: name });
}

// DELETE /api/waha/session?tenant=<id>
//
// Unlinking clears the secret as well as the session. A session that is gone
// from WAHA cannot deliver anything, and a secret left behind for a session
// nobody owns is a credential with no purpose.
async function unlinkSession(request, env) {
  const cfg = require_(env, 'supabaseUrl', 'serviceKey');
  const tenantId = new URL(request.url).searchParams.get('tenant');

  let member;
  try {
    member = await requireMember(request, cfg, tenantId, { roles: ['owner'] });
  } catch (err) {
    if (err instanceof NotMember) return refuseMember(err);
    throw err;
  }

  const tenant = await db(cfg).one(
    'tenants',
    `id=eq.${member.tenantId}&select=id,slug,waha_session`
  );
  if (!tenant?.waha_session) return json({ linked: false });

  if (cfg.wahaUrl) {
    await deleteSession(cfg, tenant.waha_session).catch((err) =>
      console.warn('waha delete failed:', err?.message ?? err)
    );
  }

  // The secret goes with the session. One left behind for a session nobody
  // owns is a credential with no purpose that would still authorise a webhook.
  await db(cfg).del('whatsapp_secrets', `tenant_id=eq.${tenant.id}`);

  await db(cfg).update(
    'tenants',
    `id=eq.${tenant.id}`,
    { waha_session: null, waha_status: null },
    { returning: false }
  );

  return json({ linked: false });
}
