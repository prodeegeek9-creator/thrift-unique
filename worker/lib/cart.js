import { formatNaira } from './bot.js';
import { normalizeNumber } from './phone.js';

// Checkout inside WhatsApp, on a store's own number (Growth and Business).
//
// The store's number is its real WhatsApp, full of real customers talking to
// a real person, so the bot only speaks when spoken to in its own words:
//
//   BUY <code>          adds an item (the product and store pages pre-type it,
//                       and every Status post says it)
//   a reply to a Status post that names an item, saying "I want this", "buy"
//   or similar, adds it; "how much?" or "is it still available?" gets the
//   price, whether it's still there and how to buy it; any other reply to a
//   post ("does it come in blue?") is a question for the owner
//
// then, with something in the cart: more BUY codes, REMOVE <code>, CART to
// see it, CHECKOUT, a name, a delivery address, and PAY for one Paystack link
// covering everything. CANCEL empties it. Anything else is left for the owner.
//
// Pure, like lib/bot.js and lib/intake.js: cartStep() takes the stored
// conversation and the message, and returns what to store, what to say and at
// most one thing to do. Products are looked up by the caller beforehand
// (ctx.products, by code), since this cannot reach the database.

export const MAX_ITEMS = 10;
export const CART_STALE_HOURS = 24;
export const STATES = ['cart', 'cart_name', 'cart_address', 'cart_confirm', 'cart_phone', 'cart_pay'];

