// Taking in an item somebody wants a thrift store to sell for them.
//
// This conversation happens on the store's own WhatsApp, not the platform's:
// the people bringing items already message the store, and asking them to
// save a second number would lose most of them. That number is also the
// store's real WhatsApp, full of its real customers, so the bot here is quiet
// by default. It speaks only to somebody who starts with SELL — which the
// store's "Sell with us" link pre-types — or who is already mid-way through
// offering an item. Everything else is left for the owner to answer, and is
// not even stored.
//
// Pure, like lib/bot.js: intakeStep() takes the stored conversation and the
// message, and returns what to store, what to say and at most one thing to do.

import {
  CANCEL,
  FILLER,
  YES,
  NO,
  MAX_IMAGES,
  MAX_TITLE,
  parsePrice,
  parseCondition,
  conditionLabel,
  formatNaira,
  imageFrom,
  staleness,
} from './bot.js';

export const MAX_SELLER_NAME = 80;

// SELL, sell, "Sell: …", "SELL — I'd like to sell an item". Only at the start:
// "do you sell bags?" is a customer, not a seller.
export const SELL = /^\s*sell\b/i;

// States this flow owns in bot_conversations. The table is shared with the
// listing flow, keyed by store and chat; the chats never overlap, because the
// listing flow runs on the platform number and this one on the store's own.
const STATES = ['photo', 'title', 'price', 'condition', 'name', 'review'];

const SAY = {
  start: (store) =>
    `🤖 Hi! I'm the ${store} assistant. I'll help you send us an item to sell for you.\n\n` +
    `Send a photo of the item 📸 (up to ${MAX_IMAGES}).\n\n` +
    'Reply *cancel* any time.',
  askPhoto: 'Send a photo of the item 📸',
  noPhotos: 'We need at least one photo of the item. Send one now 📸',
  morePhotos: (n) =>
    n === 1 ? 'Got it 👍 Send more photos, or type the item name.' : `${n} photos. Send more, or type the item name.`,
  photoLimit: `That's the ${MAX_IMAGES}-photo limit. What is the item called?`,
  askTitle: 'What is the item called?',
  askPrice: 'How much do you want for it? (e.g. 15000 or 15k)',
  badPrice: "I didn't catch a price. Send the amount on its own — 15000, or 15k.",
  askCondition:
    'What condition is it in?\n\n1 Brand new\n2 Excellent\n3 Good\n4 Fair\n\nReply with the number.',
  badCondition: 'Reply with 1, 2, 3 or 4.',
  askName: 'Last thing: what name should we put this under?',
  badName: `Reply with your name — up to ${MAX_SELLER_NAME} characters.`,
  review: (draft, store) =>
    `Here's what we'll send to ${store}:\n\n` +
    [
      `*${draft.title}*`,
      `Your price: ${formatNaira(draft.price)}`,
      conditionLabel(draft.condition),
      `${draft.images.length} photo${draft.images.length === 1 ? '' : 's'}`,
      `From: ${draft.name}`,
    ].join('\n') +
    '\n\nReply *YES* to send it for review, or *CANCEL*.',
  reviewAgain: 'Reply *YES* to send it for review, or *CANCEL*.',
  cancelled: 'Cancelled. Nothing was sent. Message *SELL* any time to offer an item.',
};

export function receivedMessage(store) {
  return (
    `✅ Sent! ${store} will review your item and message you here once it's approved.\n\n` +
    'Send *SELL* to offer another one.'
  );
}

export function approvedSellerMessage({ store, title, price, link }) {
  const lines = [`🎉 Good news! ${store} has listed your *${title}* for ${formatNaira(price)}.`];
  if (link) lines.push('', 'Share it with anyone who might want it:', link);
  lines.push('', "We'll let you know when it sells.");
  return lines.join('\n');
}

export function declinedSellerMessage({ store, title, reason }) {
  const lines = [`Thanks for thinking of ${store}. We won't be listing your *${title}* this time.`];
  if (reason) lines.push('', `Reason: ${reason}`);
  lines.push('', 'Send *SELL* any time to offer something else.');
  return lines.join('\n');
}

// To the consignor, from the store's number, when their item sells.
export function soldConsignorMessage({ store, title, owed }) {
  return (
    `🎉 Your *${title}* has sold!\n\n` +
    `${store} owes you ${formatNaira(owed)} and will message you when it's paid.`
  );
}

// To the consignor when the store marks them paid.
export function paidConsignorMessage({ store, title, amount, note }) {
  return (
    `💸 ${store} has paid you ${formatNaira(amount)} for your *${title}*.` +
    (note ? `\n\n${note}` : '') +
    '\n\nThank you for selling with us! Send *SELL* any time to offer something else.'
  );
}

