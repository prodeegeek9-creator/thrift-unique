// The listing conversation.
//
// A seller adds an item by talking to the bot, not by filling in a form —
// that is the product, and the dashboard's "Add manually" is the fallback for
// when somebody happens to be at a desk. Everything that decides what the bot
// says next lives here.
//
// This file is pure. No fetch, no database, no clock beyond what is handed
// in. `step()` takes the conversation as it was stored and the message that
// just arrived, and returns the conversation as it should now be stored, what
// to say, and at most one thing to do. Every branch is therefore testable
// without a WhatsApp account, a WAHA server or a network, which is most of why
// the flow is worth writing this way — the parts that need a real server are
// four HTTP calls in lib/waha.js and nothing else.

export const MAX_IMAGES = 4;
export const MAX_TITLE = 120;

// A naira ceiling that is absurd for thrift and still leaves room for a
// genuine mistake to be caught rather than silently listed. ₦100m.
export const MAX_PRICE = 100_000_000;

// How long a half-finished listing stays half-finished before the bot forgets
// it. A seller who wandered off mid-conversation and comes back two days later
// means to start again, not to answer a question they no longer remember.
export const STALE_AFTER_HOURS = 6;

const CONDITIONS = [
  { value: 'brand_new', label: 'Brand new', words: ['1', 'brand new', 'brand-new', 'new', 'bnib'] },
  { value: 'excellent', label: 'Excellent', words: ['2', 'excellent', 'like new', 'barely used'] },
  { value: 'good', label: 'Good', words: ['3', 'good', 'fine'] },
  { value: 'fair', label: 'Fair', words: ['4', 'fair', 'worn', 'used'] },
];

// Checked in this order, and the order matters. The dashboard's deep link
// opens WhatsApp with "Hi! I want to list a new item." pre-typed — which would
// match a greeting as readily as an intent, so intent is tested first.
const CANCEL = /^(cancel|stop|quit|abort|never ?mind)\b/i;
const START = /\b(list|sell|add|new item|post)\b/i;
const GREETING = /^(help|menu|hi|hey|hello|start|\?)\b/i;

