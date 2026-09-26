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

import { EMAIL } from './accounts.js';

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
// read as a greeting as readily as an intent, so intent is tested before the
// menu, which answers greetings and anything else.
export const CANCEL = /^(cancel|stop|quit|abort|never ?mind)\b/i;
const START = /\b(list|sell|add|new item|post)\b/i;

// Words a seller types to mean "that is all the photos", which must not become
// the item's name.
export const FILLER = /^(done|ok|okay|next|finish|finished|that'?s? ?(it|all)|no more)\b/i;

export const YES = /^(y|yes|yeah|yep|ok|okay|post|send|confirm|go)\b/i;
export const NO = /^(n|no|nope|cancel|stop)\b/i;
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

// ── OPENING A STORE ──────────────────────────────────────────────────────────
//
// Somebody whose number belongs to no store is walked through opening one:
// the business's name, what kind of store it is, what it sells, a plan, an
// email for the dashboard, and the commission terms. A store is created at the
// end, pending the operator's approval, and can list straight away.
//
// Their number is the store's number from then on: messaging from it proves
// they hold it, so there is nothing to type into a dashboard first — which
// matters, because there is no dashboard login until approval.

export const MAX_BUSINESS_NAME = 60;

// Bumped whenever the wording of TERMS changes, so the version stored against
// a store always names the text its owner actually said YES to.
export const DISCLAIMER_VERSION = 'commission-v1';

// Commission per plan, from the pricing table: the top of each range, since
// the operator can lower a rate but raising one after acceptance would be
// charging for something nobody agreed to. Business is negotiable, so it
// starts at Growth's rate until the operator agrees another.
export const COMMISSION = { starter: 8, growth: 7, business: 7 };

const STORE_TYPES = [
  { value: 'consignment', words: ['1', 'thrift', 'thrift store', 'consignment', 'middleman'] },
  { value: 'brand', words: ['2', 'brand', 'brand store', 'my own', 'own'] },
];

export const CATEGORIES = [
  { value: 'thrift', label: 'Thrift & vintage clothing' },
  { value: 'fashion', label: 'Fashion & clothing' },
  { value: 'bags-shoes', label: 'Bags, shoes & accessories' },
  { value: 'beauty', label: 'Beauty & hair' },
  { value: 'gadgets', label: 'Phones & gadgets' },
  { value: 'home', label: 'Home & furniture' },
  { value: 'other', label: 'Something else' },
];

const PLANS = [
  { value: 'starter', words: ['1', 'starter'] },
  { value: 'growth', words: ['2', 'growth'] },
  { value: 'business', words: ['3', 'business'] },
];

// A bare greeting in answer to "what is your business called?" is somebody
// saying hello again, not a store called "Hi".
const BARE_GREETING = /^(hi|hey|hello|help|menu|start|yo)[\s!.?]*$/i;
const AGREE = /^(y|yes|yeah|yep|i agree|agree|accept|i accept|ok|okay)\b/i;
const DECLINE = /^(n|no|nope)\b/i;

function pick(options, text) {
  const raw = String(text ?? '').toLowerCase().trim().replace(/[.!*]+$/, '');
  if (!raw) return null;
  return options.find((o) => o.words.some((w) => raw === w || raw.startsWith(`${w} `)))?.value ?? null;
}

export function parseStoreType(text) {
  return pick(STORE_TYPES, text);
}

export function parsePlan(text) {
  return pick(PLANS, text);
}

export function parseCategory(text) {
  const raw = String(text ?? '').toLowerCase().trim().replace(/[.!*]+$/, '');
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= CATEGORIES.length) return CATEGORIES[n - 1].value;
  const hit = CATEGORIES.find((c) => c.value === raw || c.label.toLowerCase() === raw);
  return hit?.value ?? null;
}

export function categoryLabel(value) {
  return CATEGORIES.find((c) => c.value === value)?.label ?? value;
}

