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

// "Ade", "Royal Paws Kennel", "Dave_k9": yes. "my name", "none", "test", a phone
// number, a web address: no. A lead-in such as "my name is" is taken off first,
// so "my name is Ade" is Ade and a bare "my name" is nothing. Returns the name,
// or null when it is not one. Plain rules, not a guess by a model: they are the
// same every time and cost nothing.
const NAME_LEAD = /^(?:my\s+(?:kennel\s+)?name(?:\s+is)?|(?:kennel\s+)?name(?:\s+is)?|i\s*(?:am|'m)|im|this\s+is|it'?s|call\s+me)\b[\s:,\-–]*/i;
const NOT_A_NAME = new Set([
  'none', 'nothing', 'nil', 'null', 'na', 'n a', 'nope', 'no', 'yes', 'ok', 'okay', 'skip', 'test', 'testing', 'me', 'myself',
  'i', 'you', 'anything', 'whatever', 'any', 'unknown', 'seller', 'owner', 'hello', 'hi', 'hey', 'hmm', 'asdf', 'qwerty',
  'xxx', 'abc', 'abcd', 'sample', 'example', 'dog', 'puppy', 'pet', 'sale', 'for sale', 'sell', 'private', 'anonymous',
  'nobody', 'somebody', 'someone', 'person', 'admin', 'no name', 'your name', 'my kennel', 'kennel',
]);
const FILLER_WORDS = new Set(['my', 'name', 'kennel', 'your', 'the', 'no', 'none', 'a', 'an', 'is', 'of', 'i', 'me', 'myself', 'you', 'seller', 'owner', 'person', 'unknown', 'anything', 'whatever']);

export function parseSellerName(raw) {
  const t = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(NAME_LEAD, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim();
  if (!t || t.length > MAX_NAME) return null;
  if ((t.match(/\p{L}/gu) ?? []).length < 2) return null;
  if ((t.match(/\d/g) ?? []).length >= 6) return null;
  if (/https?:|www\.|\.(com|ng|net|org)\b|@/i.test(t)) return null;
  const key = t.toLowerCase().replace(/[^\p{L}\s]/gu, '').replace(/\s+/g, ' ').trim();
  if (!key || NOT_A_NAME.has(key)) return null;
  if (key.split(' ').every((w) => FILLER_WORDS.has(w))) return null;
  if (/^(.)\1+$/u.test(key.replace(/\s/g, ''))) return null;
  return t;
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
    `Now send clear, recent photos of your ${petWord(d)} 📸 (up to ${MAX_PET_PHOTOS}). Daylight works best, and the ${petWord(d)}'s *face must be clearly visible* in at least one. Type *done* when you've sent them.`,
  noPhotos: 'Buyers need to see it. Send at least one photo 📸',
  morePhotos: (n) => (n === 1 ? 'Got it 👍 Send more, or type *done*.' : `${n} photos. Send more, or type *done*.`),
  photoLimit: `That's ${MAX_PET_PHOTOS} photos, the most we can show.`,
  checking: 'Checking your photos… 🔍',
  photosNotSaved: "I couldn't save those photos. Please send them again 📸",
  needFace: (d) =>
    `I can see your ${petWord(d)}, but not its face clearly 🐾. Please send a photo where the face is visible (eyes and nose), then type *done*.`,
  askName: 'What name should buyers see? (your name or your kennel)',
  badName: "That doesn't look like a real name 🤔. Please send your name or your kennel's name, for example *Ade* or *Royal Paws Kennel*.",
  knownName: (name) => `👤 I'll list this under *${name}*, as last time. You can change it at the summary.`,
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
      `${d.images.length} photo${d.images.length === 1 ? '' : 's'}${d.verified ? ' ✅ checked' : ''}`,
      `Seller: ${d.name}${d.nameKnown ? ' (as before)' : ''}, +${d.whatsapp}`,
    ].filter(Boolean).join('\n') +
    '\n\nReply *YES* to send it for review, *NAME* to change the seller name, or *CANCEL*.',
  reviewAgain: 'Reply *YES* to send it for review, *NAME* to change the seller name, or *CANCEL*.',
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
export function newPetListingMessage({ breed, price, listing_type, location }, { verified, note } = {}) {
  return (
    `🐾 New pet listing sent for review: *${breed}*, ` +
    (listing_type === 'adoption' ? 'for adoption' : formatNaira(price)) +
    (location ? `, ${location}` : '') +
    '. Approve it in your site admin.' +
    (verified === undefined
      ? ''
      : verified
        ? '\n\n📸 Photos checked: a real pet, face visible.'
        : `\n\n📸 Photos weren't checked automatically${note ? ` (${note})` : ''}. Look at them before approving.`)
  );
}

// To the seller, when the store approves the listing: the link, and a push to
// share it, since the seller sharing it is most of how a pet gets seen.
export function petLiveMessage({ store, breed, listing_type, url }) {
  return (
    `🎉 Good news! Your *${breed}* is now live on ${store}${listing_type === 'adoption' ? ' for adoption' : ''}.` +
    (url ? `\n\nHere is your link:\n${url}` : '') +
    '\n\n📣 Please share it! Post it on your WhatsApp Status, Instagram and Facebook, and send it to friends, family and groups. The more people see it, the faster your pet finds a home.' +
    (url ? "\n\nI'm sending a ready-made message next. Just forward it 👇" : '') +
    '\n\nBuyers will message you directly on WhatsApp. Send *SELL* to list another pet.'
  );
}

// Made to be forwarded as it stands: the picture and details come from the link's preview.
export function petShareMessage({ breed, listing_type, url }) {
  return `🐾 ${breed} ${listing_type === 'adoption' ? 'available for adoption' : 'for sale'} on PuppyPlace. See photos and details:\n${url}`;
}

// Said to somebody who rings the store's WhatsApp. The marker is what the
// once-an-hour check looks for in what was already sent.
export const NO_CALLS_MARKER = "can't take calls";

export function petNoCallsMessage({ store, browseUrl }) {
  return (
    `📵 Sorry, ${store} ${NO_CALLS_MARKER} on this number. Please send us a message here instead and we'll reply as soon as we can.\n\n` +
    'Selling a pet? Reply *SELL* and I will list it for you, free.' +
    (browseUrl ? `\n\nLooking to buy? Browse the pets for sale:\n${browseUrl}` : '')
  );
}

// To somebody who messaged the store about selling a pet before the bot was
// answering. They have to ask once more: whatever chat their reply arrives on,
// "SELL" starts the conversation there.
export function petInviteMessage({ store, browseUrl }) {
  return (
    `🐾 Hi! This is the ${store} listing assistant. Sorry we missed your message earlier. I'm switched on now.\n\n` +
    "If you'd like to sell or rehome a pet, I can list it for you here, free, in about 5 minutes: a few questions and some clear photos, with the pet's face visible.\n\n" +
    'Reply *SELL* to start 🐕' +
    (browseUrl ? `\n\nLooking to buy instead? Browse the pets for sale:\n${browseUrl}` : '')
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
      if (draft.images.length >= MAX_PET_PHOTOS) return processPhotos(draft, SAY.photoLimit);
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
      if (d.images.length >= MAX_PET_PHOTOS) return processPhotos(d);
      return reply('pet_photos', d, d.images.length ? SAY.morePhotos(d.images.length) : SAY.askPhotos(d));
    }

    case 'pet_photos':
      if (!draft.images.length) return reply('pet_photos', draft, text ? SAY.noPhotos : SAY.askPhotos(draft));
      if (FILLER.test(text) || YES.test(text)) return processPhotos(draft);
      return reply('pet_photos', draft, SAY.morePhotos(draft.images.length));

    case 'pet_name': {
      const name = parseSellerName(text);
      if (!name) return reply('pet_name', draft, SAY.badName);
      return after('pet_name', { ...draft, name, nameKnown: false }, ctx, store);
    }

    case 'pet_contact': {
      if (ctx.phone && YES.test(text)) return review({ ...draft, whatsapp: ctx.phone }, store);
      const number = normalizeNumber(text);
      if (!number) return reply('pet_contact', draft, SAY.badContact);
      return review({ ...draft, whatsapp: number }, store);
    }

    case 'pet_review':
      if (YES.test(text)) return submit(draft);
      if (/^\s*(name|change (?:the )?(?:seller )?name|edit name)\s*$/i.test(text)) return reply('pet_name', draft, SAY.askName);
      if (NO.test(text)) return { state: 'idle', draft: {}, replies: [SAY.cancelled], action: null };
      return reply('pet_review', draft, SAY.reviewAgain);

    default:
      return null;
  }
}

// The photos are saved and looked at outside this pure function (routes/waha.js)
// and the outcome comes back to petPhotosDone().
function processPhotos(draft, note) {
  return {
    state: 'pet_photos',
    draft,
    replies: [note, SAY.checking].filter(Boolean),
    action: { type: 'process_photos' },
  };
}

const KIND_WORD = { dog: 'dog', cat: 'cat', bird: 'bird', rabbit: 'rabbit', fish: 'fish', reptile: 'reptile', rodent: 'small pet', other_animal: 'pet' };
const article = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');

// Does what a photo shows fit what the seller says they are listing?
function fits(type, v) {
  if (!v.shows_pet) return false;
  if (type === 'Dog') return v.kind === 'dog';
  if (type === 'Cat') return v.kind === 'cat';
  return v.kind !== 'dog' && v.kind !== 'cat';
}

function whyNot(draft, v) {
  if (!v.shows_pet) return `it doesn't show a ${petWord(draft)}`;
  return `it looks like ${article(KIND_WORD[v.kind] ?? 'pet')} ${KIND_WORD[v.kind] ?? 'pet'}, not ${article(petWord(draft))} ${petWord(draft)}`;
}

// What came of saving and looking at the photos: images is [{ stored, v? }],
// v being { shows_pet, kind, face_visible } when a photo was looked at and
// absent when it was not (no check set up, or it could not be done).
export function petPhotosDone(draft, images, ctx = {}) {
  const store = ctx.store ?? 'the store';
  // Why the photos were not looked at, kept to tell the store with the listing.
  draft = { ...draft, checkNote: ctx.checkNote ?? undefined };
  if (!images?.length) return reply('pet_photos', { ...draft, images: [] }, SAY.photosNotSaved);

  const keep = [];
  const dropped = [];
  images.forEach((img, i) => (img.v && !fits(draft.type, img.v) ? dropped.push({ n: i + 1, v: img.v }) : keep.push(img)));
  const droppedNote = dropped.length
    ? `I left out ${dropped.length === 1 ? 'a photo' : 'some photos'}:\n` +
      dropped.map(({ n, v }) => `• Photo ${n}: ${whyNot(draft, v)}`).join('\n')
    : null;

  if (!keep.length) {
    return reply('pet_photos', { ...draft, images: [] }, droppedNote, `Please send a clear photo of your ${petWord(draft)} 📸`);
  }

  const looked = keep.filter((img) => img.v);
  // Only judged when somebody looked: with no check set up, nothing is claimed.
  if (looked.length && !looked.some((img) => img.v.face_visible)) {
    return reply('pet_photos', { ...draft, images: keep }, droppedNote, SAY.needFace(draft));
  }

  // A photo showing the face goes first: it is the one buyers see in the list.
  const ordered = looked.length ? [...keep.filter((img) => img.v?.face_visible), ...keep.filter((img) => !img.v?.face_visible)] : keep;
  const kind = looked[0] ? KIND_WORD[looked[0].v.kind] ?? 'pet' : null;
  const confirmed = kind
    ? `✅ Photos checked: I can see ${article(kind)} ${kind}, and its face is clearly visible.`
    : null;
  return after('pet_photos', { ...draft, images: ordered, verified: kind ? { kind } : undefined }, ctx, store, [droppedNote, confirmed].filter(Boolean).join('\n\n'));
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
  // The name asked last time is used again, unless the seller changes it. Only
  // when coming from the photos: a seller who has just been asked is not asked twice.
  let note = null;
  if (state === 'pet_photos' && !draft.name) {
    if (!ctx.knownName) return reply('pet_name', draft, prefix, SAY.askName);
    draft = { ...draft, name: ctx.knownName, nameKnown: true };
    note = SAY.knownName(ctx.knownName);
  }
  if (!draft.whatsapp) return reply('pet_contact', draft, prefix, note, SAY.askContact(ctx.phone));
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
      verified: Boolean(draft.verified),
      checkNote: draft.checkNote ?? null,
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
