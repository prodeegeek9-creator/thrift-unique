// WAHA — the WhatsApp HTTP API, self-hosted.
//
// Every WAHA-specific URL and payload shape lives in this file and nowhere
// else, so a WAHA upgrade that moves an endpoint is one file to correct rather
// than a hunt through the bot.
//
// The paths and payloads below were read from WAHA's own source
// (devlikeapro/waha, `core` branch) rather than recalled:
//
//   @Controller('api/sessions')          sessions.controller.ts
//   @Controller('api/:session/status')   status.controller.ts
//   @Controller('api/:session/auth')     auth.controller.ts  (GET qr)
//   POST /api/sendText { chatId, text, session }            README
//   RemoteFile { url, mimetype, filename? }                 files.dto.ts
//   SessionConfig { webhooks: [{ url, events, hmac?, customHeaders? }] }
//
// Including the API key header, which is read in
// core/auth/HeaderOrQueryApiKeyStrategy.ts as `req.headers['x-api-key']`.
// Express lower-cases header names, so the casing here is cosmetic.
const API_KEY_HEADER = 'X-Api-Key';

// A chat id is the phone number without a `+`, suffixed. Group chats use
// @g.us; the bot only ever talks to individuals.
export function chatId(phone) {
  const digits = String(phone ?? '').replace(/[^\d]/g, '');
  if (!digits) return null;
  return `${digits}@c.us`;
}

export function phoneFromChatId(id) {
  const m = /^(\d+)@(c\.us|s\.whatsapp\.net)$/.exec(String(id ?? ''));
  return m ? m[1] : null;
}

// The phone number behind a chat, which is what a store is registered by.
//
// A privacy id (…@lid) says nothing about the number, so WAHA is asked for the
// mapping it keeps — which on the NOWEB engine exists only when the session
// was linked with the store on (see deploy/waha/pair.sh). Null when WAHA has
// no answer; the caller decides what an unidentifiable sender gets.
//
// A 4xx is a standing answer, not a blip: retrying cannot turn a missing
// mapping or a disabled store into a number, so it is logged with WAHA's own
// explanation and treated as "unknown". Anything else throws, so the webhook
// fails before recording anything and WAHA's retry gets another go.
export async function phoneFor(cfg, session, chat) {
  if (!String(chat ?? '').endsWith('@lid')) return phoneFromChatId(chat);

  const call = client(cfg);
  try {
    const found = await call(
      `/api/${encodeURIComponent(session)}/lids/${encodeURIComponent(chat)}`
    );
    return phoneFromChatId(found?.pn);
  } catch (err) {
    if (err instanceof WahaError && err.status >= 400 && err.status < 500) {
      if (err.status !== 404) {
        console.warn('waha lid lookup refused:', err.status, String(err.body ?? '').slice(0, 200));
      }
      return null;
    }
    throw err;
  }
}

export class WahaError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function client(cfg) {
  if (!cfg.wahaUrl) throw new WahaError('WAHA is not configured', 503, null);