const SIGNUP = {
  welcome:
    "Hi 👋 This number isn't linked to a store on Unique Thrift yet.\n\n" +
    'Want to open one? Reply with your *business name*.\n\n' +
    '(Reply *cancel* any time.)',
  badName: `Reply with your business name — 2 to ${MAX_BUSINESS_NAME} characters.`,
  askType: (name) =>
    `*${name}* — nice. What kind of store is it?\n\n` +
    '1 *Thrift store* — people bring you items and you sell them on their behalf\n' +
    '2 *Brand store* — you sell your own stock\n\n' +
    'Reply 1 or 2.',
  badType: 'Reply 1 for a thrift store, or 2 for a brand store.',
  askCategory:
    'What do you mostly sell?\n\n' +
    CATEGORIES.map((c, i) => `${i + 1} ${c.label}`).join('\n') +
    '\n\nReply with the number.',
  badCategory: `Reply with a number from 1 to ${CATEGORIES.length}.`,
  askPlan:
    'Pick a plan:\n\n' +
    `1 *Starter* — ₦10,000–15,000/mo. Listings shared to your WhatsApp Status. ${COMMISSION.starter}% per sale, paid out the same day.\n\n` +
    `2 *Growth* — ₦25,000–35,000/mo. Adds Instagram & Facebook, buyer protection and checkout in WhatsApp. ${COMMISSION.growth}% per sale, released when the buyer confirms delivery.\n\n` +
    '3 *Business* — from ₦75,000/mo. Adds TikTok, staff logins, analytics and dedicated support. Commission agreed with you.\n\n' +
    "Reply 1, 2 or 3. We'll confirm pricing with you before anything is charged, and you can change plan later.",
  badPlan: 'Reply 1 for Starter, 2 for Growth or 3 for Business.',
  askEmail: 'What email should your dashboard login use?',
  badEmail: "That doesn't look like an email address. Try again, e.g. ada@example.com",
  declined:
    "Understood — the store can't open without agreeing to these terms, because every sale on Unique Thrift is paid through us. " +
    'Reply *YES* if you change your mind, or *CANCEL* to stop.',
  cancelled: 'No problem, nothing was set up. Message us any time to open a store.',
};

// The commission disclaimer, version DISCLAIMER_VERSION. A draft for the
// operator to review; change DISCLAIMER_VERSION with the wording.
export function termsMessage(tier) {
  const pct = COMMISSION[tier] ?? COMMISSION.starter;
  const payout =
    tier === 'starter'
      ? "You're paid the same day the buyer pays."
      : "The buyer's payment is held until they confirm they've received the item, then released to you.";
  const rate =
    tier === 'business'
      ? `A ${pct}% commission applies to every sale paid through Unique Thrift until we agree a different rate with you.`
      : `Every sale paid through Unique Thrift has a ${pct}% commission deducted before you're paid.`;

  return (
    '*Before we set you up — our commission terms*\n\n' +
    `• ${rate}\n` +
    `• ${payout}\n` +
    '• Buyers always pay through Unique Thrift. Taking payment directly from a buyer for an item listed here is not allowed, and can get the store suspended.\n' +
    '• Your monthly plan fee is separate from commission, and is confirmed with you before anything is charged.\n\n' +
    'Reply *YES* to accept, or *CANCEL*.'
  );
}

export function submittedMessage(name) {
  return (
    `✅ *${name}* is set up!\n\n` +
    "We're reviewing your store and will message you here once it's approved — then your dashboard login and your store's web page go live.\n\n" +
    "Don't wait for us: send a photo of your first item now and I'll list it 📸"
  );
}

// Sent when the operator approves. A new account gets its set-password link; an
// email that already had an account gets told to sign in with it, because a
// login link for an existing account must never go to whoever typed its email.
export function approvedMessage({ name, link, email, origin, slug }) {
  const lines = [`🎉 *${name}* is approved and live!`, ''];

  if (link) {
    lines.push('Set your dashboard password here:', link);
  } else {
    lines.push(
      `Sign in to your dashboard with your existing account (${email})` +
        (origin ? `: ${origin}/login` : '.')
    );
  }

  if (origin && slug) {
    lines.push('', 'Your store page — share it anywhere:', `${origin}/s/${slug}`);
  }

  lines.push('', 'To list an item, just send a photo here 📸');
  return lines.join('\n');
}

const SIGNUP_STATES = ['name', 'type', 'category', 'plan', 'email', 'terms'];