// For the store owner, on the platform number, when an item arrives.
export function newSubmissionMessage({ title, price, name, origin }) {
  return (
    `📥 New item to review: *${title}*, ${formatNaira(price)} asked` +
    (name ? `, from ${name}` : '') +
    '.' +
    (origin ? `\n\nReview it: ${origin}/dashboard/submissions` : '')
  );
}

// intakeStep(conversation, message, ctx) → { state, draft, replies, action } | null
//
//   ctx       { store, knownName, now }
//   null      not ours: nobody asked to sell and nothing is in progress, so
//             the owner answers this one, and nothing is stored
//   action    { type: 'submit', submission: {…}, images: [{ url, mimetype }] }
export function intakeStep(conversation, message, ctx = {}) {
  const store = ctx.store ?? 'the store';
  const live =
    conversation && STATES.includes(conversation.state) && !staleness(conversation, ctx)
      ? conversation
      : null;

  const text = String(message?.body ?? '').trim();
  const image = imageFrom(message);

  if (!live) {
    if (!SELL.test(text)) return null;
    // A photo sent with a SELL caption is the item's first photo.
    const draft = { images: image ? [image] : [] };
    return reply('photo', draft, image ? `${SAY.start(store)}\n\n${SAY.morePhotos(1)}` : SAY.start(store));
  }

  const draft = { ...(live.draft ?? {}), images: [...(live.draft?.images ?? [])] };

  if (CANCEL.test(text)) return { state: 'idle', draft: {}, replies: [SAY.cancelled], action: null };

  // Another angle of the item, at any point before the summary.
  if (image && live.state !== 'review') {
    if (draft.images.length >= MAX_IMAGES) {
      if (draft.limit_noted) return { state: live.state, draft, replies: [], action: null };
      return reply(live.state, { ...draft, limit_noted: true }, SAY.photoLimit);
    }
    draft.images.push(image);
    if (live.state === 'photo') return reply('photo', draft, SAY.morePhotos(draft.images.length));
    return reply(live.state, draft, ask(live.state));
  }

  switch (live.state) {
    case 'photo': {
      if (!text) return reply('photo', draft, SAY.askPhoto);
      if (SELL.test(text)) return reply('photo', draft, draft.images.length ? SAY.askTitle : SAY.askPhoto);
      if (!draft.images.length) return reply('photo', draft, SAY.noPhotos);
      if (FILLER.test(text)) return reply('title', draft, SAY.askTitle);
      return reply('price', { ...draft, title: text.slice(0, MAX_TITLE) }, SAY.askPrice);
    }

    case 'title':
      if (!text) return reply('title', draft, SAY.askTitle);
      return reply('price', { ...draft, title: text.slice(0, MAX_TITLE) }, SAY.askPrice);

    case 'price': {
      const price = parsePrice(text);
      if (price == null) return reply('price', draft, SAY.badPrice);
      return reply('condition', { ...draft, price }, SAY.askCondition);
    }

    case 'condition': {
      const condition = parseCondition(text);
      if (!condition) return reply('condition', draft, SAY.badCondition);
      const next = { ...draft, condition };
      // Asked once per seller: somebody bringing a second item has told us.
      if (ctx.knownName) {
        const named = { ...next, name: ctx.knownName };
        return reply('review', named, SAY.review(named, store));
      }
      return reply('name', next, SAY.askName);
    }

    case 'name': {
      const name = text.replace(/\s+/g, ' ');
      if (name.length < 1 || name.length > MAX_SELLER_NAME) return reply('name', draft, SAY.badName);
      const named = { ...draft, name };
      return reply('review', named, SAY.review(named, store));
    }

    case 'review': {
      if (YES.test(text)) return submit(draft);
      if (NO.test(text)) return { state: 'idle', draft: {}, replies: [SAY.cancelled], action: null };
      return reply('review', draft, SAY.reviewAgain);
    }

    default:
      return null;
  }
}

function ask(state) {
  return {
    title: SAY.askTitle,
    price: SAY.askPrice,
    condition: SAY.askCondition,
    name: SAY.askName,
  }[state] ?? SAY.askPhoto;
}

function reply(state, draft, text) {
  return { state, draft, replies: [text], action: null };
}

function submit(draft) {
  // Belt and braces, as in the listing flow: a draft resumed across a deploy
  // can be missing something the flow now always collects.
  if (!draft.images?.length || !draft.title || draft.price == null || !draft.condition) {
    return { state: 'photo', draft: { images: draft.images ?? [] }, replies: [SAY.askPhoto], action: null };
  }

  return {
    state: 'idle',
    draft: {},
    replies: [],
    action: {
      type: 'submit',
      submission: {
        title: draft.title,
        asking_price: draft.price,
        condition: draft.condition,
        seller_name: draft.name ?? null,
      },
      images: draft.images,
    },
  };
}