const BUY = /^\s*buy\s+([a-z0-9]{4,10})\b/i;
const REMOVE = /^\s*remove\s+([a-z0-9]{4,10})\b/i;
const CHECKOUT = /^\s*(checkout|check out|done|that'?s all|pay|proceed)\b/i;
const SHOW = /^\s*(cart|my cart|basket|view cart)\s*$/i;
const CANCEL = /^\s*(cancel|stop|clear|empty( cart)?|never ?mind)\b/i;
const EDIT = /^\s*(edit|change)( address| name)?\b/i;
const PAY = /^\s*(pay|yes|ok|okay|confirm|go)\b/i;
// "I want this", "I'll take it", "buy", "order": wanting the item in a post.
const WANT = /^\s*(buy( it| this)?|i want (it|this|one)|i'?ll take (it|this)|want|order( it| this)?|add( it| this)?)\s*[.!]*\s*$/i;
// The two questions the bot can answer about an item on its own: its price,
// and whether it's still there. Only when that is the whole message: "is it
// available in size 42?" needs the owner, so the bot says nothing.
const ASK = new RegExp(
  '^\\s*(?:(?:hi|hello|pls|please|good (?:morning|afternoon|evening))[,!.\\s]+)?' +
    '(?:' +
    [
      "how much(?: is (?:it|this|that))?(?: now)?",
      "(?:what'?s |what is )?(?:the )?price(?: pls| please)?",
      'hm',
      '(?:is (?:it|this|that) )?(?:still )?(?:available|avail|in stock)',
      '(?:e |is it |it )?still dey',
      'e dey',
      '(?:is (?:it|this) )?sold(?: out)?',
      '(?:do you )?still have (?:it|this)',
    ].join('|') +
    ')\\s*(?:pls|please)?\\s*[?.!]*\\s*$',
  'i'
);

// "BUY <code>": someone asking the bot, by name, for an item. It gets an
// answer even in a chat the owner has been typing in (routes/waha.js).
export function isBuy(text) {
  return BUY.test(String(text ?? ''));
}

// The item a message is about: its own BUY code, or the code in the Status
// post (or shared link) it replies to. Status captions carry "BUY <code>" and
// the /p/<code> link.
export function codesIn(message) {
  const text = String(message?.body ?? '');
  const quoted = String(message?.quoted ?? '');
  const own = BUY.exec(text)?.[1] ?? REMOVE.exec(text)?.[1] ?? null;
  const fromQuote = /\bBUY\s+([A-Z0-9]{4,10})\b/i.exec(quoted)?.[1] ?? /\/p\/([A-Za-z0-9]{4,10})\b/.exec(quoted)?.[1] ?? null;
  return { own: own?.toUpperCase() ?? null, quoted: fromQuote?.toUpperCase() ?? null };
}

// cartStep(conversation, message, ctx) → { state, draft, replies, action } | null
//
//   ctx   { store, products: { CODE: product | null }, knownName, now }
//   null  not ours: the owner answers, and nothing is stored
//
//   action { type: 'checkout', items, name, address }   make the payment link
//          { type: 'resend' }                            send it again
//          { type: 'abandon' }                           cancel an unpaid link
export function cartStep(conversation, message, ctx = {}) {
  const store = ctx.store ?? 'the store';
  const now = ctx.now ? new Date(ctx.now) : new Date();
  const text = String(message?.body ?? '').trim();
  const { own, quoted: captioned } = codesIn(message);
  // The caller may know the item better, from the saved ID of the post being
  // replied to (status_posts).
  const quoted = ctx.quotedCode !== undefined ? ctx.quotedCode : captioned;

  const live =
    conversation && STATES.includes(conversation.state) && !stale(conversation, now) ? conversation : null;
  const draft = { items: [...(live?.draft?.items ?? [])], ...(live ? pick(live.draft) : {}) };
  const state = live?.state ?? 'idle';

  // BUY <code> works from anywhere: it is the one thing that always means this.
  // After a payment link it starts a new cart, and the unpaid link is dropped.
  const adding = (code) => {
    if (state === 'cart_pay') return { ...add({ items: [] }, ctx.products?.[code], code, store), action: { type: 'abandon' } };
    return add(draft, ctx.products?.[code], code, store);
  };
  if (own && BUY.test(text)) return adding(own);

  // A reply to a Status post about an item. Wanting it adds it, the price or
  // availability the bot can answer, and anything else is for the owner. A
  // reply to a post that isn't an item (no code, nothing saved) never gets
  // here: that's a chat with the store.
  if (quoted) {
    const product = ctx.products?.[quoted];
    if (!product) return null;
    if (WANT.test(text)) return adding(quoted);
    if (ASK.test(text)) return reply(live ? state : 'idle', draft, offer(product, quoted));
    return null;
  }

  if (!live) return null;

  if (CANCEL.test(text)) {
    return {
      state: 'idle',
      draft: {},
      replies: ['Cart emptied. Send *BUY* and an item code any time to start again.'],
      action: state === 'cart_pay' ? { type: 'abandon' } : null,
    };
  }

  if (SHOW.test(text)) return reply(state, draft, summary(draft, store) + nextHint(state));

  const removing = REMOVE.exec(text);
  if (removing && state !== 'cart_pay') {
    const code = removing[1].toUpperCase();
    const items = draft.items.filter((i) => i.code !== code);
    if (items.length === draft.items.length) return reply(state, draft, `*${code}* isn't in your cart.\n\n${summary(draft, store)}`);
    if (!items.length) return { state: 'idle', draft: {}, replies: ['Removed. Your cart is empty now.'], action: null };
    return reply('cart', { ...draft, items }, `Removed.\n\n${summary({ ...draft, items }, store)}${nextHint('cart')}`);
  }

  switch (state) {
    case 'cart':
      if (CHECKOUT.test(text)) {
        if (ctx.knownName && !draft.name) {
          return reply('cart_address', { ...draft, name: ctx.knownName }, askAddress(ctx.knownName));
        }
        return reply('cart_name', draft, "Let's check out. What name should the order be under?");
      }
      // Anything else is a conversation with the store, not the bot.
      return null;

    case 'cart_name': {
      const name = text.replace(/\s+/g, ' ');
      if (name.length < 2 || name.length > 80) return reply('cart_name', draft, 'Reply with your name.');
      return reply('cart_address', { ...draft, name }, askAddress(name));
    }

    case 'cart_address': {
      const address = text.replace(/\s+/g, ' ');
      if (address.length < 8 || address.length > 300) {
        return reply('cart_address', draft, 'Reply with the full delivery address: street, area and city.');
      }
      const next = { ...draft, address };
      return reply('cart_confirm', next, confirmation(next, store));
    }

    case 'cart_confirm':
      if (EDIT.test(text)) return reply('cart_address', draft, 'What is the delivery address?');
      if (PAY.test(text)) {
        return {
          state: 'cart_pay',
          draft,
          replies: [],
          action: { type: 'checkout', items: draft.items, name: draft.name, address: draft.address, phone: draft.phone ?? null },
        };
      }
      return reply('cart_confirm', draft, 'Reply *PAY* for your payment link, *EDIT* to change the address, or *CANCEL*.');

    // Asked only when WhatsApp hides this chat's number: the store needs one
    // to call about delivery.
    case 'cart_phone': {
      const phone = normalizeNumber(text);
      if (!phone) return reply('cart_phone', draft, 'Reply with a phone number the store can call about delivery, e.g. 08031234567.');
      const next = { ...draft, phone };
      return {
        state: 'cart_pay',
        draft: next,
        replies: [],
        action: { type: 'checkout', items: next.items, name: next.name, address: next.address, phone },
      };
    }

    case 'cart_pay':
      if (PAY.test(text) || /link/i.test(text)) return { state, draft, replies: [], action: { type: 'resend' } };
      return null;

    default:
      return null;
  }
}

// ── pieces ──────────────────────────────────────────────────────────────────

function add(draft, product, code, store) {
  if (!product) {
    return reply(draft.items.length ? 'cart' : 'idle', draft.items.length ? draft : {}, `I can't find an item with the code *${code}* at ${store}. The code is under each item and at the end of its link.`);
  }
  if (product.status !== 'active') {
    return reply(draft.items.length ? 'cart' : 'idle', draft.items.length ? draft : {}, `Sorry, *${product.title}* has sold.`);
  }
  if (draft.items.some((i) => i.code === code)) {
    return reply('cart', draft, `*${product.title}* is already in your cart.\n\n${summary(draft, store)}${nextHint('cart')}`);
  }
  if (draft.items.length >= MAX_ITEMS) {
    return reply('cart', draft, `That's ${MAX_ITEMS} items, the most one order can hold. Reply *CHECKOUT* to pay for these first.`);
  }
  const items = [...draft.items, { product_id: product.id, code, title: product.title, price: Number(product.price) }];
  const next = { ...draft, items };
  return reply('cart', next, `🛒 Added *${product.title}*, ${formatNaira(product.price)}.\n\n${summary(next, store)}${nextHint('cart')}`);
}

export function summary(draft, store) {
  if (!draft.items?.length) return 'Your cart is empty.';
  const lines = draft.items.map((i) => `• ${i.title} (${i.code}): ${formatNaira(i.price)}`);
  return `Your cart at ${store}:\n${lines.join('\n')}\n*Total: ${formatNaira(total(draft))}*`;
}

export function total(draft) {
  return (draft.items ?? []).reduce((n, i) => n + Number(i.price || 0), 0);
}

function nextHint(state) {
  if (state === 'cart') {
    return '\n\nSend *BUY* and another code to add more, or reply *CHECKOUT* to pay. (*REMOVE* and a code takes one out, *CANCEL* empties the cart.)';
  }
  if (state === 'cart_pay') return '\n\nReply *PAY* if you need the payment link again.';
  return '';
}

function offer(product, code) {
  if (product.status !== 'active') return `Sorry, *${product.title}* has sold.`;
  return `*${product.title}* is ${formatNaira(product.price)}, and it's still available. Reply *BUY ${code}* to order it.`;
}

function askAddress(name) {
  return `Thanks, ${name.split(' ')[0]}. What's the delivery address? (Street, area and city.)`;
}

function confirmation(draft, store) {
  return (
    `${summary(draft, store)}\n\n` +
    `Name: ${draft.name}\nDeliver to: ${draft.address}\n\n` +
    'Reply *PAY* for your payment link, *EDIT* to change the address, or *CANCEL*.'
  );
}

export const ASK_PHONE = 'What phone number should the store call about delivery? (e.g. 08031234567)';

export function paymentLinkMessage({ url, total: amount, count, escrow }) {
  return (
    `💳 Pay ${formatNaira(amount)} for ${count} item${count === 1 ? '' : 's'} here:\n${url}\n\n` +
    (escrow
      ? 'Your payment is protected: the store is only paid once you confirm your items arrived.'
      : 'Card, bank transfer or USSD, through Paystack.') +
    '\n\nReply *PAY* if you need this link again.'
  );
}

function reply(state, draft, text) {
  return { state, draft: state === 'idle' ? {} : draft, replies: [text], action: null };
}

function pick(d = {}) {
  const out = {};
  for (const k of ['name', 'address', 'phone', 'cart_ref', 'pay_url']) if (d[k] != null) out[k] = d[k];
  return out;
}

function stale(conversation, now) {
  const then = new Date(conversation.updated_at ?? 0).getTime();
  return Number.isFinite(then) && then > 0 && now.getTime() - then > CART_STALE_HOURS * 3_600_000;
}
