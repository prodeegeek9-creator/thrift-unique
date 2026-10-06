// Taking in an item somebody wants a thrift store to sell for them — with the
// photos checked for them as they arrive.
//
// The successor to lib/intake.js, switched on per store by the photo_review
// flag (worker/routes/waha.js decides which one runs). Same place, same
// trigger — the store's own WhatsApp, a message starting with SELL — and the
// same end: a submissions row the store reviews. What changes is the middle:
//
//   - The seller names a category first, because each category needs
//     different shots (photo_shot_rules): a shirt needs its label, a phone
//     its screen switched on.
//   - The details come before the photos, so the photos stage can end on its
//     own. Photos are checked asynchronously (plain-code checks, then a vision
//     model labelling each shot), and the item goes to the store the moment
//     every required shot has passed — routes/photoReview.js does that from
//     a cron. Nothing has to wait for the seller to say "done".
//   - Questions that decide which shots are needed (has it got flaws? is it a
//     phone?) are asked up front, from the category's conditional rules.
//
// Pure, like lib/intake.js: photoIntakeStep() takes the stored conversation
// and the message and returns what to store, what to say and at most one
// thing to do. The route does the I/O.

import {
  CANCEL,
  FILLER,
  YES,
  NO,
  MAX_TITLE,
  parsePrice,
  parseCondition,
  conditionLabel,
  formatNaira,
  imageFrom,
  staleness,
} from './bot.js';
import { SELL, MAX_SELLER_NAME } from './intake.js';

// Prefixed so they can never be mistaken for lib/intake.js's states, which
// share bot_conversations and may still be mid-way when a store is switched.
export const PHOTO_STATES = [
  'pi_category',
  'pi_title',
  'pi_price',
  'pi_condition',
  'pi_flag',
  'pi_name',
  'pi_review',
  'pi_photos',
];

// Photos sent before the bot has asked for them are kept and checked once the
// draft exists. A few, not unlimited: a seller forwarding a whole album
// before answering anything is not sending one item.
export const MAX_EARLY_PHOTOS = 6;

// The questions behind photo_shot_rules.condition_flag. A flag with no
// question here is never asked, so its conditional shot is never required —
// the safe direction to fail in. Add the question when adding the flag.
export const FLAG_QUESTIONS = {
  has_flaws: 'Does it have any flaws — a stain, tear, scratch, crack or dent? Reply *YES* or *NO*.',
  is_phone: 'Is it a phone? Reply *YES* or *NO*.',
  packaged: 'Does it come sealed in packaging with a label? Reply *YES* or *NO*.',
};

// Flags nobody is asked about: the photo-review AI sets them from the photos
// (migration 0044), so the shot is listed with the condition spelled out and
// the seller sends it only if it applies.
export const AI_FLAGS = {
  has_screen: 'if it has a screen',
};

const FLAG_SUMMARY = {
  has_flaws: 'Has flaws',
  is_phone: 'Phone',
  packaged: 'Packaged',
};

