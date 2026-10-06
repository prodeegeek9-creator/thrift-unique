import { require_, originOf, config } from '../lib/env.js';
import { COLUMNS } from '../lib/columns.js';
import { db } from '../lib/supabase.js';
import { json } from '../lib/http.js';
import { timingSafeEqual } from '../lib/paystack.js';
import { requireMember, refuseMember, NotMember } from '../lib/member.js';
import { storeImage, publicUrl, mediaRequest, MediaError } from '../lib/media.js';
import {
  step,
  listedMessage,
  formatNaira,
  conditionLabel,
  signupStep,
  webCodeIn,
  submittedMessage,
  savedMessage,
  paymentLinkMessage,
  passwordLinkMessage,
  shareCaption,
  shareKitIntro,
} from '../lib/bot.js';
import { makePaymentLink } from '../lib/paylinks.js';
import { generateInvite } from '../lib/accounts.js';
import { ensureInvoice, pausedMessage } from '../lib/billing.js';
import { provisionStore } from '../lib/provision.js';
import { accountForCode } from './signup.js';
import { intakeStep, receivedMessage, newSubmissionMessage, INTAKE_STATES, SELL } from '../lib/intake.js';
import { photoIntakeStep, photoStatusMessage, PHOTO_STATES } from '../lib/photoIntake.js';
import { cartStep, codesIn, isBuy, BARE_BUY, paymentLinkMessage as cartPayMessage, ASK_PHONE } from '../lib/cart.js';
import { createCartCheckout, abandonCart, cartLost, busyLine } from '../lib/cartCheckout.js';
import { reservedMinutes } from '../lib/reservations.js';
import {
  BANK,
  INTAKE_BUSY,
  SAY as BANK_SAY,
  VERIFY_AFTER_HOURS,
  VERIFY_EXPIRES_HOURS,
  accountFor,
  bankTurn,
  firstAsk,
  wantsBank,
  ownerChangeMessage,
  ownerNotYouMessage,
} from '../lib/consignorBank.js';
import {
  parseEvent,
  phoneFor,
  phoneFromChatId,
  sessionName,
  chatId,
  sendText,
  startTyping,
  typingDelay,
  postImageStatus,
  sendImage,
  createSession,
  getSession,
  startSession,
  stopSession,
  deleteSession,
  getQR,
  WahaError,
  ensureStoreWebhook,
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

  if (rest === '/holds' && method === 'GET') return listHolds(request, env);
  if (rest === '/holds/resume' && method === 'POST') return resumeHolds(request, env);

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
  // top of this file. A store's own session runs the item intake and the
  // WhatsApp checkout, when asked.
  if (event.session !== cfg.wahaSession) {
    return storeSession(cfg, event);
  }
  if (event.kind === 'outgoing') return json({ ok: true, ignored: 'our own message' });

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

  if (result.action?.type === 'password_link') {
    await sendPasswordLink(cfg, tenant, event.from);
  }

  if (result.action?.type === 'share_kit') {
    await sendShareKit(cfg, tenant, event.from, result.action);
  }

  return json({ ok: true });
}

// SHARE, or SHARE <code>: the item's photos and a caption, for the owner to
// post on Instagram, TikTok or Facebook themselves. Without a code, the item
// listed most recently. The caption goes on its own, last, so it is one
// press-and-hold to copy.
const SHARE_PHOTOS = 4;

async function sendShareKit(cfg, tenant, chat, { code }) {
  const product = await db(cfg).one(
    'products',
    `tenant_id=eq.${tenant.id}&status=eq.active` +
      (code ? `&public_code=eq.${encodeURIComponent(code)}` : '') +
      '&select=id,public_code,title,description,price,condition,images&order=created_at.desc'
  );
  if (!product) {
    await say(
      cfg,
      tenant,
      chat,
      code
        ? `I can't find an item for sale with the code *${code}*. The code is at the end of the item's link.`
        : "You don't have anything for sale yet. Send a photo to list your first item."
    );
    return;
  }
  if (tenant.status !== 'active') {
    await say(cfg, tenant, chat, 'Your items get their own links once your store is approved. SHARE works from then on.');
    return;
  }

  await say(cfg, tenant, chat, shareKitIntro(product));
  let sent = 0;
  for (const path of (product.images ?? []).slice(0, SHARE_PHOTOS)) {
    try {
      await sendImage(cfg, cfg.wahaSession, chat, { url: publicUrl(cfg, path) });
      sent += 1;
    } catch (err) {
      console.warn('share kit photo failed:', err?.message ?? err);
    }
  }
  // Photos that wouldn't send are still one tap away on the item's page.
  if (!sent && product.images?.length) {
    await say(cfg, tenant, chat, `The photos are on the item's page: ${cfg.publicOrigin ?? ''}/p/${product.public_code}`);
  }
  await say(cfg, tenant, chat, shareCaption(product, { origin: cfg.publicOrigin }));
}