// signupStep(signup, message, ctx) → { state, patch, replies, action }
//
//   signup   { state, business_name, store_type, category, tier, email,
//              updated_at } as stored, or null
//   state    what to store next, or null to forget the sign-up
//   patch    columns to store alongside it
//   action   { type: 'provision', name, email, storeType, category, tier }
//            once the terms are accepted
//
// Only reached for a number with no store, so a 'pending' row here means the
// store it was waiting on has gone — rejected and deleted — and the sign-up
// starts over.
export function signupStep(signup, message, ctx = {}) {
  const live =
    signup && SIGNUP_STATES.includes(signup.state) && !staleness(signup, ctx) ? signup : null;
  const text = String(message?.body ?? '').trim();
  const ask = (state, reply, patch = {}) => ({ state, patch, replies: [reply], action: null });

  if (live && CANCEL.test(text)) {
    return { state: null, patch: {}, replies: [SIGNUP.cancelled], action: null };
  }

  switch (live?.state) {
    case 'name': {
      const name = text.replace(/\s+/g, ' ');
      if (name.length < 2 || name.length > MAX_BUSINESS_NAME || BARE_GREETING.test(name)) {
        return ask('name', SIGNUP.badName);
      }
      return ask('type', SIGNUP.askType(name), { business_name: name });
    }

    case 'type': {
      const storeType = parseStoreType(text);
      if (!storeType) return ask('type', SIGNUP.badType);
      return ask('category', SIGNUP.askCategory, { store_type: storeType });
    }

    case 'category': {
      const category = parseCategory(text);
      if (!category) return ask('category', SIGNUP.badCategory);
      return ask('plan', SIGNUP.askPlan, { category });
    }

    case 'plan': {
      const tier = parsePlan(text);
      if (!tier) return ask('plan', SIGNUP.badPlan);
      return ask('email', SIGNUP.askEmail, { tier });
    }

    case 'email': {
      const email = text.toLowerCase();
      if (!EMAIL.test(email)) return ask('email', SIGNUP.badEmail);
      return ask('terms', termsMessage(live.tier), { email });
    }

    case 'terms': {
      if (AGREE.test(text)) {
        return {
          state: 'pending',
          patch: {},
          replies: [],
          action: {
            type: 'provision',
            name: live.business_name,
            email: live.email,
            storeType: live.store_type,
            category: live.category,
            tier: live.tier ?? 'starter',
          },
        };
      }
      if (DECLINE.test(text)) return ask('terms', SIGNUP.declined);
      return ask('terms', termsMessage(live.tier));
    }

    default:
      return ask('name', SIGNUP.welcome, {
        business_name: null,
        store_type: null,
        category: null,
        tier: null,
        email: null,
      });
  }
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

// A listing from a store still waiting for approval: saved, not yet public.
export function savedMessage(product) {
  return (
    `✅ *${product.title}* is saved — ${formatNaira(product.price)}\n\n` +
    "It goes live, with its own link, as soon as your store is approved.\n\n" +
    'Send another photo to add the next one.'
  );
}

export function paymentLinkMessage({ title, price, url }) {
  return (
    `💳 Payment link for *${title}* — ${formatNaira(price)}:\n${url}\n\n` +
    'Send it to the buyer. It works for 3 days, and the item comes off sale as soon as it is paid.'
  );
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
      return idleStep(text, image, ctx);
  }
}

function idleStep(text, image, ctx = {}) {
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

  // "LINK JBU4PE 30k": a payment link for a price agreed in chat. Before the
  // menu words, since a bare "link" is the store page.
  const pay = MENU_PAYLINK.exec(text);
  if (pay) {
    const price = pay[2] ? parsePrice(pay[2]) : null;
    if (pay[2] && price == null) {
      return done("I didn't catch that price. Try e.g. *LINK JBU4PE 30k*, or leave the price off to use the listed one.");
    }
    return {
      state: 'idle',
      draft: {},
      replies: [],
      action: { type: 'payment_link', code: pay[1].toUpperCase(), price },
    };
  }

  // The menu's own words, before START: "review items" is not a listing.
  if (MENU_STORE.test(text)) return done(storeLinkMessage(ctx));
  if (MENU_REVIEW.test(text)) return done(reviewMessage(ctx));
  if (MENU_DASHBOARD.test(text)) return done(dashboardMessage(ctx));

  if (START.test(text)) {
    return { state: 'photo', draft: { images: [] }, replies: [SAY.askPhoto], action: null };
  }

  // A greeting, "menu", "help", or anything the bot does not understand.
  return done(menuMessage(ctx));
}

// ── THE OWNER'S MENU ─────────────────────────────────────────────────────────
//
// What a store owner gets for "hi", "menu" or anything the bot does not
// follow: the few things this number does, each one word away. Anchored at the
// start of the message, so a sentence that merely contains "store" is not
// mistaken for a request.