// While photos are coming in, most text is the seller talking to the store,
// not to the bot. These are the words that ask the bot where things stand.
const STATUS = /^\s*(?:(?:status|help|menu|what'?s? (?:left|missing|next))\b|\?)/i;

const SAY = {
  start: (store, menu) =>
    `🤖 Hi! I'm the ${store} assistant. I'll help you send us an item to sell for you.\n\n` +
    `What kind of item is it?\n\n${menu}\n\nReply with the number. Reply *cancel* any time.`,
  badCategory: (menu) => `Reply with one of these numbers:\n\n${menu}`,
  noCategories: "Sorry — we can't take items over WhatsApp right now. Please message the store directly.",
  askTitle: (example) => `What is the item called? (e.g. "${example || 'Black Zara blazer, size M'}")`,
  askPrice: 'How much do you want for it? (e.g. 15000 or 15k)',
  badPrice: "I didn't catch a price. Send the amount on its own — 15000, or 15k.",
  askCondition:
    'What condition is it in?\n\n1 Brand new\n2 Excellent\n3 Good\n4 Fair\n\nReply with the number.',
  badCondition: 'Reply with 1, 2, 3 or 4.',
  yesNo: 'Reply *YES* or *NO*.',
  askName: 'What name should we put this under?',
  badName: `Reply with your name — up to ${MAX_SELLER_NAME} characters.`,
  keptPhoto: "Got the photo 👍 I'll check it once we have the details.",
  review: (draft, store, categoryName) =>
    `Here's what we'll send to ${store}:\n\n` +
    [
      `*${draft.title}*`,
      categoryName,
      `Your price: ${formatNaira(draft.price)}`,
      // Not when the category decided it: "Brand new" under a tray of
      // chin chin reads as a question nobody asked.
      draft.preset_condition ? null : conditionLabel(draft.condition),
      ...(draft.flags ?? []).map((f) => FLAG_SUMMARY[f] ?? f),
      `From: ${draft.name}`,
    ]
      .filter(Boolean)
      .join('\n') +
    '\n\nReply *YES* and I\'ll tell you which photos to send, or *CANCEL*.',
  reviewAgain: "Reply *YES* and I'll tell you which photos to send, or *CANCEL*.",
  cancelled: 'Cancelled. Nothing was sent. Message *SELL* any time to offer an item.',
  photos: ({ needed, optional, early }) =>
    '📸 Now send these photos:\n' +
    needed.map((label) => `• ${label}`).join('\n') +
    (optional.length ? `\n\nOptional: ${optional.join(', ')}` : '') +
    '\n\nSend them one at a time or all together. I check each one and tell you if anything needs retaking.' +
    (early ? `\n\nI'm checking the ${early === 1 ? 'photo' : `${early} photos`} you already sent.` : ''),
};

// What the route answers when asked where things stand, from the draft as the
// database has it now. Exported for the route; the step only asks for it.
export function photoStatusMessage({ title, missing, store }) {
  if (!missing.length) {
    return `✅ All the photos for *${title}* are in. I'm sending it to ${store} now.`;
  }
  return (
    `Still needed for *${title}*:\n` +
    missing.map((label) => `• ${label}`).join('\n') +
    '\n\nSend them when you\'re ready, or reply *CANCEL*.'
  );
}

// The shots a draft will need, given its category and flags, as labels: what
// the seller is asked for. Mirrors listing_draft_missing_shots() in 0038.
export function shotsFor(rules, category, flags = []) {
  const mine = rules
    .filter((r) => r.category === category)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const needed = mine
    .filter(
      (r) =>
        r.requirement === 'required' ||
        (r.requirement === 'conditional' && (flags.includes(r.condition_flag) || AI_FLAGS[r.condition_flag]))
    )
    .map((r) => (r.requirement === 'conditional' && AI_FLAGS[r.condition_flag] && !flags.includes(r.condition_flag)
      ? `${r.label} (${AI_FLAGS[r.condition_flag]})`
      : r.label));
  const optional = mine.filter((r) => r.requirement === 'optional').map((r) => r.label);
  return { needed, optional };
}

// The flags this category asks about, in rule order, once each.
export function flagsToAsk(rules, category) {
  const seen = [];
  for (const r of [...rules].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))) {
    if (r.category !== category || r.requirement !== 'conditional') continue;
    if (!FLAG_QUESTIONS[r.condition_flag] || seen.includes(r.condition_flag)) continue;
    seen.push(r.condition_flag);
  }
  return seen;
}

function menu(categories) {
  return categories.map((c, i) => `${i + 1} ${c.name}`).join('\n');
}

function parseCategory(text, categories) {
  const raw = String(text ?? '').trim().toLowerCase();
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= categories.length) return categories[n - 1];
  return (
    categories.find((c) => c.slug === raw || c.name.toLowerCase() === raw) ??
    categories.find((c) => c.name.toLowerCase().startsWith(raw) && raw.length >= 3) ??
    null
  );
}

