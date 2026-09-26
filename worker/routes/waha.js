import { require_, originOf } from '../lib/env.js';
import { db } from '../lib/supabase.js';
import { json } from '../lib/http.js';
import { timingSafeEqual } from '../lib/paystack.js';
import { requireMember, refuseMember, NotMember } from '../lib/member.js';
import { storeImage, publicUrl, MediaError } from '../lib/media.js';
import {
  step,
  listedMessage,
  formatNaira,
  conditionLabel,
  signupStep,
  submittedMessage,
  savedMessage,
  paymentLinkMessage,
} from '../lib/bot.js';
import { makePaymentLink } from '../lib/paylinks.js';
import { ensureInvoice, pausedMessage } from '../lib/billing.js';
import { provisionStore } from '../lib/provision.js';
import { intakeStep, receivedMessage, newSubmissionMessage } from '../lib/intake.js';
import {
  parseEvent,
  phoneFor,
  sessionName,
  chatId,
  sendText,
  startTyping,
  typingDelay,
  postImageStatus,
  createSession,
  getSession,
  startSession,
  stopSession,
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
// Inbound traffic on a tenant session is left alone, with one exception. That
// session is the store's real WhatsApp with its real customers in it, and a
// bot answering them on the store's behalf is not something to switch on by
// accident. The exception is somebody who opens with SELL: a person bringing
// the store an item to sell for them, which is the intake conversation in
// lib/intake.js and nothing else.

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

  // Every link the bot sends a seller is built from this. Falls back to the
  // host this request arrived on, so a deployment that has not pinned a
  // canonical origin still sends working links rather than silently sending
  // none. config() hands back a fresh object per call, so this is local.
  cfg.publicOrigin = originOf(request, cfg);

  const body = await request.json().catch(() => null);
  const event = parseEvent(body);
  if (!event) return json({ ok: true, ignored: 'not an event we act on' });

  const authorised = await checkSecret(request, cfg, event.session);
  if (!authorised) {
    console.warn('waha webhook: bad secret for session', event.session);
    return json({ error: 'Not authorised' }, 403);
  }

  await touchActivity(cfg, event);

  if (event.kind === 'status') return recordStatus(cfg, event);

  // The listing flow lives on the platform session only — see the note at the
  // top of this file. A store's own session runs the item intake, if asked.
  if (event.session !== cfg.wahaSession) {
    return intake(cfg, event);
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

// That WhatsApp reached us, for the operator console's health check. See
// migration 0020. Best-effort: a missed heartbeat is not worth a retry.
async function touchActivity(cfg, event) {
  if (!event.session) return;
  const now = new Date().toISOString();
  try {
    await db(cfg).insert(
      'webhook_activity',
      {
        session: event.session,
        last_event_at: now,
        ...(event.kind === 'message' ? { last_message_at: now } : {}),
        ...(event.kind === 'status' && event.status ? { last_status: event.status } : {}),
      },
      { onConflict: 'session', merge: true, returning: false }
    );
  } catch (err) {
    console.warn('webhook activity not recorded:', err?.message ?? err);
  }
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
  // Replies still go to event.from as delivered; only the store lookup needs
  // the number. An unresolvable privacy id is ignored rather than told "no
  // store for this number", which could be untrue for a real seller.
  const phone = await phoneFor(cfg, event.session, event.from);
  if (!phone) {
    console.warn('waha webhook: no phone number for sender', event.from);
    return json({ ok: true, ignored: 'no sender' });
  }

  const tenant = await db(cfg).one(
    'tenants',
    `whatsapp_number=eq.${phone}&select=id,slug,name,tier,status,store_type,whatsapp_number,waha_session,waha_status,billing_status,paid_until,plan_price,auto_renew`
  );

  // A number no store is registered to: the sign-up conversation.
  if (!tenant) return signup(cfg, event, phone);

  if (tenant.status === 'suspended') {
    await say(cfg, tenant, event.from, 'This store is suspended. Please get in touch with support.');
    return json({ ok: true, ignored: 'suspended' });
  }

  // Paused for an unpaid plan fee: every message gets the way back.
  if (tenant.status === 'active' && tenant.billing_status === 'paused') {
    const invoice = await ensureInvoice(cfg, tenant, { force: true }).catch(() => null);
    await say(cfg, tenant, event.from, pausedMessage(cfg, tenant, invoice));
    return json({ ok: true, ignored: 'paused' });
  }

  // Signed up and not yet approved is no reason to stop listing: the store
  // builds its catalogue while it waits, and it all goes public on approval.
  // See listItem().

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

  // How many items wait for review, for the menu. Only between listings,
  // where the menu can appear.
  let pendingItems = null;
  if (!conversation || conversation.state === 'idle') {
    const waiting = await db(cfg)
      .select('submissions', `tenant_id=eq.${tenant.id}&status=eq.pending&select=id&limit=100`)
      .catch(() => null);
    pendingItems = Array.isArray(waiting) ? waiting.length : null;
  }

  const result = step(conversation, event, { tenant, origin: cfg.publicOrigin, pendingItems });

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

  if (result.action?.type === 'payment_link') {
    await sendPaymentLink(cfg, tenant, event.from, result.action);
  }

  return json({ ok: true });
}

// "LINK JBU4PE 30k" from a store owner: a checkout link for one of their
// items, at the agreed price or the listed one.
async function sendPaymentLink(cfg, tenant, chat, { code, price }) {
  if (!cfg.tokenSecret || !cfg.paystackKey) {
    await say(cfg, tenant, chat, "Online payment isn't set up yet, so I can't make payment links. We'll let you know when it is.");
    return;
  }
  if (tenant.status !== 'active') {
    await say(cfg, tenant, chat, 'Payment links open once your store is approved.');
    return;
  }
  const product = await db(cfg).one(
    'products',
    `tenant_id=eq.${tenant.id}&public_code=eq.${encodeURIComponent(code)}&select=id,title,price,status`
  );
  if (!product) {
    await say(cfg, tenant, chat, `I can't find an item with the code *${code}* in your store. The code is under each listing, and at the end of its link.`);
    return;
  }
  if (product.status !== 'active') {
    await say(cfg, tenant, chat, `*${product.title}* isn't for sale any more (${product.status}).`);
    return;
  }
  const amount = price ?? Number(product.price);
  const url = await makePaymentLink(cfg, product, amount);
  await say(cfg, tenant, chat, paymentLinkMessage({ title: product.title, price: amount, url }));
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

  // Before approval the product and store pages answer "not found" (both
  // RPCs want a live store), so there is nothing to link to or post yet.
  if (tenant.status === 'onboarding') {
    await say(cfg, tenant, chatId, savedMessage(product));
    return;
  }

  const posted = await postToStatus(cfg, tenant, product);
  await say(cfg, tenant, chatId, listedMessage(product, { origin: cfg.publicOrigin, posted }));
}

export async function uploadAll(cfg, tenantId, images) {
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
// contacts when they are not is the worst way for this to fail. The outcome is
// also recorded against the listing, which is what lights (or reddens) the
// WhatsApp icon on its dashboard card.
export async function postToStatus(cfg, tenant, product) {
  if (!product.images?.length) return null;
  if (!tenant.waha_session || tenant.waha_status !== 'WORKING' || !cfg.wahaUrl) {
    await recordPost(cfg, tenant, product, false, 'WhatsApp is not linked');
    return false;
  }

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
  } catch (err) {
    console.error('status post failed:', err?.message ?? err);
    await recordPost(cfg, tenant, product, false, String(err?.message ?? 'failed').slice(0, 200));
    return false;
  }

  await recordPost(cfg, tenant, product, true, null);
  return true;
}

// One row per listing and channel (the table's unique key), updated in place
// when a listing is posted again. Best-effort: a post that went out is not
// undone by a failed write here.
async function recordPost(cfg, tenant, product, posted, error) {
  if (!product.id) return;
  const row = {
    status: posted ? 'posted' : 'failed',
    error,
    ...(posted ? { posted_at: new Date().toISOString() } : {}),
  };
  try {
    const hit = await db(cfg).update(
      'listing_channel_posts',
      `product_id=eq.${product.id}&channel=eq.whatsapp`,
      row
    );
    if (!hit.length) {
      await db(cfg).insert(
        'listing_channel_posts',
        { tenant_id: tenant.id, product_id: product.id, channel: 'whatsapp', ...row },
        { onConflict: 'product_id,channel', returning: false }
      );
    }
  } catch (err) {
    console.warn('channel post record failed:', err?.message ?? err);
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

// Send, and record what was sent. True if WhatsApp took it.
//
// From the platform number unless a session is given — the intake answers
// from the store's own.
//
// The log write is best-effort on purpose: a message the seller has already
// received is not un-sent by a failed insert, and throwing here would make
// WAHA retry the whole conversation turn.
export async function say(cfg, tenant, chatId, text, { session = cfg.wahaSession } = {}) {
  if (!cfg.wahaUrl) {
    console.warn('waha not configured; would have sent:', text.slice(0, 80));
    return false;
  }

  const pause = typingDelay(cfg, text);
  if (pause > 0) {
    // Cosmetic, so a refusal costs nothing but the effect.
    await startTyping(cfg, session, chatId).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, pause));
  }

  try {
    await sendText(cfg, session, chatId, text);
  } catch (err) {
    console.error('send failed:', err?.message ?? err);
    return false;
  }

  if (!tenant) return true;

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
  return true;
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

// ── ITEMS BROUGHT TO A STORE ─────────────────────────────────────────────────

// A message on a store's own session. See lib/intake.js for the conversation.
//
// Nothing is written for a message the intake does not claim: that is a
// customer talking to the store, and not ours to log.
async function intake(cfg, event) {
  const tenant = await db(cfg).one(
    'tenants',
    `waha_session=eq.${encodeURIComponent(event.session)}` +
      '&select=id,slug,name,status,store_type,whatsapp_number,waha_session,waha_status,billing_status'
  );
  if (!tenant || tenant.status === 'suspended' || tenant.store_type === 'brand' || tenant.billing_status === 'paused') {
    return json({ ok: true, ignored: 'tenant session' });
  }

  const conversation = await db(cfg).one(
    'bot_conversations',
    `tenant_id=eq.${tenant.id}&chat_id=eq.${encodeURIComponent(event.from)}` +
      '&select=state,draft,updated_at'
  );

  const previous = await db(cfg).one(
    'submissions',
    `tenant_id=eq.${tenant.id}&seller_chat_id=eq.${encodeURIComponent(event.from)}` +
      '&seller_name=not.is.null&select=seller_name&order=created_at.desc'
  );

  const result = intakeStep(conversation, event, {
    store: tenant.name,
    knownName: previous?.seller_name ?? null,
  });
  if (!result) return json({ ok: true, ignored: 'not an item for sale' });

  // The same replay guard as the listing flow, now that this is ours.
  const logged = await db(cfg).insert(
    'bot_messages',
    {
      tenant_id: tenant.id,
      chat_id: event.from,
      external_id: inboundId(event),
      direction: 'in',
      body: event.body ?? null,
      has_media: Boolean(event.hasMedia),
    },
    { onConflict: 'external_id' }
  );
  if (!logged) return json({ ok: true, replayed: true });

  await persist(cfg, tenant, event.from, conversation, result);

  const own = { session: tenant.waha_session };
  for (const reply of result.replies) await say(cfg, tenant, event.from, reply, own);

  if (result.action?.type === 'submit') {
    await fileSubmission(cfg, tenant, event, result.action);
  }

  return json({ ok: true, intake: result.state });
}

async function fileSubmission(cfg, tenant, event, action) {
  const own = { session: tenant.waha_session };

  let images = [];
  try {
    images = await uploadAll(cfg, tenant.id, action.images);
  } catch (err) {
    console.error('submission media failed:', err?.message ?? err);
  }
  if (!images.length) {
    await say(cfg, tenant, event.from, "I couldn't save those photos. Send *SELL* to try again.", own);
    return;
  }

  // The number behind the chat, when WhatsApp will say. Only for the store to
  // call back on; the chat id is what replies go to.
  const phone = await phoneFor(cfg, event.session, event.from).catch(() => null);

  try {
    await db(cfg).insert(
      'submissions',
      {
        tenant_id: tenant.id,
        seller_chat_id: event.from,
        seller_phone: phone,
        ...action.submission,
        images,
      },
      { returning: false }
    );
  } catch (err) {
    console.error('submission insert failed:', err?.message ?? err);
    await say(cfg, tenant, event.from, 'Something went wrong sending that. Send *SELL* to try again.', own);
    return;
  }

  await say(cfg, tenant, event.from, receivedMessage(tenant.name), own);

  // And the owner, on the platform number where they already talk to us.
  const owner = chatId(tenant.whatsapp_number);
  if (owner) {
    await say(
      cfg,
      tenant,
      owner,
      newSubmissionMessage({
        title: action.submission.title,
        price: action.submission.asking_price,
        name: action.submission.seller_name,
        origin: cfg.publicOrigin,
      })
    );
  }
}

// ── OPENING A STORE ──────────────────────────────────────────────────────────

// The sign-up conversation for a number with no store; see signupStep() in
// lib/bot.js for what is asked. Stored in `signups`, since there is no tenant
// yet to scope a bot_conversations row by.
async function signup(cfg, event, phone) {
  const messageId = inboundId(event);
  const current = await db(cfg).one(
    'signups',
    `phone=eq.${phone}&select=phone,state,business_name,store_type,category,tier,email,last_message_id,updated_at`
  );

  // The same replay guard as a listing, by hand: WAHA retries what it thinks
  // failed, and an answer applied twice skips a question.
  if (current?.last_message_id === messageId) {
    return json({ ok: true, replayed: true });
  }

  const result = signupStep(current, event);

  if (result.state === null) {
    await db(cfg).del('signups', `phone=eq.${phone}`);
  } else {
    const row = {
      chat_id: event.from,
      state: result.state,
      last_message_id: messageId,
      ...result.patch,
    };
    if (current) {
      await db(cfg).update('signups', `phone=eq.${phone}`, row, { returning: false });
    } else {
      await db(cfg).insert('signups', { phone, ...row }, { onConflict: 'phone', returning: false });
    }
  }

  for (const reply of result.replies) await say(cfg, null, event.from, reply);

  if (result.action?.type === 'provision') {
    try {
      const { name, storeType, category, tier } = result.action;
      const tenant = await provisionStore(cfg, { phone, name, storeType, category, tier });
      await say(cfg, null, event.from, submittedMessage(tenant.name));
    } catch (err) {
      // Put the conversation back one step, so the seller's next YES is read
      // as accepting the terms again rather than as a new business name.
      console.error('provisioning failed:', err?.message ?? err);
      await db(cfg)
        .update('signups', `phone=eq.${phone}`, { state: 'terms' }, { returning: false })
        .catch(() => {});
      await say(
        cfg,
        null,
        event.from,
        'Sorry, something went wrong setting that up. Reply *YES* again in a minute.'
      );
    }
  }

  return json({ ok: true, signup: result.state ?? 'cancelled' });
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
  const cfg = require_(env, 'supabaseUrl', 'serviceKey', 'wahaUrl');

  // WAHA has to be able to reach this to deliver anything, so it is the one
  // place the origin genuinely has to be right. Pinning PUBLIC_ORIGIN is
  // preferred; the owner's own dashboard host is the correct fallback, since
  // that is by definition an origin that serves this Worker.
  cfg.publicOrigin = originOf(request, cfg);
  if (!cfg.publicOrigin) {
    return json({ error: 'Server is not configured' }, 503);
  }

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
    } else if (['FAILED', 'STOPPED'].includes(existing.status)) {
      // WAHA refuses to start a session that failed (an expired QR, or a
      // phone that unlinked it) until it has been stopped, so "Link again"
      // would otherwise show the same dead session forever.
      await stopSession(cfg, name).catch((err) => {
        if (!(err instanceof WahaError)) throw err;
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