// PASSWORD from a store owner: a new set-password link for the store's owner
// account, sent back to the store's own number. The number is the store's
// identity on this channel; the link goes nowhere else.
async function sendPasswordLink(cfg, tenant, chat) {
  const owner = await db(cfg).one(
    'tenant_members',
    `tenant_id=eq.${tenant.id}&role=eq.owner&select=email&order=invited_at.asc.nullslast`
  );
  if (!owner?.email) {
    await say(cfg, tenant, chat, 'Your dashboard account is created when your store is approved. We will send you the link then.');
    return;
  }
  let link = null;
  try {
    ({ link } = await generateInvite(cfg, owner.email, { type: 'recovery', origin: cfg.publicOrigin ?? null, landing: '/welcome' }));
  } catch (err) {
    console.error('password link failed:', err?.message ?? err);
  }
  await say(
    cfg,
    tenant,
    chat,
    link ? passwordLinkMessage({ link, email: owner.email }) : "I couldn't make a link just now. Please try again in a few minutes."
  );
}

// "LINK JBU4PE 30k 08031234567" from a store owner: a checkout link for one
// of their items, at the agreed price or the listed one, for that buyer.
async function sendPaymentLink(cfg, tenant, chat, { code, price, phone }) {
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
  const url = await makePaymentLink(cfg, product, amount, { phone });
  await say(cfg, tenant, chat, paymentLinkMessage({ title: product.title, price: amount, url, phone }));
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
  // No payout account yet: reminded with every listing (only once payments
  // are on, since there's nothing to pay out before that).
  const needsBank = Boolean(cfg.paystackKey) &&
    !(await db(cfg).one('payout_accounts', `tenant_id=eq.${tenant.id}&select=tenant_id`).catch(() => true));
  await say(cfg, tenant, chatId, listedMessage(product, { origin: cfg.publicOrigin, posted, needsBank }));
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
  // With checkout inside WhatsApp, the post says how to buy it: a reply with
  // this line quoted is how the bot knows which item (lib/cart.js).
  const buy = product.public_code && (await checkoutOn(cfg, tenant)) ? `Reply BUY ${product.public_code} to order` : null;
  const caption = [
    product.title,
    `${formatNaira(product.price)} · ${conditionLabel(product.condition)}`,
    buy,
    link,
  ]
    .filter(Boolean)
    .join('\n');

  let messageId;
  try {
    messageId = await postImageStatus(cfg, tenant.waha_session, {
      url: publicUrl(cfg, product.images[0]),
      caption,
    });
  } catch (err) {
    console.error('status post failed:', err?.message ?? err);
    await recordPost(cfg, tenant, product, false, String(err?.message ?? 'failed').slice(0, 200));
    return false;
  }

  await recordPost(cfg, tenant, product, true, null);
  await rememberStatus(cfg, tenant, product, messageId);
  return true;
}

// Which item a Status post was, by its WhatsApp ID, so a reply to it names the
// item even without the caption (lib/cart.js). Every post is kept, not just
// the latest: a buyer can reply to yesterday's. Best-effort, like recordPost.
async function rememberStatus(cfg, tenant, product, messageId) {
  if (!messageId || !product.id) return;
  try {
    await db(cfg).insert(
      'status_posts',
      { tenant_id: tenant.id, product_id: product.id, message_id: messageId },
      { onConflict: 'tenant_id,message_id', returning: false }
    );
  } catch (err) {
    console.warn('status post not remembered:', err?.message ?? err);
  }
}