// photoIntakeStep(conversation, message, ctx) → { state, draft, replies, action } | null
//
//   ctx       { store, knownName, categories: [{ slug, name }], rules: [...], now }
//   null      not ours: nobody asked to sell and nothing is in progress
//   action    { type: 'create_draft', item, early }      the details are confirmed
//             { type: 'check_photo', image, ack }         a photo for the open draft
//             { type: 'photo_status' }                    say what's still needed
//             { type: 'cancel_draft', draftId }           drop the open draft
export function photoIntakeStep(conversation, message, ctx = {}) {
  const store = ctx.store ?? 'the store';
  const categories = ctx.categories ?? [];
  const rules = ctx.rules ?? [];

  // Waiting on photos can take days — the draft has its own expiry — so the
  // six-hour staleness that ends a half-answered question does not apply.
  const live =
    conversation &&
    PHOTO_STATES.includes(conversation.state) &&
    (conversation.state === 'pi_photos' || !staleness(conversation, ctx))
      ? conversation
      : null;

  const text = String(message?.body ?? '').trim();
  const image = imageFrom(message);

  if (!live) {
    if (!SELL.test(text)) return null;
    if (!categories.length) return { state: 'idle', draft: {}, replies: [SAY.noCategories], action: null };
    const early = image ? [{ ...image, id: message?.id ?? null }] : [];
    return reply('pi_category', { early }, SAY.start(store, menu(categories)));
  }

  const draft = { ...(live.draft ?? {}), early: [...(live.draft?.early ?? [])] };

  if (CANCEL.test(text)) {
    return {
      state: 'idle',
      draft: {},
      replies: [SAY.cancelled],
      action: live.state === 'pi_photos' && draft.draft_id ? { type: 'cancel_draft', draftId: draft.draft_id } : null,
    };
  }

  if (live.state === 'pi_photos') {
    if (image) {
      // The first photo gets "checking"; after that, only problems are worth
      // a message — five identical acknowledgements is noise.
      return {
        state: 'pi_photos',
        draft: { ...draft, acked: true },
        replies: [],
        action: { type: 'check_photo', image: { ...image, id: message?.id ?? null }, ack: !draft.acked },
      };
    }
    if (SELL.test(text) || STATUS.test(text) || FILLER.test(text)) {
      return { state: 'pi_photos', draft, replies: [], action: { type: 'photo_status' } };
    }
    // Anything else is the seller talking to the store. Left for the owner.
    return { state: 'pi_photos', draft, replies: [], action: null };
  }

  // A photo before the bot asked for one: kept, checked once the draft exists.
  if (image) {
    if (draft.early.length >= MAX_EARLY_PHOTOS) return { state: live.state, draft, replies: [], action: null };
    draft.early.push({ ...image, id: message?.id ?? null });
    return reply(live.state, draft, `${SAY.keptPhoto}\n\n${ask(live.state, draft, ctx)}`);
  }

  switch (live.state) {
    case 'pi_category': {
      const picked = parseCategory(text, categories);
      if (!picked) return reply('pi_category', draft, SAY.badCategory(menu(categories)));
      return reply(
        'pi_title',
        {
          ...draft,
          category: picked.slug,
          category_name: picked.name,
          // What the category already says (migration 0047): an example name
          // in its own terms, and for food or handmade, the condition.
          title_example: picked.title_example ?? null,
          preset_condition: picked.default_condition ?? null,
          ask_flags: flagsToAsk(rules, picked.slug),
          flags: [],
        },
        SAY.askTitle(picked.title_example)
      );
    }

    case 'pi_title':
      if (!text || SELL.test(text)) return reply('pi_title', draft, SAY.askTitle(draft.title_example));
      return reply('pi_price', { ...draft, title: text.slice(0, MAX_TITLE) }, SAY.askPrice);

    case 'pi_price': {
      const price = parsePrice(text);
      if (price == null) return reply('pi_price', draft, SAY.badPrice);
      if (draft.preset_condition) {
        return afterFlags({ ...draft, price, condition: draft.preset_condition, flag_index: 0 }, ctx, store);
      }
      return reply('pi_condition', { ...draft, price }, SAY.askCondition);
    }

    case 'pi_condition': {
      const condition = parseCondition(text);
      if (!condition) return reply('pi_condition', draft, SAY.badCondition);
      return afterFlags({ ...draft, condition, flag_index: 0 }, ctx, store);
    }

    case 'pi_flag': {
      const flag = draft.ask_flags?.[draft.flag_index ?? 0];
      if (!flag) return afterFlags(draft, ctx, store);
      let flags = draft.flags ?? [];
      if (YES.test(text)) flags = [...flags.filter((f) => f !== flag), flag];
      else if (NO.test(text)) flags = flags.filter((f) => f !== flag);
      else return reply('pi_flag', draft, `${FLAG_QUESTIONS[flag]}`);
      return afterFlags({ ...draft, flags, flag_index: (draft.flag_index ?? 0) + 1 }, ctx, store);
    }

    case 'pi_name': {
      const name = text.replace(/\s+/g, ' ');
      if (name.length < 1 || name.length > MAX_SELLER_NAME) return reply('pi_name', draft, SAY.badName);
      const named = { ...draft, name };
      return reply('pi_review', named, SAY.review(named, store, named.category_name));
    }

    case 'pi_review': {
      if (YES.test(text)) return confirm(draft, rules);
      if (NO.test(text)) return { state: 'idle', draft: {}, replies: [SAY.cancelled], action: null };
      return reply('pi_review', draft, SAY.reviewAgain);
    }

    default:
      return null;
  }
}