  return async function call(path, { method = 'GET', body, raw = false } = {}) {
    const res = await fetch(`${cfg.wahaUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.wahaKey ? { [API_KEY_HEADER]: cfg.wahaKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new WahaError(`WAHA ${res.status} on ${method} ${path}`, res.status, text);
    }
    if (raw) return res;
    // DELETE and some POSTs answer 204.
    if (res.status === 204) return null;
    return res.json().catch(() => null);
  };
}

// ── SESSIONS ─────────────────────────────────────────────────────────────────

// One session per tenant, named after the tenant's slug so that a session seen
// in WAHA's own dashboard is identifiable without a lookup.
//
// Everything below takes a session *name* rather than a tenant, because the
// platform's own session has no tenant behind it — it is one number that every
// seller messages. Callers that hold a tenant pass tenants.waha_session, which
// is authoritative: a slug that changed later must not silently rename a
// session that WAHA still knows by the old one.
export function sessionName(tenant) {
  return `ut-${tenant.slug}`;
}

// Creating a session also tells WAHA where to deliver events and what secret
// to carry when it does.
//
// The secret goes in a custom header rather than relying on WAHA's HMAC
// option: a shared secret we generate, store per tenant and compare ourselves
// is one mechanism under our control, where the HMAC's header name and digest
// vary between WAHA versions and editions.
export async function createSession(cfg, tenant, { webhookUrl, secret }) {
  const call = client(cfg);

  return call('/api/sessions', {
    method: 'POST',
    body: {
      name: sessionName(tenant),
      config: {
        // Only the events the bot acts on. Subscribing to everything means
        // paying for, logging and rate-limiting a firehose of presence and
        // typing notifications nothing reads.
        webhooks: [
          {
            url: webhookUrl,
            // message.any rather than message: it also carries what the store
            // sends, which is how the bot steps back when the owner answers a
            // chat themselves.
            events: ['message.any', 'session.status'],
            customHeaders: [{ name: 'X-Thrift-Secret', value: secret }],
          },
        ],
        metadata: { tenant_id: tenant.id, tenant_slug: tenant.slug },
        // The store's own contacts, kept by NOWEB, are what turn a hidden
        // (@lid) sender into a number the store can call back — see
        // phoneFor(). No full history sync: this is a real, busy WhatsApp,
        // and only the mapping is wanted.
        noweb: { store: { enabled: true, fullSync: false } },
      },
    },
  });
}

// A store linked before checkout-in-WhatsApp has the old event list. Brought
// up to date the next time anybody looks at its WhatsApp (the Channels page),
// once: WAHA restarts the session to apply it.
export async function ensureStoreWebhook(cfg, tenant, { webhookUrl, secret }) {
  const session = await getSession(cfg, sessionName(tenant));
  const hooks = session?.config?.webhooks ?? [];
  if (!session || hooks.some((h) => (h.events ?? []).includes('message.any'))) return false;
  const call = client(cfg);
  await call(`/api/sessions/${encodeURIComponent(sessionName(tenant))}`, {
    method: 'PUT',
    body: {
      config: {
        ...(session.config ?? {}),
        webhooks: [
          {
            url: webhookUrl,
            events: ['message.any', 'session.status'],
            customHeaders: [{ name: 'X-Thrift-Secret', value: secret }],
          },
        ],
      },
    },
  });
  return true;
}

export async function getSession(cfg, session) {
  const call = client(cfg);
  try {
    return await call(`/api/sessions/${encodeURIComponent(session)}`);
  } catch (err) {
    // A session that has never been created is a 404, which is a state to
    // report rather than an error to propagate — the Channels screen wants to
    // say "not linked", not to fail.
    if (err instanceof WahaError && err.status === 404) return null;
    throw err;
  }
}

export async function startSession(cfg, session) {
  const call = client(cfg);
  return call(`/api/sessions/${encodeURIComponent(session)}/start`, { method: 'POST' });
}

export async function stopSession(cfg, session) {
  const call = client(cfg);
  return call(`/api/sessions/${encodeURIComponent(session)}/stop`, { method: 'POST' });
}

export async function deleteSession(cfg, session) {
  const call = client(cfg);
  return call(`/api/sessions/${encodeURIComponent(session)}`, { method: 'DELETE' });
}

// The QR the seller scans, as a data URL.
//
// Returned inline rather than proxied as an image, because an <img src> cannot
// carry an Authorization header and this endpoint has to be behind one — a QR
// code is a login. It is also short-lived: WAHA rotates it every twenty
// seconds or so, which is why the Channels screen re-fetches rather than
// caching one.
export async function getQR(cfg, session) {
  const call = client(cfg);

  try {
    const res = await call(`/api/${encodeURIComponent(session)}/auth/qr`, { raw: true });
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.byteLength) return null;
    return `data:image/png;base64,${base64(bytes)}`;
  } catch (err) {
    // A session that is already paired, still starting, or stopped has no QR
    // to give. That is a state, not a failure — the caller reports the status
    // it already has.
    if (err instanceof WahaError) return null;
    throw err;
  }
}

// Chunked, because btoa(String.fromCharCode(...bytes)) spreads every byte into
// an argument list and blows the stack on anything but a tiny input. A QR PNG
// is small; this is here so it stays correct if something larger is ever
// encoded.
function base64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ── MESSAGES ─────────────────────────────────────────────────────────────────

// "typing…" in the chat until the next message is sent, which clears it.
export async function startTyping(cfg, session, to) {
  const call = client(cfg);
  return call('/api/startTyping', { method: 'POST', body: { session, chatId: to } });
}

// A beat before a reply, longer for a longer one, so the bot reads as somebody
// answering rather than as an instant echo. Brief on purpose: long enough to
// be seen, never long enough to feel slow.
export function typingDelay(cfg, text) {
  if (cfg.wahaTypingMs != null) return Math.max(0, cfg.wahaTypingMs);
  return Math.min(1800, Math.max(800, 600 + String(text ?? '').length * 12));
}

export async function sendText(cfg, session, to, text) {
  const call = client(cfg);
  return call('/api/sendText', {
    method: 'POST',
    body: { session, chatId: to, text },
  });
}

// ── WHATSAPP STATUS ──────────────────────────────────────────────────────────

// The Starter tier's entire distribution channel, and the reason product
// images live in Supabase storage behind public URLs: WAHA takes a RemoteFile,
// so nothing has to be uploaded twice.
//
// Always the tenant's own session, never the platform's — Status goes to the
// seller's contacts, which is the whole point and is impossible from a number
// those contacts have never saved.
//
// Returns the post's message ID, or null when it can't be had: WAHA hands out
// an ID to post under (status/new-message-id), and failing that the post's
// own answer may carry one. A reply to the post quotes this ID.
export async function postImageStatus(cfg, session, { url, caption, mimetype = 'image/jpeg' }) {
  const call = client(cfg);
  const base = `/api/${encodeURIComponent(session)}/status`;

  const planned = await call(`${base}/new-message-id`)
    .then((r) => r?.id ?? null)
    .catch(() => null);

  const sent = await call(`${base}/image`, {
    method: 'POST',
    body: {
      ...(planned ? { id: planned } : {}),
      file: { url, mimetype, filename: 'listing.jpg' },
      caption,
    },
  });
  const answered = [sent?.key?.id, sent?.id?.id, sent?.id?._serialized, sent?.id].find((v) => typeof v === 'string' && v);
  return bareMessageId(planned ?? answered ?? null);
}

export async function postTextStatus(cfg, session, { text, backgroundColor = '#12301E' }) {
  const call = client(cfg);

  return call(`/api/${encodeURIComponent(session)}/status/text`, {
    method: 'POST',
    body: { text, backgroundColor, font: 0, linkPreview: true },
  });
}

// ── INBOUND ──────────────────────────────────────────────────────────────────

// WAHA's event envelope, read defensively.
//
// The payload shape differs between WAHA's engines (WEBJS, NOWEB, GOWS) and
// has changed across versions, so this reads what it needs with fallbacks
// rather than destructuring a shape it cannot verify. A message the bot cannot
// understand should be ignored, not crash the webhook — WAHA retries failures,
// and a crash loop on one malformed event stalls every other message.
export function parseEvent(body) {
  if (!body || typeof body !== 'object') return null;

  const event = body.event ?? body.type ?? null;
  const session = body.session ?? null;
  const p = body.payload ?? body.data ?? {};

  if (event === 'session.status') {
    return {
      kind: 'status',
      session,
      status: p.status ?? p.state ?? null,
    };
  }

  // 'message' is what the platform session sends; a store's own session sends
  // 'message.any', which also carries the messages the store sends.
  if (event !== 'message' && event !== 'message.any') return null;

  // WAHA marks the store's own outgoing messages with fromMe. Never answered
  // (that would be the bot answering itself); on a store's number they are
  // how the bot knows the owner has stepped into a chat (routes/waha.js).
  if (p.fromMe === true) {
    if (event !== 'message.any') return null;
    const to = [p.to, p._data?.key?.remoteJid, p.chatId].find((x) => /@(c\.us|lid)$/.test(String(x ?? '')));
    if (!to) return null;
    return {
      kind: 'outgoing',
      session,
      to: String(to),
      body: typeof p.body === 'string' ? p.body : '',
      // 'api' for what the bot sent through WAHA, 'app' for the owner's
      // phone, where the engine says so.
      source: p.source ?? null,
    };
  }

  // A person's chat is addressed by phone number (…@c.us) or, more and more,
  // by WhatsApp's privacy id (…@lid), which hides the number — see phoneFor().
  // Groups, Status broadcasts and channels are not a seller talking to the bot.
  const from = p.from ?? p.chatId ?? null;
  if (!from || !/@(c\.us|lid)$/.test(String(from))) return null;

  return {
    kind: 'message',
    session,
    id: p.id?.id ?? p.id ?? p._data?.id?.id ?? null,
    // WhatsApp's own send time, in seconds. It survives a webhook retry
    // unchanged, which makes it the fallback identity for an engine that does
    // not give a message id — see the dedup in routes/waha.js.
    timestamp: Number(p.timestamp ?? p.t ?? 0) || null,
    from: String(from),
    body: typeof p.body === 'string' ? p.body : (p.text ?? ''),
    hasMedia: Boolean(p.hasMedia ?? p.media ?? false),
    mediaUrl: p.media?.url ?? p.mediaUrl ?? null,
    mimetype: p.media?.mimetype ?? p.mimetype ?? null,
    // The message this one replies to, if any: for a reply to a Status post,
    // the post's caption, which names the item (lib/cart.js).
    quoted: quotedText(p),
    // And that message's WhatsApp ID. A Status post Vendwyze made is saved
    // under its ID (status_posts), which names the item even when the caption
    // doesn't come through.
    quotedId: quotedId(p),
  };
}

function quoteContext(p) {
  return (
    p._data?.message?.extendedTextMessage?.contextInfo ??
    p._data?.message?.imageMessage?.contextInfo ??
    p._data?.contextInfo ??
    null
  );
}

// WAHA gives the bare ID (BAE5…) on NOWEB and a serialised one
// (false_status@broadcast_BAE5…_…@c.us) elsewhere; the bare part is what a
// post is saved under.
export function bareMessageId(id) {
  if (id == null || id === '') return null;
  const s = String(id);
  if (!s.includes('_')) return s;
  const parts = s.split('_');
  // true_<chat>_<id> or true_<chat>_<id>_<participant>
  return parts[2] || parts.at(-1) || null;
}

function quotedId(p) {
  return bareMessageId(p.replyTo?.id ?? quoteContext(p)?.stanzaId ?? null);
}

function quotedText(p) {
  if (typeof p.replyTo?.body === 'string' && p.replyTo.body) return p.replyTo.body;
  const q = quoteContext(p)?.quotedMessage;
  if (!q) return null;
  return (
    q.imageMessage?.caption ??
    q.videoMessage?.caption ??
    q.extendedTextMessage?.text ??
    q.conversation ??
    null
  );
}