// The item a reply is about, from the saved post it quotes.
async function productForPost(cfg, tenant, messageId) {
  if (!messageId) return null;
  const post = await db(cfg).one(
    'status_posts',
    `tenant_id=eq.${tenant.id}&message_id=eq.${encodeURIComponent(messageId)}&select=product_id`
  );
  if (!post) return null;
  return db(cfg).one('products', `id=eq.${post.product_id}&tenant_id=eq.${tenant.id}&select=id,public_code,title,price,status,held_by_ref,held_until`);
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
export async function say(cfg, tenant, chatId, text, { session = cfg.wahaSession, replyTo } = {}) {
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

  // Logged before it is sent, not after. On a store's own number WhatsApp
  // echoes every sent message back as the store's, and this log is how the
  // bot's own are told apart from the owner typing (ownerTyped()); logging
  // after the send raced that echo.
  if (tenant) {
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

  try {
    await sendText(cfg, session, chatId, text, { replyTo });
  } catch (err) {
    console.error('send failed:', err?.message ?? err);
    return false;
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
// A message on a store's own number: the owner stepping into a chat, the
// item intake (thrift stores, SELL), or the WhatsApp checkout (Growth and
// Business, BUY). Everything else is a customer talking to the store and is
// left alone, unlogged.
async function storeSession(cfg, event) {
  const tenant = await db(cfg).one(
    'tenants',
    `waha_session=eq.${encodeURIComponent(event.session)}` +
      '&select=id,slug,name,tier,status,store_type,whatsapp_number,waha_session,waha_status,billing_status'
  );
  if (!tenant || tenant.status === 'suspended' || tenant.billing_status === 'paused') {
    return json({ ok: true, ignored: 'tenant session' });
  }

  if (event.kind === 'outgoing') return ownerTyped(cfg, tenant, event);

  const conversation = await db(cfg).one(
    'bot_conversations',
    `tenant_id=eq.${tenant.id}&chat_id=eq.${encodeURIComponent(event.from)}` +
      '&select=state,draft,updated_at,paused_until'
  );

  // The owner is answering this chat themselves: the bot keeps out of it,
  // unless it is asked for by name. SELL or BUY <code> is somebody wanting the
  // bot (often because the owner just told them to send it), so that lifts
  // the pause.
  const body = String(event.body ?? '');
  const asked =
    SELL.test(body) ||
    isBuy(event.body) ||
    (tenant.store_type !== 'brand' && BANK.test(body)) ||
    // Confirming a payout account change: the bot asked, and this answers it.
    (conversation?.state === 'bank_verify' && /^\s*(yes|no|y|n)\b/i.test(body));
  // A photo the bot asked for still gets checked while the owner is in the
  // chat — dropping it silently would leave the item waiting on a shot the
  // seller already sent. It does not lift the pause: the owner is still
  // answering everything else.
  const askedForPhoto = conversation?.state === 'pi_photos' && Boolean(event.hasMedia);
  if (conversation?.paused_until && new Date(conversation.paused_until) > new Date()) {
    if (!asked && !askedForPhoto) return json({ ok: true, ignored: 'owner is handling this chat' });
    if (asked) {
      await db(cfg).update(
        'bot_conversations',
        `tenant_id=eq.${tenant.id}&chat_id=eq.${encodeURIComponent(event.from)}`,
        { paused_until: null }
      );
    }
  }

  // Where a consignor is paid (lib/consignorBank.js). SELL always starts an
  // item, even halfway through giving bank details.
  if (tenant.store_type !== 'brand' && !SELL.test(body) && wantsBank(conversation, body)) {
    return bankChat(cfg, event, tenant, conversation);
  }

  // Two intakes while stores are moved across: lib/photoIntake.js where the
  // store has photo_review switched on, lib/intake.js everywhere else. A
  // conversation already under way finishes in the flow it started in,
  // whichever way the switch has since been flipped.
  if (tenant.store_type !== 'brand') {
    if (PHOTO_STATES.includes(conversation?.state)) return photoIntake(cfg, event, tenant, conversation);
    if (INTAKE_STATES.includes(conversation?.state)) return intake(cfg, event, tenant, conversation);
    if (SELL.test(body)) {
      return (await photoReviewOn(cfg, tenant))
        ? photoIntake(cfg, event, tenant, conversation)
        : intake(cfg, event, tenant, conversation);
    }
  }

  if (await checkoutOn(cfg, tenant)) {
    const handled = await checkout(cfg, event, tenant, conversation);
    if (handled) return handled;
  }

  return json({ ok: true, ignored: 'not for the bot' });
}

async function checkoutOn(cfg, tenant) {
  if (!cfg.paystackKey) return false;
  const row = await db(cfg).one(
    'tenant_features',
    `tenant_id=eq.${tenant.id}&flag=eq.whatsapp_checkout&select=enabled`
  );
  return Boolean(row?.enabled);
}

// The store sent a message. If it isn't one the bot just sent (logged before
// sending, see say()), the owner has stepped into this chat, and the bot stays
// out of it for OWNER_PAUSE_HOURS.
const OWNER_PAUSE_HOURS = 12;

async function ownerTyped(cfg, tenant, event) {
  if (event.source === 'api') return json({ ok: true, ignored: 'our own message' });
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  const ours = await db(cfg).one(
    'bot_messages',
    `tenant_id=eq.${tenant.id}&chat_id=eq.${encodeURIComponent(event.to)}&direction=eq.out` +
      `&body=eq.${encodeURIComponent(event.body ?? '')}&created_at=gte.${since}&select=id`
  );
  if (ours) return json({ ok: true, ignored: 'our own message' });

  const until = new Date(Date.now() + OWNER_PAUSE_HOURS * 3_600_000).toISOString();
  // What the owner typed, so the dashboard can say which chat is on hold
  // (a chat id is WhatsApp's privacy id, which names nobody).
  const note = String(event.body ?? '').trim().slice(0, 120) || null;
  const hit = await db(cfg).update(
    'bot_conversations',
    `tenant_id=eq.${tenant.id}&chat_id=eq.${encodeURIComponent(event.to)}`,
    { paused_until: until, paused_note: note }
  );
  if (!hit.length) {
    await db(cfg).insert(
      'bot_conversations',
      { tenant_id: tenant.id, chat_id: event.to, state: 'idle', draft: {}, paused_until: until, paused_note: note },
      { onConflict: 'tenant_id,chat_id', returning: false }
    );
  }
  return json({ ok: true, paused: until });
}

// ── HOLDS, FROM THE DASHBOARD ────────────────────────────────────────────────

// GET /api/waha/holds?tenant=<id>
//
// The chats the bot is keeping out of because the owner typed in them, with
// enough to tell which chat is which: the number where WhatsApp will give it,
// a name the person gave the bot before, and what the owner last typed.
// Chats with the store's own number (messaging yourself, a Status post) are
// left out: nobody there is waiting on the bot.
async function listHolds(request, env) {
  const cfg = require_(env, 'supabaseUrl', 'serviceKey');
  let member;
  try {
    member = await requireMember(request, cfg, new URL(request.url).searchParams.get('tenant'));
  } catch (err) {
    if (err instanceof NotMember) return refuseMember(err);
    throw err;
  }
  const tenant = await db(cfg).one('tenants', `id=eq.${member.tenantId}&select=id,whatsapp_number,waha_session`);
  if (!tenant) return json({ error: 'No such store' }, 404);

  const rows = await db(cfg).select(
    'bot_conversations',
    `tenant_id=eq.${tenant.id}&paused_until=gt.${new Date().toISOString()}` +
      '&select=chat_id,paused_until,paused_note&order=paused_until.desc&limit=30'
  );

  const holds = [];
  for (const row of rows) {
    const phone = tenant.waha_session && cfg.wahaUrl
      ? await phoneFor(cfg, tenant.waha_session, row.chat_id).catch(() => null)
      : phoneFromChatId(row.chat_id);
    if (phone && phone === tenant.whatsapp_number) continue;
    holds.push({
      chat_id: row.chat_id,
      until: row.paused_until,
      note: row.paused_note ?? null,
      phone: phone ?? null,
      name: await nameFor(cfg, tenant.id, row.chat_id),
    });
  }
  return json({ holds });
}

async function nameFor(cfg, tenantId, chat) {
  const q = encodeURIComponent(chat);
  const cart = await db(cfg)
    .one('carts', `tenant_id=eq.${tenantId}&chat_id=eq.${q}&buyer_name=not.is.null&select=buyer_name&order=created_at.desc`)
    .catch(() => null);
  if (cart?.buyer_name) return cart.buyer_name;
  const sub = await db(cfg)
    .one('submissions', `tenant_id=eq.${tenantId}&seller_chat_id=eq.${q}&seller_name=not.is.null&select=seller_name&order=created_at.desc`)
    .catch(() => null);
  return sub?.seller_name ?? null;
}

// POST /api/waha/holds/resume { tenant, chat? }
//
// The bot answers in that chat again straight away, or in every chat when no
// chat is named. Any member can: whoever is answering the store's WhatsApp.
async function resumeHolds(request, env) {
  const cfg = require_(env, 'supabaseUrl', 'serviceKey');
  const body = await request.json().catch(() => ({}));
  let member;
  try {
    member = await requireMember(request, cfg, body?.tenant);
  } catch (err) {
    if (err instanceof NotMember) return refuseMember(err);
    throw err;
  }
  const chat = typeof body?.chat === 'string' && body.chat ? body.chat : null;
  const cleared = await db(cfg).update(
    'bot_conversations',
    `tenant_id=eq.${member.tenantId}&paused_until=not.is.null` + (chat ? `&chat_id=eq.${encodeURIComponent(chat)}` : ''),
    { paused_until: null, paused_note: null }
  );
  return json({ ok: true, resumed: cleared.length });
}

// ── CHECKOUT INSIDE WHATSAPP ─────────────────────────────────────────────────

// See lib/cart.js for the conversation and lib/cartCheckout.js for the money.
async function checkout(cfg, event, tenant, conversation) {
  const { own: typed, quoted: captioned } = codesIn(event);
  const products = {};
  // A reply to a post Vendwyze made: its saved ID names the item, and wins
  // over anything in the caption.
  const posted = await productForPost(cfg, tenant, event.quotedId);
  if (posted?.public_code) products[posted.public_code] = posted;
  const quoted = posted?.public_code ?? captioned;
  for (const code of new Set([typed, quoted].filter(Boolean))) {
    if (code in products) continue;
    products[code] = await db(cfg).one(
      'products',
      `tenant_id=eq.${tenant.id}&public_code=eq.${encodeURIComponent(code)}&select=id,public_code,title,price,status,held_by_ref,held_until`
    );
  }
  // Minutes somebody else is paying for each, if they are: not this chat's
  // own cart, whose link a new BUY replaces (lib/reservations.js).
  for (const p of Object.values(products)) {
    if (p) p.busy_minutes = p.held_by_ref && p.held_by_ref === conversation?.draft?.cart_ref ? null : reservedMinutes(p);
  }
  const known = await db(cfg).one(
    'carts',
    `tenant_id=eq.${tenant.id}&chat_id=eq.${encodeURIComponent(event.from)}&buyer_name=not.is.null&select=buyer_name&order=created_at.desc`
  );

  // A real code to show somebody who sent "buy" alone: the store's newest.
  const example = BARE_BUY.test(String(event.body ?? ''))
    ? await db(cfg)
        .one('products', `tenant_id=eq.${tenant.id}&status=eq.active&select=public_code&order=created_at.desc`)
        .catch(() => null)
    : null;

  const result = cartStep(conversation, event, {
    store: tenant.name,
    exampleCode: example?.public_code ?? null,
    storeUrl: cfg.publicOrigin && tenant.slug ? `${cfg.publicOrigin}/s/${tenant.slug}` : null,
    products,
    quotedCode: quoted,
    knownName: known?.buyer_name ?? null,
  });
  if (!result) return null;

  // The same replay guard as everywhere else, now that this is ours.
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

  const own = { session: tenant.waha_session };
  let next = result;

  if (result.action?.type === 'abandon') {
    await abandonCart(cfg, tenant.id, conversation?.draft?.cart_ref).catch(() => {});
  }

  if (result.action?.type === 'resend') {
    const url = conversation?.draft?.pay_url;
    // Only while the link still has everything in it: an item that sold, or
    // that somebody else took over once this link's hold ran out, means a new
    // link for the rest.
    const lost = url ? await cartLost(cfg, tenant.id, conversation?.draft?.cart_ref) : [];
    if (lost.length) {
      await abandonCart(cfg, tenant.id, conversation.draft.cart_ref).catch(() => {});
      const { cart_ref: _r, pay_url: _u, ...draft } = result.draft;
      next = {
        state: 'cart_confirm',
        draft,
        replies: [
          `Sorry, ${lost.join(', ')} ${lost.length === 1 ? 'is' : 'are'} no longer available on that link. Reply *PAY* for a new link for the rest.`,
        ],
        action: null,
      };
    } else {
      next = { ...result, replies: [url ? `Here's your payment link again:\n${url}` : 'Reply *PAY* to get your payment link.'] };
    }
  }

  if (result.action?.type === 'checkout') {
    const phone = result.action.phone ?? (await phoneFor(cfg, event.session, event.from).catch(() => null));
    let made;
    try {
      made = await createCartCheckout(cfg, tenant, {
        chat: event.from,
        phone,
        items: result.action.items,
        name: result.action.name,
        address: result.action.address,
      });
    } catch (err) {
      console.error('cart checkout failed:', err?.message ?? err);
      made = { error: "I couldn't make the payment link just now. Reply *PAY* to try again in a minute." };
    }
    if (made.needPhone) {
      next = { state: 'cart_phone', draft: result.draft, replies: [ASK_PHONE], action: null };
    } else if (made.error) {
      next = { state: 'cart_confirm', draft: result.draft, replies: [made.error], action: null };
    } else {
      const replies = [];
      if (made.dropped?.length) replies.push(`Sorry, ${made.dropped.join(', ')} sold in the meantime, so I've left ${made.dropped.length === 1 ? 'it' : 'them'} out.`);
      if (made.busy?.length) replies.push(busyLine(made.busy));
      replies.push(cartPayMessage({ url: made.url, total: made.total, count: made.count, escrow: made.escrow }));
      next = { state: 'cart_pay', draft: { ...result.draft, phone, cart_ref: made.ref, pay_url: made.url }, replies, action: null };
    }
  }

  await persist(cfg, tenant, event.from, conversation, next);
  for (const reply of next.replies) await say(cfg, tenant, event.from, reply, own);
  return json({ ok: true, checkout: next.state });
}

async function intake(cfg, event, tenant, conversation) {

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

  await announceSubmission(cfg, tenant, event.from, action.submission);
}

// After a submission is filed, from either intake: the seller is told, asked
// where to be paid if this is their first item, and the owner hears about it.
// Returns whether the bank question took over the conversation.
export async function announceSubmission(cfg, tenant, chat, submission) {
  const own = { session: tenant.waha_session };

  await say(cfg, tenant, chat, receivedMessage(tenant.name), own);

  // Their first item: where to pay them when it sells.
  const ask = await firstAsk(cfg, tenant, chat).catch((err) => {
    console.warn('bank ask skipped:', err?.message ?? err);
    return null;
  });
  if (ask) {
    await setConversation(cfg, tenant, chat, ask);
    for (const reply of ask.replies) await say(cfg, tenant, chat, reply, own);
  }

  // And the owner, on the platform number where they already talk to us.
  const owner = chatId(tenant.whatsapp_number);
  if (owner) {
    await say(
      cfg,
      tenant,
      owner,
      newSubmissionMessage({
        title: submission.title,
        price: submission.asking_price,
        name: submission.seller_name,
        origin: cfg.publicOrigin,
        note: submission.ai_note,
      })
    );
  }

  return Boolean(ask);
}

// ── ITEMS BROUGHT TO A STORE, WITH THE PHOTOS CHECKED ────────────────────────
//
// lib/photoIntake.js, for stores with photo_review on. The conversation
// collects the details and creates a listing_drafts row; each photo then goes
// to the photo-check service, which stores it and runs the plain-code checks;
// the photo-review worker labels the shots; and routes/photoReview.js files
// the item as a submission once every required shot has passed.

const OPEN_DRAFT = 'status=in.(awaiting_photos,ready)';

export async function photoReviewOn(cfg, tenant) {
  if (!cfg.photoCheckUrl || !cfg.photoCheckKey) return false;
  const row = await db(cfg).one(
    'tenant_features',
    `tenant_id=eq.${tenant.id}&flag=eq.photo_review&select=enabled`
  );
  return Boolean(row?.enabled);
}

const CHECK_SAY = {
  failed: "I couldn't check that photo just now. Please send it again in a minute.",
  tooLarge: "That photo is too large. Please send it as a normal photo, not as a document.",
  closed: (store) => `That item has already gone to ${store}. Send *SELL* to offer another one.`,
  ended: 'That item timed out before all the photos arrived. Send *SELL* to start again.',
  draftFailed: 'Something went wrong saving that. Send *SELL* to try again.',
  alreadyCounted: (counted, missing) =>
    `You've sent this photo already — it counts as your *${listOf(counted)}*.` +
    (missing.length ? ` Please send a separate photo for: ${missing.join(', ')}.` : ''),
  earlierItem: 'You sent this photo for an earlier item. Please take a new photo of this one.',
};

const listOf = (labels) =>
  labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}` : labels[0];

// A duplicate, told in terms of what the earlier copy already counts for —
// "it counts as your Flaw close-up, still needed: Front" says what to do next,
// where "already sent" alone left a seller resending the same photo. Null
// when there is nothing more useful to say than the service's own message.
async function duplicateMessage(cfg, draftId, photoId) {
  if (!photoId) return null;
  const matches = await db(cfg).rpc('find_similar_photos', { p_photo_id: photoId });
  const match = Array.isArray(matches) ? matches[0] : null;
  if (!match) return null;
  if (match.draft_id !== draftId) return CHECK_SAY.earlierItem;

  const [earlier, draft] = await Promise.all([
    db(cfg).one('listing_photos', `id=eq.${match.photo_id}&select=status,shot_type,also_shot_types`),
    db(cfg).one('listing_drafts', `id=eq.${draftId}&select=category,missing_shots`),
  ]);
  if (earlier?.status !== 'passed' || !earlier.shot_type || !draft) return null;

  const rules = await db(cfg).select(
    'photo_shot_rules',
    `category=eq.${encodeURIComponent(draft.category)}&select=shot_type,label`
  );
  const label = Object.fromEntries((rules ?? []).map((r) => [r.shot_type, r.label]));
  const counted = [earlier.shot_type, ...(earlier.also_shot_types ?? [])].map((s) => label[s] ?? s);
  const missing = (draft.missing_shots ?? []).map((s) => label[s] ?? s);
  return CHECK_SAY.alreadyCounted(counted, missing);
}

async function photoIntake(cfg, event, tenant, conversation) {
  const own = { session: tenant.waha_session };

  // Waiting on photos, but the draft has moved on without the chat — filed,
  // expired or cancelled. The conversation is treated as over, so only a
  // fresh SELL starts anything.
  let current = conversation;
  let ended = null;
  if (conversation?.state === 'pi_photos') {
    const open = conversation.draft?.draft_id
      ? await openDraft(cfg, tenant.id, conversation.draft.draft_id)
      : null;
    if (!open) {
      current = null;
      ended = conversation.draft?.draft_id
        ? await db(cfg).one('listing_drafts', `id=eq.${conversation.draft.draft_id}&tenant_id=eq.${tenant.id}&select=status`)
        : null;
    }
  }

  // The store's own expectations (migration 0041): the categories it takes,
  // and every shot as this store needs it, switched-off ones already gone.
  // store_shot_rules_for() is the same answer the database uses to decide
  // when an item is ready, so what the seller is asked for and what the item
  // waits on cannot disagree.
  const [previous, categories, declined, rules] = await Promise.all([
    db(cfg).one(
      'submissions',
      `tenant_id=eq.${tenant.id}&seller_chat_id=eq.${encodeURIComponent(event.from)}` +
        '&seller_name=not.is.null&select=seller_name&order=created_at.desc'
    ),
    db(cfg).select('photo_categories', 'active=eq.true&select=slug,name,default_condition,title_example&order=name.asc'),
    db(cfg).select('store_photo_categories', `tenant_id=eq.${tenant.id}&accepted=eq.false&select=category`),
    db(cfg).rpc('store_shot_rules_for', { p_tenant_id: tenant.id }),
  ]);
  const notTaken = new Set((declined ?? []).map((r) => r.category));

  const result = photoIntakeStep(current, event, {
    store: tenant.name,
    knownName: previous?.seller_name ?? null,
    categories: (categories ?? []).filter((c) => !notTaken.has(c.slug)),
    rules: rules ?? [],
  });

  if (!result) {
    // A photo for a draft that has since closed: say so once, then let go.
    if (conversation?.state === 'pi_photos' && !current) {
      await setConversation(cfg, tenant, event.from, { state: 'idle', draft: {} });
      if (event.hasMedia) {
        const text = ended?.status === 'published' ? CHECK_SAY.closed(tenant.name) : CHECK_SAY.ended;
        await say(cfg, tenant, event.from, text, own);
      }
    }
    return json({ ok: true, ignored: 'not an item for sale' });
  }

  // The same replay guard as the old intake, now that this message is ours.
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

  const action = result.action;

  if (action?.type === 'create_draft') {
    let draftId;
    try {
      draftId = await createDraft(cfg, tenant, event.from, action.item);
    } catch (err) {
      console.error('draft insert failed:', err?.message ?? err);
      await setConversation(cfg, tenant, event.from, { state: 'idle', draft: {} });
      await say(cfg, tenant, event.from, CHECK_SAY.draftFailed, own);
      return json({ ok: true, intake: 'failed' });
    }
    result.draft = { ...result.draft, draft_id: draftId };
  }

  if (action?.type === 'cancel_draft') {
    await db(cfg).update(
      'listing_drafts',
      `id=eq.${action.draftId}&tenant_id=eq.${tenant.id}&${OPEN_DRAFT}`,
      { status: 'cancelled' },
      { returning: false }
    );
  }

  await persist(cfg, tenant, event.from, conversation, result);
  for (const reply of result.replies) await say(cfg, tenant, event.from, reply, own);

  const draftId = result.draft?.draft_id;

  if (action?.type === 'create_draft') {
    for (const [i, image] of action.early.entries()) {
      await checkPhoto(cfg, tenant, event.from, draftId, image, {
        ack: false,
        messageId: image.id ?? `${draftId}:early:${i}`,
      });
    }
  }

  if (action?.type === 'check_photo') {
    await checkPhoto(cfg, tenant, event.from, draftId, action.image, {
      ack: action.ack,
      messageId: action.image.id ?? inboundId(event),
    });
  }

  if (action?.type === 'photo_status') {
    const draft = await openDraft(cfg, tenant.id, draftId);
    if (draft) {
      const labels = Object.fromEntries(
        (rules ?? []).filter((r) => r.category === draft.category).map((r) => [r.shot_type, r.label])
      );
      await say(
        cfg,
        tenant,
        event.from,
        photoStatusMessage({
          title: draft.extracted?.title ?? 'your item',
          missing: (draft.missing_shots ?? []).map((s) => labels[s] ?? s),
          store: tenant.name,
        }),
        own
      );
    }
  }

  return json({ ok: true, intake: result.state });
}

async function openDraft(cfg, tenantId, draftId) {
  if (!draftId) return null;
  return db(cfg).one(
    'listing_drafts',
    `id=eq.${draftId}&tenant_id=eq.${tenantId}&${OPEN_DRAFT}` +
      '&select=id,status,category,missing_shots,extracted'
  );
}

// One open draft per seller per store (a partial unique index). Reaching here
// means the chat has no live draft, so any open one is abandoned: it goes, and
// the new item takes its place.
async function createDraft(cfg, tenant, chat, item) {
  await db(cfg).update(
    'listing_drafts',
    `tenant_id=eq.${tenant.id}&seller_chat_id=eq.${encodeURIComponent(chat)}&${OPEN_DRAFT}`,
    { status: 'cancelled' },
    { returning: false }
  );
  const row = await db(cfg).insert('listing_drafts', {
    tenant_id: tenant.id,
    seller_chat_id: chat,
    category: item.category,
    flags: item.flags,
    // `source` is what routes/photoReview.js files as a submission. A draft
    // made any other way is left alone.
    extracted: {
      source: 'sell',
      title: item.title,
      asking_price: item.asking_price,
      condition: item.condition,
      seller_name: item.seller_name,
    },
  });
  if (!row?.id) throw new Error('listing_drafts insert returned no row');
  return row.id;
}

// One photo to the photo-check service, and its answer to the seller.
//
// The service downloads the photo from WAHA itself and only from WAHA's host,
// so the URL goes through mediaRequest(): WAHA writes its own (often
// localhost) host into media URLs, and the service needs the public one.
async function checkPhoto(cfg, tenant, chat, draftId, image, { ack, messageId }) {
  const own = { session: tenant.waha_session };
  // Anything said about this photo in particular quotes it, so a seller who
  // sent several at once can see which one it means. Only a real WhatsApp
  // id can be quoted, never the stand-ins made up when one is missing.
  const aboutIt = { ...own, replyTo: image.id ?? undefined };

  let res;
  let body;
  try {
    const mediaUrl = mediaRequest(cfg, image.url).url;
    res = await fetch(`${cfg.photoCheckUrl}/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': cfg.photoCheckKey },
      body: JSON.stringify({ tenant_id: tenant.id, draft_id: draftId, message_id: messageId, media_url: mediaUrl }),
    });
    body = await res.json().catch(() => null);
  } catch (err) {
    console.error('photo check unreachable:', err?.message ?? err);
    await say(cfg, tenant, chat, CHECK_SAY.failed, aboutIt);
    return null;
  }

  if (!res.ok || !body) {
    console.error('photo check refused:', res.status, body?.error, body?.detail);
    const text =
      body?.error === 'draft_closed' ? CHECK_SAY.closed(tenant.name)
      : body?.error === 'media_too_large' ? CHECK_SAY.tooLarge
      : CHECK_SAY.failed;
    await say(cfg, tenant, chat, text, aboutIt);
    return null;
  }

  // WAHA delivered the same message twice; the first answer already went.
  if (body.repeat_request) return body;

  if (body.status === 'rejected') {
    const better =
      body.reason === 'duplicate'
        ? await duplicateMessage(cfg, draftId, body.photo_id).catch((err) => {
            console.warn('duplicate lookup failed:', err?.message ?? err);
            return null;
          })
        : null;
    await say(cfg, tenant, chat, better || body.message || CHECK_SAY.failed, aboutIt);
  } else if (ack && body.message) {
    await say(cfg, tenant, chat, body.message, own);
  }
  return body;
}