const MENU_STORE = /^(store|shop|link|my store|my shop|store link|my link)\b/i;
const MENU_PAYLINK = /^(?:link|pay|paylink|payment link)\s+([a-z0-9]{4,10})(?:\s+(.+))?$/i;
const MENU_REVIEW = /^(review|reviews|submissions|pending|items to review)\b/i;
const MENU_DASHBOARD = /^(dashboard|login|log ?in|sign ?in)\b/i;

const isBrand = (ctx) => ctx.tenant?.store_type === 'brand';

export function menuMessage(ctx = {}) {
  const pending = Number.isInteger(ctx.pendingItems) ? ctx.pendingItems : null;
  const lines = [
    `👋 Hi${ctx.tenant?.name ? ` ${ctx.tenant.name}` : ''}! Here's what you can do here:`,
    '',
    '📸 *Send a photo* to list a new item',
    '🏪 *STORE* for your store page link',
  ];
  if (!isBrand(ctx)) {
    lines.push(`📥 *REVIEW* for items people sent you${pending ? ` (${pending} waiting)` : ''}`);
  }
  lines.push(
    '💳 *LINK code price* for a payment link to send a buyer (e.g. LINK JBU4PE 30k)',
    '💻 *DASHBOARD* to manage listings, orders and payouts',
    '',
    'Reply *cancel* any time to stop.'
  );
  return lines.join('\n');
}

export function storeLinkMessage(ctx = {}) {
  const slug = ctx.tenant?.slug;
  const link = ctx.origin && slug ? `${ctx.origin}/s/${slug}` : slug ? `/s/${slug}` : null;
  if (!link) return 'Your store page is not set up yet.';
  if (ctx.tenant?.status !== 'active') {
    return `🏪 Your store page will be live here once your store is approved:\n${link}`;
  }
  return `🏪 Your store page:\n${link}\n\nShare it anywhere: your bio, your Status, any chat.`;
}

export function reviewMessage(ctx = {}) {
  if (isBrand(ctx)) {
    return "Brand stores list their own stock, so there's nothing to review. Send a photo to list an item.";
  }
  const pending = Number.isInteger(ctx.pendingItems) ? ctx.pendingItems : 0;
  const where = ctx.origin ? `${ctx.origin}/dashboard/submissions` : '/dashboard/submissions';
  const lines = [
    pending
      ? `📥 ${pending} item${pending === 1 ? '' : 's'} waiting for you to review:`
      : '📥 Nothing waiting for review right now.',
    where,
  ];
  const sell = sellLinkFor(ctx.tenant);
  if (sell) {
    lines.push('', 'People can send you items to sell with this link:', sell);
  }
  return lines.join('\n');
}

export function dashboardMessage(ctx = {}) {
  const where = ctx.origin ? `${ctx.origin}/dashboard` : '/dashboard';
  return `💻 Your dashboard:\n${where}\n\nSign in with the email you signed up with.`;
}

// The store's "Sell with us" link: its own number, with SELL typed. Keep the
// text in step with sellLink() in src/lib/submissions.js.
export function sellLinkFor(tenant) {
  const number = String(tenant?.whatsapp_number ?? '').replace(/\D/g, '');
  if (!number) return null;
  const text = `SELL — I'd like ${tenant.name ?? 'you'} to sell an item for me`;
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
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
      // Said once. A seller sending a whole album gets one note, not one per
      // photo past the limit.
      if (draft.limit_noted) return { state: 'photo', draft, replies: [], action: null };
      return {
        state: 'photo',
        draft: { ...draft, limit_noted: true },
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
export function imageFrom(message) {
  if (!message?.hasMedia || !message.mediaUrl) return null;

  const mimetype = String(message.mimetype ?? '');
  // Videos and voice notes arrive through the same field. A listing takes
  // photos; anything else is ignored rather than stored as an image that will
  // fail to render.
  if (mimetype && !mimetype.startsWith('image/')) return null;

  return { url: message.mediaUrl, mimetype: mimetype || 'image/jpeg' };
}

export function staleness(conversation, ctx) {
  if (!conversation?.updated_at) return false;
  const now = ctx.now ? new Date(ctx.now).getTime() : Date.now();
  const then = new Date(conversation.updated_at).getTime();
  if (!Number.isFinite(then)) return false;
  return now - then > STALE_AFTER_HOURS * 3_600_000;
}
