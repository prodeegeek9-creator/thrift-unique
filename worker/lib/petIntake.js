// Taking in a dog (or another pet) somebody wants to sell or rehome, for a
// store that lists pets on its own site rather than on Vendwyze — PuppyPlace,
// the first. The store switches it on with the `pet_listings` flag; the
// listing is handed to that site's API (routes/waha.js, forwardPetListing)
// and never becomes a Vendwyze submission or product.
//
// Like lib/intake.js the bot is quiet by default: it answers only somebody
// who wants to sell or rehome a pet, and leaves buyers and everybody else to
// the store. Pure: petIntakeStep() takes the stored conversation and the
// message, and returns what to store, what to say and at most one thing to do.

import { CANCEL, FILLER, YES, NO, parsePrice, formatNaira, imageFrom, staleness } from './bot.js';
import { normalizeNumber } from './phone.js';

// The pet site's limit, not lib/bot.js's MAX_IMAGES: buyers want to see a
// litter, and the site stores up to six.
export const MAX_PET_PHOTOS = 6;
const MAX_BREED = 80;
const MAX_AGE = 40;
const MAX_LOCATION = 80;
const MAX_NOTES = 600;
const MAX_NAME = 80;

const PET_WORD = /\b(dogs?|pupp(y|ies)|pups?|pets?|cats?|kittens?|birds?|parrots?|rabbits?|bunn(y|ies)|litter)\b/i;
// SELL at the start, as on every store; or somebody saying, in their own words,
// that they want to sell or rehome a pet: "Hi, I want to sell my dog". It has
// to be them selling — "do you sell puppies?" is a buyer and is left alone.
const SELL_START = /^\s*(sell|rehome)\b/i;
const FIRST_PERSON_SELL = /\b(i|i'm|im|i'd|we|we're|my)\b[^.?!]{0,40}\b(sell|selling|rehome|rehoming|give away|giving away|list)\b/i;

export function wantsToSellPet(text) {
  const t = String(text ?? '');
  return SELL_START.test(t) || (FIRST_PERSON_SELL.test(t) && PET_WORD.test(t));
}

export const PET_STATES = [
  'pet_type', 'pet_breed', 'pet_age', 'pet_deal', 'pet_price', 'pet_location',
  'pet_health', 'pet_notes', 'pet_photos', 'pet_name', 'pet_contact', 'pet_review',
];

const TYPES = [
  ['Dog', /^(1|dogs?|pupp(y|ies)|pups?)\b/i],
  ['Cat', /^(2|cats?|kittens?)\b/i],
  ['Other', /^(3|other|bird|parrot|rabbit|bunny|fish|guinea|reptile|snake|tortoise)\b/i],
];
const HEALTH = [
  [{ vaccinated: true, dewormed: true }, /^(1|both|yes|vaccinated and dewormed)\b/i],
  [{ vaccinated: true, dewormed: false }, /^(2|vaccinated)\b/i],
  [{ vaccinated: false, dewormed: true }, /^(3|dewormed)\b/i],
  [{ vaccinated: false, dewormed: false }, /^(4|neither|none|no|not yet)\b/i],
];
const SKIP = /^(skip|no|none|nothing|nil|n\/a)\b/i;

const petWord = (draft) => (draft.type === 'Cat' ? 'cat' : draft.type === 'Dog' ? 'dog' : 'pet');

const SAY = {
  start: (store) =>
    `🐾 Hi! I'm the ${store} listing assistant. I'll help you list your pet for sale or adoption — it's free.\n\n` +
    'It takes a few quick questions and some photos. Reply *cancel* any time.',
  askType: 'What are you listing?\n\n1 Dog\n2 Cat\n3 Another pet\n\nReply with the number.',
  badType: 'Reply 1 for a dog, 2 for a cat or 3 for another pet.',
  askBreed: (d) => `What breed is your ${petWord(d)}? (e.g. Boerboel, German Shepherd, or "mixed")`,
  askAge: (d) => `How old is your ${petWord(d)}? (e.g. 10 weeks, 2 years)`,
  askDeal:
    'Are you selling or giving it up for adoption?\n\n1 Selling\n2 Adoption (free to a good home)\n\nReply with the number.',
  badDeal: 'Reply 1 if you are selling, or 2 for adoption.',
  askPrice: 'How much are you asking? (e.g. 150000 or 150k). For a litter, the price per puppy.',
  badPrice: "I didn't catch a price. Send the amount on its own — 150000, or 150k.",
  askLocation: 'Which city and area are you in? (e.g. Lekki, Lagos)',
  askHealth:
    'Vaccinations and deworming:\n\n1 Vaccinated and dewormed\n2 Vaccinated only\n3 Dewormed only\n4 Neither yet\n\nReply with the number.',
  badHealth: 'Reply with 1, 2, 3 or 4.',
  askNotes:
    'Anything else buyers should know? Sex, colour, temperament, papers, how many in the litter…\n\nReply *skip* to leave it out.',
  askPhotos: (d) =>
    `Now send clear, recent photos of your ${petWord(d)} 📸 (up to ${MAX_PET_PHOTOS}). Daylight works best. Type *done* when you've sent them.`,
  noPhotos: 'Buyers need to see it. Send at least one photo 📸',
  morePhotos: (n) => (n === 1 ? 'Got it 👍 Send more, or type *done*.' : `${n} photos. Send more, or type *done*.`),
  photoLimit: `That's ${MAX_PET_PHOTOS} photos, the most we can show.`,
  askName: 'What name should buyers see? (your name or your kennel)',
  badName: `Reply with a name, up to ${MAX_NAME} characters.`,
  askContact: (phone) =>
    phone
      ? `Buyers will message you on WhatsApp at +${phone}. Reply *YES*, or send the number they should use instead.`
      : 'Which WhatsApp number should buyers message you on?',
  badContact: 'That doesn\'t look like a phone number. Send it like 0803 123 4567.',
  review: (d, store) =>
    `Here's your listing for ${store}:\n\n` +
    [
      `*${d.breed}* (${d.type === 'Other' ? 'pet' : d.type.toLowerCase()}), ${d.age}`,
      d.listing_type === 'adoption' ? 'For adoption' : `Price: ${formatNaira(d.price)}`,
      `📍 ${d.location}`,
      healthLine(d),
      d.notes ? `Notes: ${d.notes}` : null,
      `${d.images.length} photo${d.images.length === 1 ? '' : 's'}`,
      `Seller: ${d.name}, +${d.whatsapp}`,
    ].filter(Boolean).join('\n') +
    '\n\nReply *YES* to send it for review, or *CANCEL*.',
  reviewAgain: 'Reply *YES* to send it for review, or *CANCEL*.',
  cancelled: 'Cancelled. Nothing was sent. Message *SELL* any time to list a pet.',
};

function healthLine(d) {
  if (d.vaccinated && d.dewormed) return '💉 Vaccinated and dewormed';
  if (d.vaccinated) return '💉 Vaccinated';
  if (d.dewormed) return 'Dewormed';
  return 'Not yet vaccinated or dewormed';
}

export function petSentMessage(store) {
  return (
    `✅ Sent! ${store} will check your listing and publish it soon. Buyers will message you directly on WhatsApp.\n\n` +
    'Send *SELL* to list another pet.'
  );
}

// When the site could not be reached or turned the listing down for a reason
// that is not about the listing. The seller is told to try again; the owner is
// told why, because it is theirs to fix.
export const PET_RETRY_MESSAGE =
  "Something went wrong sending that, but I've kept your answers. Reply *YES* to try again, or *CANCEL*.";

const HINTS = {
  401: 'The key does not match. PET_LISTINGS_KEY here and SELLER_API_KEY on the site must be the same value.',
  403: "The site's firewall blocked the request (Cloudflare bot protection or a WAF rule).",
  404: 'The address is wrong, or the site has not been deployed with /api/seller-listings.',
  503: 'The site is not set up for listings: SELLER_API_KEY is missing there.',
};

// status is null when the site never answered.
export function petFailedOwnerMessage({ breed, status, reason }) {
  const what = status ? `HTTP ${status}${reason ? ` (${reason})` : ''}` : 'no answer from the site';
  const hint = status ? HINTS[status] ?? (status >= 500 ? 'The site had an error saving it.' : null) : "Check PET_LISTINGS_URL, and that the site is up.";
  return (
    `⚠️ A ${breed ?? 'pet'} listing could not be sent to the site: ${what}.` +
    (hint ? `\n\n${hint}` : '') +
    '\n\nThe seller was told to reply YES to try again.'
  );
}

export function petRejectedMessage(details) {
  const lines = ["I couldn't send that listing:"];
  for (const d of details ?? []) lines.push(`• ${d}`);
  lines.push('', 'Send *SELL* to start again.');
  return lines.join('\n');
}

// For the store owner, on the platform number.
export function newPetListingMessage({ breed, price, listing_type, location }) {
  return (
    `🐾 New pet listing sent for review: *${breed}*, ` +
    (listing_type === 'adoption' ? 'for adoption' : formatNaira(price)) +
    (location ? `, ${location}` : '') +
    '. Approve it in your site admin.'
  );
}

// petIntakeStep(conversation, message, ctx) → { state, draft, replies, action } | null
//
//   ctx       { store, phone, now }  phone: the chat's own number, digits only
//   null      not ours: nobody asked to sell a pet and nothing is in progress
//   action    { type: 'pet_listing', listing: {…}, images: [{ url, mimetype }] }
export function petIntakeStep(conversation, message, ctx = {}) {
  const store = ctx.store ?? 'the store';
  const live =
    conversation && PET_STATES.includes(conversation.state) && !staleness(conversation, ctx)
      ? conversation
      : null;

  const text = String(message?.body ?? '').trim();
  const image = imageFrom(message);

  if (!live) {
    if (!wantsToSellPet(text)) return null;
    const type = typeIn(text);
    const draft = { images: image ? [image] : [], ...(type ? { type } : {}) };
    return reply(type ? 'pet_breed' : 'pet_type', draft, SAY.start(store), type ? SAY.askBreed(draft) : SAY.askType);
  }

  const draft = { ...(live.draft ?? {}), images: [...(live.draft?.images ?? [])] };

  if (CANCEL.test(text)) return { state: 'idle', draft: {}, replies: [SAY.cancelled], action: null };

  // A photo is welcome at any point before the summary.
  if (image && live.state !== 'pet_review') {
    if (draft.images.length >= MAX_PET_PHOTOS) {
      if (draft.limit_noted) return { state: live.state, draft, replies: [], action: null };
      return next(live.state, { ...draft, limit_noted: true }, SAY.photoLimit, ctx, store);
    }
    draft.images.push(image);
    if (live.state === 'pet_photos') {
      if (draft.images.length >= MAX_PET_PHOTOS) return after('pet_photos', draft, ctx, store, SAY.photoLimit);
      return reply('pet_photos', draft, SAY.morePhotos(draft.images.length));
    }
    return next(live.state, draft, '📸 Photo saved.', ctx, store);
  }

  switch (live.state) {
    case 'pet_type': {
      const type = typeIn(text, true);
      if (!type) return reply('pet_type', draft, SAY.badType);
      const d = { ...draft, type };
      return reply('pet_breed', d, SAY.askBreed(d));
    }

    case 'pet_breed':
      if (!text || wantsToSellPet(text)) return reply('pet_breed', draft, SAY.askBreed(draft));
      return reply('pet_age', { ...draft, breed: text.replace(/\s+/g, ' ').slice(0, MAX_BREED) }, SAY.askAge(draft));

    case 'pet_age':
      if (!text) return reply('pet_age', draft, SAY.askAge(draft));
      return reply('pet_deal', { ...draft, age: text.replace(/\s+/g, ' ').slice(0, MAX_AGE) }, SAY.askDeal);

    case 'pet_deal': {
      if (/^(1|sell|selling|sale)\b/i.test(text)) return reply('pet_price', { ...draft, listing_type: 'sale' }, SAY.askPrice);
      if (/^(2|adopt|adoption|free|rehome|rehoming|give)/i.test(text)) {
        return reply('pet_location', { ...draft, listing_type: 'adoption', price: null }, SAY.askLocation);
      }
      return reply('pet_deal', draft, SAY.badDeal);
    }

    case 'pet_price': {
      const price = parsePrice(text);
      if (price == null) return reply('pet_price', draft, SAY.badPrice);
      return reply('pet_location', { ...draft, price }, SAY.askLocation);
    }

    case 'pet_location':
      if (text.length < 2) return reply('pet_location', draft, SAY.askLocation);
      return reply('pet_health', { ...draft, location: text.replace(/\s+/g, ' ').slice(0, MAX_LOCATION) }, SAY.askHealth);

    case 'pet_health': {
      const found = HEALTH.find(([, re]) => re.test(text));
      if (!found) return reply('pet_health', draft, SAY.badHealth);
      return reply('pet_notes', { ...draft, ...found[0] }, SAY.askNotes);
    }

    case 'pet_notes': {
      if (!text) return reply('pet_notes', draft, SAY.askNotes);
      const d = { ...draft, notes: SKIP.test(text) ? null : text.slice(0, MAX_NOTES) };
      // Photos sent earlier in the chat already count.
      if (d.images.length >= MAX_PET_PHOTOS) return after('pet_photos', d, ctx, store);
      return reply('pet_photos', d, d.images.length ? SAY.morePhotos(d.images.length) : SAY.askPhotos(d));
    }

    case 'pet_photos':
      if (!draft.images.length) return reply('pet_photos', draft, text ? SAY.noPhotos : SAY.askPhotos(draft));
      if (FILLER.test(text) || YES.test(text)) return after('pet_photos', draft, ctx, store);
      return reply('pet_photos', draft, SAY.morePhotos(draft.images.length));

    case 'pet_name': {
      const name = text.replace(/\s+/g, ' ');
      if (name.length < 1 || name.length > MAX_NAME) return reply('pet_name', draft, SAY.badName);
      return after('pet_name', { ...draft, name }, ctx, store);
    }

    case 'pet_contact': {
      if (ctx.phone && YES.test(text)) return review({ ...draft, whatsapp: ctx.phone }, store);
      const number = normalizeNumber(text);
      if (!number) return reply('pet_contact', draft, SAY.badContact);
      return review({ ...draft, whatsapp: number }, store);
    }

    case 'pet_review':
      if (YES.test(text)) return submit(draft);
      if (NO.test(text)) return { state: 'idle', draft: {}, replies: [SAY.cancelled], action: null };
      return reply('pet_review', draft, SAY.reviewAgain);

    default:
      return null;
  }
}

function typeIn(text, answer = false) {
  if (answer) return (TYPES.find(([, re]) => re.test(text.trim())) || [])[0] ?? null;
  // From the opening message: "I want to sell my puppies" already says.
  if (/\b(dogs?|pupp(y|ies)|pups?)\b/i.test(text)) return 'Dog';
  if (/\b(cats?|kittens?)\b/i.test(text)) return 'Cat';
  return null;
}

// What follows a finished step, skipping what is already known.
function after(state, draft, ctx, store, prefix) {
  const order = ['pet_photos', 'pet_name', 'pet_contact'];
  for (const s of order.slice(order.indexOf(state) + 1)) {
    if (s === 'pet_name' && !draft.name) return reply('pet_name', draft, prefix, SAY.askName);
    if (s === 'pet_contact') return reply('pet_contact', draft, prefix, SAY.askContact(ctx.phone));
  }
  return review(draft, store);
}

// Re-ask the current question, after a note.
function next(state, draft, note, ctx, store) {
  const question = {
    pet_type: SAY.askType,
    pet_breed: SAY.askBreed(draft),
    pet_age: SAY.askAge(draft),
    pet_deal: SAY.askDeal,
    pet_price: SAY.askPrice,
    pet_location: SAY.askLocation,
    pet_health: SAY.askHealth,
    pet_notes: SAY.askNotes,
    pet_photos: 'Type *done* to carry on.',
    pet_name: SAY.askName,
    pet_contact: SAY.askContact(ctx.phone),
  }[state];
  return reply(state, draft, note, question);
}

function review(draft, store) {
  return reply('pet_review', draft, SAY.review(draft, store));
}

function reply(state, draft, ...texts) {
  return { state, draft, replies: texts.filter(Boolean), action: null };
}

function submit(draft) {
  // Belt and braces: a draft resumed across a deploy can be missing a field
  // the flow now always collects.
  const complete =
    draft.images?.length && draft.type && draft.breed && draft.age && draft.listing_type &&
    (draft.listing_type === 'adoption' || draft.price != null) && draft.location && draft.name && draft.whatsapp;
  if (!complete) {
    return { state: 'pet_type', draft: { images: draft.images ?? [] }, replies: [SAY.askType], action: null };
  }

  return {
    state: 'idle',
    draft: {},
    replies: [],
    action: {
      type: 'pet_listing',
      // Kept so a failure that is ours, not the seller's, can put them back at
      // the summary instead of making them answer everything again.
      draft,
      listing: {
        type: draft.type,
        breed: draft.breed,
        age: draft.age,
        listing_type: draft.listing_type,
        price: draft.listing_type === 'sale' ? draft.price : null,
        location: draft.location,
        vaccinated: Boolean(draft.vaccinated),
        dewormed: Boolean(draft.dewormed),
        description: draft.notes ?? null,
        seller_name: draft.name,
        whatsapp: draft.whatsapp,
      },
      images: draft.images,
    },
  };
}