// ── WHERE CONSIGNORS ARE PAID ────────────────────────────────────────────────

// Bank details on the store's own number: after a first item, on BANK, and
// the confirmation of a change (lib/consignorBank.js).
async function bankChat(cfg, event, tenant, conversation) {
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

  let result;
  try {
    result = await bankTurn(cfg, tenant, event.from, conversation, event.body);
  } catch (err) {
    console.error('bank turn failed:', err?.message ?? err);
    result = { state: conversation?.state ?? 'idle', draft: conversation?.draft ?? {}, replies: ["Something went wrong. Please send that again in a minute."] };
  }
  if (!result) return json({ ok: true, ignored: 'not about bank details' });

  await setConversation(cfg, tenant, event.from, result);
  const own = { session: tenant.waha_session };
  for (const reply of result.replies) await say(cfg, tenant, event.from, reply, own);

  if (result.notifyOwner) await tellOwnerAboutChange(cfg, tenant, event.from, result.notifyOwner);
  return json({ ok: true, bank: result.state });
}

// The owner hears about a change on the platform number: one to approve, or
// one the consignor said they never asked for.
export async function tellOwnerAboutChange(cfg, tenant, chat, { kind, change }) {
  const owner = chatId(tenant.whatsapp_number);
  if (!owner) return;
  const named = await db(cfg)
    .one('submissions', `tenant_id=eq.${tenant.id}&seller_chat_id=eq.${encodeURIComponent(chat)}&seller_name=not.is.null&select=seller_name&order=created_at.desc`)
    .catch(() => null);
  const name = named?.seller_name ?? null;
  const text =
    kind === 'not_you'
      ? ownerNotYouMessage({ name, change })
      : ownerChangeMessage({ name, change, origin: cfg.publicOrigin });
  await say(cfg, tenant, owner, text);
}