// Words a seller types to mean "that is all the photos", which must not become
// the item's name.
const FILLER = /^(done|ok|okay|next|finish|finished|that'?s? ?(it|all)|no more)\b/i;

const YES = /^(y|yes|yeah|yep|ok|okay|post|send|confirm|go)\b/i;
const NO = /^(n|no|nope|cancel|stop)\b/i;
const NEGOTIABLE = /^(negotiable|negotiate|offers?|bargain)\b/i;

// ── PARSING ──────────────────────────────────────────────────────────────────

// "35000", "35,000", "₦35000", "35k", "NGN 35k", "1.5m".
//
// The k and m suffixes are not a nicety. Nigerian sellers write prices that
// way constantly, and a bot that answers "I didn't understand that price" to
// "35k" reads as broken on the first try.
export function parsePrice(text) {
  const raw = String(text ?? '')
    .toLowerCase()
    .replace(/[₦,\s]/g, '')
    .replace(/^(ngn|naira)/, '');

  const m = /^(\d+(?:\.\d{1,2})?)(k|m)?$/.exec(raw);
  if (!m) return null;

  let n = Number(m[1]);
  if (m[2] === 'k') n *= 1_000;
  if (m[2] === 'm') n *= 1_000_000;

  if (!Number.isFinite(n) || n <= 0 || n > MAX_PRICE) return null;

  // Two decimal places, matching numeric(12,2) in the schema. Anything finer
  // would be rejected by Postgres after the seller had already been told the
  // listing was going up.
  return Math.round(n * 100) / 100;
}

export function parseCondition(text) {
  const raw = String(text ?? '').toLowerCase().trim();
  if (!raw) return null;

  for (const c of CONDITIONS) {
    if (c.words.some((w) => raw === w || raw.startsWith(`${w} `))) return c.value;
  }
  return null;
}

export function conditionLabel(value) {
  return CONDITIONS.find((c) => c.value === value)?.label ?? value;
}

// ── COPY ─────────────────────────────────────────────────────────────────────

// Every line the bot can say, in one place. A conversation that is written in
// fragments across a state machine drifts in tone until half of it sounds like
// an error log.
const SAY = {
  askPhoto: 'Send a photo of the item 📸',
  askTitle: 'What is the item called?',
  askPrice: 'How much? (e.g. 35000 or 35k)',
  askCondition:
    'What condition is it in?\n\n1 Brand new\n2 Excellent\n3 Good\n4 Fair\n\nReply with the number.',
  badPrice: "I didn't catch a price there. Send the amount on its own — 35000, or 35k.",
  badCondition: 'Reply with 1, 2, 3 or 4.',
  cancelled: 'Cancelled. Nothing was posted.',
  nothingToCancel: "Nothing in progress. Say *list* when you're ready to add an item.",
  noPhotos:
    "I'll need at least one photo before this can go up. Send one now 📸",
  help:
    'I help you list items for sale.\n\n' +
    '• *list* — add a new item\n' +
    '• *cancel* — stop what we are doing\n\n' +
    'Send a photo any time to start.',
};

export function unknownStoreMessage(origin) {
  return (
    "This number isn't linked to a store yet.\n\n" +
    (origin ? `Set one up at ${origin} and come back — it takes a minute.` : 'Set up a store and come back.')
  );
}

function summary(draft, tenant) {
  const lines = [
    `*${draft.title}*`,
    formatNaira(draft.price),
    conditionLabel(draft.condition),
  ];
  if (draft.images?.length) {
    lines.push(`${draft.images.length} photo${draft.images.length === 1 ? '' : 's'}`);
  }

  return (
    `Here is the listing for ${tenant?.name ?? 'your store'}:\n\n${lines.join('\n')}\n\n` +
    'Reply *YES* to post it, *NEGOTIABLE* to post it and accept offers, or *CANCEL*.'
  );
}

// What the bot says once the product actually exists. Written here rather than
// in the route so that the whole conversation, including its last line, can be
// read in one file.
export function listedMessage(product, { origin, posted } = {}) {
  const link = origin ? `${origin}/p/${product.public_code}` : `/p/${product.public_code}`;

  const lines = [
    `✅ *${product.title}* is live — ${formatNaira(product.price)}`,
    '',
    link,
  ];

  if (posted === true) {
    lines.push('', "Posted to your WhatsApp Status too.");
  } else if (posted === false) {
    // Said plainly rather than hidden: the seller believes they are reaching
    // their contacts, and finding out weeks later that Status was never
    // connected is the worst version of this.
    lines.push('', 'Link your WhatsApp in the dashboard to post listings to your Status automatically.');
  }

  lines.push('', 'Send another photo to list the next one.');
  return lines.join('\n');
}

export function formatNaira(amount) {
  const n = Number(amount) || 0;
  const whole = Number.isInteger(n) ? n : Math.round(n * 100) / 100;
  return `₦${whole.toLocaleString('en-NG')}`;
}

// ── THE MACHINE ──────────────────────────────────────────────────────────────

// step(conversation, message, ctx) → { state, draft, replies, action }
//
//   conversation  { state, draft } as stored, or null for a first message
//   message       { body, hasMedia, mediaUrl, mimetype } from lib/waha.js
//   ctx           { tenant, origin, now }
//
// `action` is at most one thing for the caller to do, and the only one that
// exists today is creating the product. Returning it rather than doing it is
// what keeps this file free of I/O.
export function step(conversation, message, ctx = {}) {
  const state = staleness(conversation, ctx) ? 'idle' : conversation?.state ?? 'idle';
  const draft = state === 'idle' ? {} : { ...(conversation?.draft ?? {}) };

  const text = String(message?.body ?? '').trim();
  const image = imageFrom(message);

  // Cancel works from anywhere, including mid-question. A seller who wants
  // out should not have to answer one more thing to get out.
  if (CANCEL.test(text)) {
    return done(state === 'idle' ? SAY.nothingToCancel : SAY.cancelled);
  }

  switch (state) {
    case 'photo':
      return photoStep(draft, text, image, ctx);
    case 'title':
      return titleStep(draft, text, image, ctx);
    case 'price':
      return priceStep(draft, text, image, ctx);
    case 'condition':
      return conditionStep(draft, text, image, ctx);
    case 'review':
      return reviewStep(draft, text, ctx);
    default:
      return idleStep(text, image);
  }
}

function idleStep(text, image) {
  // A photo with no preamble is the most common way a listing actually
  // starts. Treating it as an opening move saves a round trip and matches
  // what sellers already do with each other.
  if (image) {
    return {
      state: 'title',
      draft: { images: [image] },
      replies: [`Got it 👍 ${SAY.askTitle}`],
      action: null,
    };
  }

  if (START.test(text)) {
    return { state: 'photo', draft: { images: [] }, replies: [SAY.askPhoto], action: null };
  }

  if (GREETING.test(text) || !text) {
    return { state: 'idle', draft: {}, replies: [SAY.help], action: null };
  }

  return { state: 'idle', draft: {}, replies: [SAY.help], action: null };
}

// Collecting photos, and leaving on the first thing that is not one.
//
// Any text that is not filler is taken as the item's name, so a seller who
// sends a photo captioned "brown leather jacket" is two answers from done
// rather than four.
function photoStep(draft, text, image, ctx) {
  const images = draft.images ?? [];

  if (image) {
    if (images.length >= MAX_IMAGES) {
      return {
        state: 'photo',
        draft,
        replies: [`That's the ${MAX_IMAGES}-photo limit. ${SAY.askTitle}`],
        action: null,
      };
    }

    const next = [...images, image];
    return {
      state: 'photo',
      draft: { ...draft, images: next },
      replies: [
        next.length === 1
          ? `Got it 👍 Send more photos, or type the item name.`
          : `${next.length} photos. Send more, or type the item name.`,
      ],
      action: null,
    };
  }

  if (!text) return { state: 'photo', draft, replies: [SAY.askPhoto], action: null };

  if (FILLER.test(text)) {
    if (!images.length) {
      return { state: 'photo', draft, replies: [SAY.noPhotos], action: null };
    }
    return { state: 'title', draft, replies: [SAY.askTitle], action: null };
  }

  return titleStep(draft, text, null, ctx);
}

function titleStep(draft, text, image, ctx) {
  // A photo arriving while the bot is asking for a name is a seller adding
  // another angle, not answering the question. Keep it and re-ask.
  if (image) {
    const images = [...(draft.images ?? [])];
    if (images.length < MAX_IMAGES) images.push(image);
    return { state: 'title', draft: { ...draft, images }, replies: [SAY.askTitle], action: null };
  }

  if (!text) return { state: 'title', draft, replies: [SAY.askTitle], action: null };

  const title = text.slice(0, MAX_TITLE);
  return {
    state: 'price',
    draft: { ...draft, title },
    replies: [SAY.askPrice],
    action: null,
  };
}

function priceStep(draft, text, image, ctx) {
  if (image) {
    const images = [...(draft.images ?? [])];
    if (images.length < MAX_IMAGES) images.push(image);
    return { state: 'price', draft: { ...draft, images }, replies: [SAY.askPrice], action: null };
  }

  const price = parsePrice(text);
  if (price == null) {
    return { state: 'price', draft, replies: [SAY.badPrice], action: null };
  }

  return {
    state: 'condition',
    draft: { ...draft, price },
    replies: [SAY.askCondition],
    action: null,
  };
}

function conditionStep(draft, text, image, ctx) {
  if (image) {
    const images = [...(draft.images ?? [])];
    if (images.length < MAX_IMAGES) images.push(image);
    return { state: 'condition', draft: { ...draft, images }, replies: [SAY.askCondition], action: null };
  }

  const condition = parseCondition(text);
  if (!condition) {
    return { state: 'condition', draft, replies: [SAY.badCondition], action: null };
  }

  const next = { ...draft, condition };
  return { state: 'review', draft: next, replies: [summary(next, ctx.tenant)], action: null };
}

// The last step, and the only one that offers a third answer.
//
// Negotiation is asked about here rather than as its own question because it
// is the one field a seller will shrug at, and a fifth question is where a
// conversational flow starts losing people. Folding it into the confirmation
// costs nothing to ignore and one word to use.
function reviewStep(draft, text, ctx) {
  if (NEGOTIABLE.test(text)) {
    return create({ ...draft, allow_negotiation: true }, ctx);
  }
  if (YES.test(text)) {
    return create({ ...draft, allow_negotiation: false }, ctx);
  }
  if (NO.test(text)) {
    return done(SAY.cancelled);
  }

  return {
    state: 'review',
    draft,
    replies: ['Reply *YES* to post it, *NEGOTIABLE* to accept offers, or *CANCEL*.'],
    action: null,
  };
}

function create(draft, ctx) {
  // Belt and braces. Nothing should reach review without these, but the row
  // this produces goes straight into a table with NOT NULL columns, and a
  // conversation resumed across a deploy is exactly how a draft ends up in a
  // shape the flow no longer produces.
  if (!draft.title || draft.price == null || !draft.condition) {
    return { state: 'idle', draft: {}, replies: [SAY.help], action: null };
  }

  return {
    state: 'idle',
    draft: {},
    replies: [],
    action: {
      type: 'create_product',
      product: {
        title: draft.title,
        price: draft.price,
        condition: draft.condition,
        allow_negotiation: Boolean(draft.allow_negotiation),
      },
      images: draft.images ?? [],
    },
  };
}

function done(message) {
  return { state: 'idle', draft: {}, replies: [message], action: null };
}

// Media, reduced to the two things the upload step needs. Held as the WAHA URL
// rather than downloaded now, so an abandoned draft costs nothing — the
// download happens once, at the moment the product is actually created.
function imageFrom(message) {
  if (!message?.hasMedia || !message.mediaUrl) return null;

  const mimetype = String(message.mimetype ?? '');
  // Videos and voice notes arrive through the same field. A listing takes
  // photos; anything else is ignored rather than stored as an image that will
  // fail to render.
  if (mimetype && !mimetype.startsWith('image/')) return null;

  return { url: message.mediaUrl, mimetype: mimetype || 'image/jpeg' };
}

function staleness(conversation, ctx) {
  if (!conversation?.updated_at) return false;
  const now = ctx.now ? new Date(ctx.now).getTime() : Date.now();
  const then = new Date(conversation.updated_at).getTime();
  if (!Number.isFinite(then)) return false;
  return now - then > STALE_AFTER_HOURS * 3_600_000;
}