// The flag questions one at a time, then the name (unless we know it), then
// the summary.
function afterFlags(draft, ctx, store) {
  const next = draft.ask_flags?.[draft.flag_index ?? 0];
  if (next) return reply('pi_flag', draft, FLAG_QUESTIONS[next]);
  if (ctx.knownName) {
    const named = { ...draft, name: ctx.knownName };
    return reply('pi_review', named, SAY.review(named, store, named.category_name));
  }
  return reply('pi_name', draft, SAY.askName);
}

function ask(state, draft, ctx) {
  switch (state) {
    case 'pi_category':
      return SAY.badCategory(menu(ctx.categories ?? []));
    case 'pi_title':
      return SAY.askTitle(draft.title_example);
    case 'pi_price':
      return SAY.askPrice;
    case 'pi_condition':
      return SAY.askCondition;
    case 'pi_flag':
      return FLAG_QUESTIONS[draft.ask_flags?.[draft.flag_index ?? 0]] ?? SAY.yesNo;
    case 'pi_name':
      return SAY.askName;
    case 'pi_review':
      return SAY.reviewAgain;
    default:
      return SAY.askTitle(draft.title_example);
  }
}

function reply(state, draft, text) {
  return { state, draft, replies: [text], action: null };
}

function confirm(draft, rules) {
  // Belt and braces, as in lib/intake.js: a draft resumed across a deploy can
  // be missing something the flow now always collects.
  if (!draft.category || !draft.title || draft.price == null || !draft.condition) {
    return { state: 'idle', draft: {}, replies: [SAY.cancelled], action: null };
  }

  const flags = draft.flags ?? [];
  const early = draft.early ?? [];
  const { needed, optional } = shotsFor(rules, draft.category, flags);

  return {
    state: 'pi_photos',
    draft: {
      title: draft.title,
      category: draft.category,
      // The route fills in draft_id once the row exists.
      acked: early.length > 0,
    },
    replies: [SAY.photos({ needed, optional, early: early.length })],
    action: {
      type: 'create_draft',
      item: {
        category: draft.category,
        flags,
        title: draft.title,
        asking_price: draft.price,
        condition: draft.condition,
        seller_name: draft.name ?? null,
      },
      early,
    },
  };
}