// The hourly sweep for payout account changes (index.js scheduled):
//
//   * a change asked for VERIFY_AFTER_HOURS ago gets its confirmation message
//     now, from the store's number, so it reaches the phone after whoever
//     asked may have put it down. Not while they're halfway through offering
//     an item; the next hour will do.
//   * a confirmation unanswered for VERIFY_EXPIRES_HOURS cancels the change.
export async function consignorBankSweep(env, { now = new Date() } = {}) {
  const cfg = config(env);
  if (!cfg.supabaseUrl || !cfg.serviceKey || !cfg.wahaUrl) return null;
  const due = new Date(now.getTime() - VERIFY_AFTER_HOURS * 3_600_000).toISOString();
  const lapsed = new Date(now.getTime() - VERIFY_EXPIRES_HOURS * 3_600_000).toISOString();
  let sent = 0;
  let expired = 0;

  const toVerify = await db(cfg).select(
    'consignor_account_changes',
    `status=eq.pending&verify_sent_at=is.null&requested_at=lte.${due}&select=${COLUMNS.consignor_account_change}&order=requested_at.asc&limit=50`
  );
  for (const change of toVerify) {
    const tenant = await db(cfg).one('tenants', `id=eq.${change.tenant_id}&select=id,name,waha_session,waha_status,whatsapp_number`);
    if (!tenant?.waha_session || tenant.waha_status !== 'WORKING') continue;
    const conv = await db(cfg).one(
      'bot_conversations',
      `tenant_id=eq.${tenant.id}&chat_id=eq.${encodeURIComponent(change.seller_chat_id)}&select=state,updated_at`
    );
    if (INTAKE_BUSY(conv, now)) continue;
    const claimed = await db(cfg).update(
      'consignor_account_changes',
      `id=eq.${change.id}&status=eq.pending&verify_sent_at=is.null`,
      { verify_sent_at: now.toISOString() }
    );
    if (!claimed.length) continue;
    await setConversation(cfg, tenant, change.seller_chat_id, { state: 'bank_verify', draft: { change_id: change.id } });
    await say(cfg, tenant, change.seller_chat_id, BANK_SAY.verify(change), { session: tenant.waha_session });
    sent += 1;
  }

  const stale = await db(cfg).select(
    'consignor_account_changes',
    `status=eq.pending&verified_at=is.null&verify_sent_at=lte.${lapsed}&select=${COLUMNS.consignor_account_change}&limit=50`
  );
  for (const change of stale) {
    const hit = await db(cfg).update(
      'consignor_account_changes',
      `id=eq.${change.id}&status=eq.pending&verified_at=is.null`,
      { status: 'expired' }
    );
    if (!hit.length) continue;
    expired += 1;
    const tenant = await db(cfg).one('tenants', `id=eq.${change.tenant_id}&select=id,name,waha_session,waha_status`);
    if (!tenant?.waha_session) continue;
    const account = await accountFor(cfg, tenant.id, change.seller_chat_id);
    await setConversation(cfg, tenant, change.seller_chat_id, { state: 'idle', draft: {} });
    if (account) await say(cfg, tenant, change.seller_chat_id, BANK_SAY.expired(account), { session: tenant.waha_session });
  }

  return { sent, expired };
}

// Upsert: the row may or may not be there, and whatever is there is replaced.
export async function setConversation(cfg, tenant, chat, { state, draft }) {
  await db(cfg).insert(
    'bot_conversations',
    { tenant_id: tenant.id, chat_id: chat, state, draft: draft ?? {}, updated_at: new Date().toISOString() },
    { onConflict: 'tenant_id,chat_id', merge: true, returning: false }
  );
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

  // A web account's code (routes/signup.js): the store is for that account.
  const webEmail = await accountForCode(cfg, webCodeIn(event.body), phone).catch(() => null);
  const result = signupStep(current, event, { webEmail });

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

  // A store linked before checkout-in-WhatsApp: bring its webhook up to date.
  if (status === 'WORKING' && cfg.publicOrigin) {
    const held = await db(cfg).one('whatsapp_secrets', `tenant_id=eq.${tenant.id}&select=webhook_secret`).catch(() => null);
    if (held?.webhook_secret) {
      await ensureStoreWebhook(cfg, tenant, { webhookUrl: `${cfg.publicOrigin}/api/waha/webhook`, secret: held.webhook_secret })
        .catch((err) => console.warn('store webhook update failed:', err?.message ?? err));
    }
  }

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
