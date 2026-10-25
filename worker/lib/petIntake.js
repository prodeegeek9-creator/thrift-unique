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
// A seller who has gone to take the photos ("later, it's dark now") keeps their
// answers this long, instead of the usual few hours.
export const PHOTOS_WAIT_HOURS = 48;
const MAX_BREED = 40;
const MAX_AGE = 40;
const MAX_LOCATION = 80;
const MAX_NOTES = 600;
const MAX_NAME = 80;

const PET_WORD = /\b(dogs?|pupp(y|ies)|pups?|pets?|cats?|kittens?|birds?|parrots?|rabbits?|bunn(y|ies)|litter)\b/i;
// SELL at the start, as on every store; or somebody saying, in their own words,
// that they want to sell or rehome a pet: "Hi, I want to sell my dog". It has
// to be them selling — "do you sell puppies?" is a buyer and is left alone.
const SELL_START = /^\s*(sell|rehome)\b/i;
const GREETING = /^\s*(hi|hello|hey|good (morning|afternoon|evening))\b/i;
// "List" only as listing something: "list my dog", not "the food list".
const FIRST_PERSON_SELL = /\b(i|i'm|im|i'd|we|we're|my)\b[^.?!]{0,40}\b(sell|selling|rehome|rehoming|give away|giving away|list\s+(?:my|our|a|the|this|these|her|him|them|it))\b/i;

// "I'd like to sell on PuppyPlace" (the Sell page's own WhatsApp button names no
// pet), "I have Boerboel puppies for sale", "does your pet store buy puppies?".
// Still never "do you have puppies for sale?" or "do you sell puppies?": buyers.
const SELL_HERE = /\b(sell|list|post|advertise)\b[^.?!]{0,25}\b(on|with|through|via)\s+(puppy\s*place|your\s+(site|website|store|shop|platform|page|app))\b/i;
const FIRST_PERSON_FOR_SALE = /\b((i|we)\s+(have|got)|i'?ve|we'?ve)\b[^.?!]{0,50}\b(for sale|available|to sell)\b|\bmy\b[^.?!]{0,40}\b(is|are)\s+(for sale|available)\b/i;
const DO_YOU_BUY = /\b(do|does|can|will|would)\s+(you|your(\s+\w+){1,2})\s+(buy|take in|accept|help (me )?sell)\b/i;

export function wantsToSellPet(text) {
  const t = String(text ?? '');
  if (SELL_START.test(t) || SELL_HERE.test(t)) return true;
  if (!PET_WORD.test(t)) return false;
  return FIRST_PERSON_SELL.test(t) || FIRST_PERSON_FOR_SALE.test(t) || DO_YOU_BUY.test(t);
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
  // Typed while the bot was still busy with the photos, or a word sent on its own.
  'done', 'or', 'and', 'thanks', 'thank you', 'tq', 'later', 'wait',
]);
const FILLER_WORDS = new Set([
  'my', 'name', 'kennel', 'your', 'the', 'no', 'none', 'a', 'an', 'is', 'of', 'i', 'me', 'myself', 'you', 'seller', 'owner',
  'person', 'unknown', 'anything', 'whatever', 'brand', 'business', 'shop', 'store', 'company', 'or', 'and',
]);
// "Zoe is her name", "her name is Zoe": the pet's name, which sellers often give
// when asked for theirs. Kept as the pet's name, and theirs is asked for again.
const PET_NAMED = /^\s*([\p{L}][\p{L}'’-]{1,30})\s+is\s+(?:her|his|its|their|the\s+(?:dog|puppy|pet|cat|kitten)'?s?|the\s+pet)\s+name\b/iu;
const NAMED_PET = /\b(?:her|his|its|the\s+(?:dog|puppy|pet|cat|kitten)'?s?)\s+name\s+is\s+([\p{L}][\p{L}'’-]{1,30})/iu;
const PET_NAME_TALK = /\b(?:her|his|its|the\s+(?:dog|puppy|pet|cat|kitten)'?s?|pet'?s?)\s+name\b/i;
// "Can I use my kennel name?" is a question, not a name. "Will Smith" and "May" are names.
const NAME_QUESTION = /\?|^\s*(can|could|should|do|does|how|what|when|where|why|is|are|will|may)\s+(i|you|we|it|my|the|this|that|they|he|she)\b/i;

export function petNameIn(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ');
  const m = PET_NAMED.exec(s) ?? NAMED_PET.exec(s);
  return m ? capitalise(m[1]) : null;
}

// "remina" → "Remina", "golden kennels" → "Golden Kennels"; anything with a
// capital in it is left as the seller wrote it.
function capitalise(s) {
  return s === s.toLowerCase() ? s.replace(/(^|\s)(\p{L})/gu, (_, a, b) => a + b.toUpperCase()) : s;
}

export function parseSellerName(raw) {
  let s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  // "Raya is the pet name, my name is Remina": the part that is theirs.
  const mine = /\bmy\s+name\s+is\s+(.+)$/i.exec(s);
  if (mine && mine.index > 0) s = mine[1];
  else if (PET_NAME_TALK.test(s) || PET_NAMED.test(s)) return null;
  if (NAME_QUESTION.test(s)) return null;
  const t = s
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
  return capitalise(t);
}

export const PET_STATES = [
  'pet_type', 'pet_breed', 'pet_age', 'pet_deal', 'pet_price', 'pet_location',
  'pet_health', 'pet_notes', 'pet_photos', 'pet_breed_confirm', 'pet_name', 'pet_contact', 'pet_fix', 'pet_review',
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
// Somebody who has nothing (more) to list, answering the first question.
const NOT_NOW = /^\s*(done|no|nope|nothing|that'?s all|i'?m done|sorry|ok(ay)?|thanks?|thank you|not now|later)\b/i;

// Breeds as people write them, for picking one out of a sentence. A short answer
// is kept as the seller typed it; this is only for "I have a purebred Eskimo
// puppy and I'm looking for a buyer…". Canonical name first, then other spellings.
const BREEDS = [
  ['Boerboel', 'boerbull', 'boer boel'], ['German Shepherd', 'alsatian', 'gsd', 'german shepard'], ['Rottweiler', 'rottie', 'rott'],
  ['Caucasian Shepherd', 'caucasian', 'caucasian ovcharka'], ['Lhasa Apso', 'lhasa', 'lasa apso'], ['Shih Tzu', 'shihtzu', 'shih-tzu'],
  ['Chihuahua'], ['American Eskimo', 'eskimo', 'american eskimo dog'], ['Samoyed'], ['Siberian Husky', 'husky'], ['Alaskan Malamute', 'malamute'],
  ['Pomeranian', 'pom'], ['Poodle', 'toy poodle'], ['Maltese'], ['Yorkshire Terrier', 'yorkie'], ['American Pit Bull Terrier', 'pitbull', 'pit bull'],
  ['American Bully', 'bully'], ['Bullmastiff', 'bull mastiff'], ['Cane Corso'], ['Doberman', 'dobermann', 'doberman pinscher'],
  ['Golden Retriever', 'golden'], ['Labrador Retriever', 'labrador', 'lab'], ['Great Dane'], ['Dachshund', 'sausage dog'], ['Pug'],
  ['English Bulldog', 'bulldog'], ['French Bulldog', 'frenchie'], ['Beagle'], ['Jack Russell Terrier', 'jack russell'], ['Chow Chow', 'chow'],
  ['Shar Pei', 'sharpei'], ['Akita'], ['Dalmatian'], ['Belgian Malinois', 'malinois'], ['Basenji'], ['Bichon Frise', 'bichon'],
  ['Cocker Spaniel'], ['Border Collie'], ['Tibetan Mastiff'], ['Neapolitan Mastiff'], ['English Mastiff', 'mastiff'], ['Kangal'],
  ['Dogo Argentino'], ['Presa Canario'], ['Mixed', 'mixed breed', 'mix', 'cross', 'crossbreed', 'local', 'mongrel'],
  ['Persian'], ['Siamese'], ['Maine Coon'], ['British Shorthair'], ['Ragdoll'], ['Bengal'], ['Sphynx'], ['Scottish Fold'], ['Himalayan'],
];
const BREED_ALIASES = BREEDS.flatMap(([name, ...more]) => [name, ...more].map((a) => [a.toLowerCase(), name]))
  .sort((a, b) => b[0].length - a[0].length);
const SENTENCE = /[.?!]\s+\S|\b(please|would|like|enquiry|inquiry|looking|buyer|help|interested|i have|i'm|i am|want|wanna|selling|sell)\b/i;
const TRAILING_PET = /\s+(pupp(y|ies)|pups?|dogs?|kittens?|cats?|breed)$/i;

// "Boerboel" → Boerboel. "Eskimo puppy" → Eskimo. A sentence → the breed named in
// it, or null when none can be found (the seller is asked again).
const shortAnswer = (t) => t.length <= MAX_BREED && t.split(' ').length <= 4 && !SENTENCE.test(t);

export function parseBreed(raw) {
  const t = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (shortAnswer(t)) {
    const short = t.replace(TRAILING_PET, '').trim();
    if (/^(pupp(y|ies)|pups?|dogs?|cats?|kittens?|pets?|breed|purebred|pure ?breed)$/i.test(short)) return null;
    return (short.match(/\p{L}/gu) ?? []).length >= 2 ? short : null;
  }
  const low = ` ${t.toLowerCase().replace(/[^\p{L}\s-]/gu, ' ').replace(/\s+/g, ' ')} `;
  const hit = BREED_ALIASES.find(([alias]) => low.includes(` ${alias} `));
  return hit ? hit[1] : null;
}

// Every breed a message names, longest spelling first so "Labrador" is not also a "lab".
export function breedsNamedIn(raw) {
  let low = ` ${String(raw ?? '').toLowerCase().replace(/[^\p{L}\s-]/gu, ' ').replace(/\s+/g, ' ')} `;
  const found = [];
  for (const [alias, name] of BREED_ALIASES) {
    if (!low.includes(` ${alias} `)) continue;
    if (!found.includes(name)) found.push(name);
    low = low.split(` ${alias} `).join('  ');
  }
  return found;
}

// ── TIDYING ANSWERS AS THEY COME, AT NO COST ─────────────────────────────────
// Put right what can be put right without asking: "Chihuahuas" is a Chihuahua,
// "28weeks" is 28 weeks, "My dogs are 7 months old" is 7 months, "Port Hacourt"
// is Port Harcourt.

// A known breed named on its own, plural or lower case, is written its usual way.
// Words for a mix ("local", "cross") are kept as the seller wrote them.
const MIX_NAMES = new Set(['Mixed']);
export function tidyBreed(raw) {
  const t = String(raw ?? '').replace(/\s+/g, ' ').trim();
  const bare = t.toLowerCase().replace(/[^\p{L}\s-]/gu, '').replace(/\b(pure\s*bred|purebred|pure\s*breed|pedigree|full\s*blood)\b/g, '').replace(/\s+/g, ' ').trim();
  for (const form of [bare, bare.replace(/(es|s)$/, ''), bare.replace(/s$/, '')]) {
    const hit = BREED_ALIASES.find(([alias]) => alias === form);
    if (hit && !MIX_NAMES.has(hit[1])) return hit[1];
  }
  return t === t.toLowerCase() ? t.replace(/(^|\s)(\p{L})/gu, (_, a, b) => a + b.toUpperCase()) : t;
}

const AGE_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, a: 1, an: 1, half: 0.5 };
const AGE_UNIT = [[/^(weeks?|wks?|wk)$/i, 'week'], [/^(months?|mo?n?ths?|mnts?|mons?|mos?)$/i, 'month'], [/^(years?|yrs?|yr)$/i, 'year'], [/^(days?|dys?)$/i, 'day']];
const AGE_IN = /(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|an?|half)\s*(?:(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*)?(weeks?|wks?|wk|months?|mo?n?ths?|mnts?|mons?|mos?|years?|yrs?|yr|days?|dys?)\b(\s*(?:plus|\+))?/i;
// "28weeks" → "28 weeks", "My dogs are 7 months old" → "7 months", "1-3months" → "1-3 months".
export function tidyAge(raw) {
  const t = String(raw ?? '').replace(/\s+/g, ' ').trim();
  const m = AGE_IN.exec(t);
  if (!m) return t;
  const n = m[1].toLowerCase() in AGE_WORDS ? AGE_WORDS[m[1].toLowerCase()] : Number(m[1]);
  const unit = AGE_UNIT.find(([re]) => re.test(m[3]))[1];
  const many = m[2] ? true : n !== 1;
  return `${m[2] ? `${n}-${m[2]}` : n}${m[4] ? '+' : ''} ${unit}${many ? 's' : ''}`;
}

// Nigerian cities sellers are in, with their state, to put a misspelt one right
// ("Port Hacourt", "Ibadann") and write "Rivers state Port Harcourt" as
// "Port Harcourt, Rivers". Anything else is kept as the seller wrote it.
const CITIES = [
  ['Lagos', 'Lagos'], ['Abuja', 'FCT'], ['Port Harcourt', 'Rivers'], ['Ibadan', 'Oyo'], ['Benin City', 'Edo'], ['Kano', 'Kano'],
  ['Kaduna', 'Kaduna'], ['Enugu', 'Enugu'], ['Jos', 'Plateau'], ['Ilorin', 'Kwara'], ['Abeokuta', 'Ogun'], ['Akure', 'Ondo'],
  ['Owerri', 'Imo'], ['Uyo', 'Akwa Ibom'], ['Calabar', 'Cross River'], ['Warri', 'Delta'], ['Asaba', 'Delta'], ['Onitsha', 'Anambra'],
  ['Awka', 'Anambra'], ['Osogbo', 'Osun'], ['Ado Ekiti', 'Ekiti'], ['Makurdi', 'Benue'], ['Minna', 'Niger'], ['Lokoja', 'Kogi'],
  ['Ogbomosho', 'Oyo'], ['Ijebu Ode', 'Ogun'], ['Sagamu', 'Ogun'], ['Nsukka', 'Enugu'], ['Aba', 'Abia'], ['Umuahia', 'Abia'],
  ['Abakaliki', 'Ebonyi'], ['Bauchi', 'Bauchi'], ['Maiduguri', 'Borno'], ['Sokoto', 'Sokoto'], ['Yola', 'Adamawa'], ['Ikeja', 'Lagos'],
  ['Lekki', 'Lagos'], ['Ikorodu', 'Lagos'], ['Mowe', 'Ogun'], ['Ota', 'Ogun'],
];
const STATE_WORDS = new Set(['state', 'city', 'nigeria', ...CITIES.flatMap(([, st]) => st.toLowerCase().split(' '))]);

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

export function tidyPlace(raw) {
  let t = String(raw ?? '').replace(/\s+/g, ' ').trim();
  const words = t.split(' ');
  let found = null;
  // Each run of one to three words against each city; a near miss on a name
  // long enough to judge is put right, an exact one only recognised.
  for (let i = 0; i < words.length && !found; i++) {
    for (let len = 3; len >= 1 && !found; len--) {
      const span = words.slice(i, i + len).join(' ');
      if (words.length < i + len) continue;
      const key = span.toLowerCase().replace(/[^\p{L}\s]/gu, '');
      for (const [city, state] of CITIES) {
        const c = city.toLowerCase();
        const near = key === c ? 0 : c.length >= 6 && Math.abs(key.length - c.length) <= 2 ? editDistance(key, c) : 9;
        if (near <= (c.length >= 9 ? 2 : 1)) { found = { i, len, city, state, span }; break; }
      }
    }
  }
  if (!found) return t;
  const rest = [...words.slice(0, found.i), ...words.slice(found.i + found.len)].map((w) => w.toLowerCase().replace(/[^\p{L}]/gu, ''));
  // Only the city and its state (or "state"): written the usual way.
  if (rest.every((w) => !w || STATE_WORDS.has(w))) return found.city === found.state || found.state === 'FCT' ? found.city : `${found.city}, ${found.state}`;
  return t.replace(found.span, found.span.replace(/[\p{L}\s]+/u, found.city));
}

// A breeder's whole list ("Boerboel, Eskimo, Husky, Rottweiler…") rather than this
// listing's breed. A cross ("Rottweiler and Boerboel mix") is one dog, and a short
// answer is kept as typed.
function severalBreeds(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (shortAnswer(t) || /\b(mix|mixed|cross|crossbreed|crossed|x)\b/i.test(t)) return null;
  const named = breedsNamedIn(t).filter((b) => b !== 'Mixed');
  return named.length >= 2 ? named : null;
}

// A seller who does not know the breed: the photos are asked instead.
const UNSURE = /^\s*(i\s*(do\s*n[o']?t|dont)\s*know|idk|not sure|no idea|unknown|unsure|don'?t know|\?+)\s*[.!]*\s*$/i;
const BREED_FILLER = /\b(pure\s*bred|purebred|pure|pedigree|full\s*blood|breed|pupp(y|ies)|pups?|dogs?|cats?|kittens?)\b/gi;

// One name for a breed, however it was written: "Alsatian" and "German
// Shepherd" are one, "Eskimo" and "American Eskimo" are one.
function breedKey(name) {
  const low = ` ${String(name ?? '').toLowerCase().replace(/[^\p{L}\s-]/gu, ' ').replace(/\s+/g, ' ')} `;
  const hit = BREED_ALIASES.find(([alias]) => low.includes(` ${alias} `));
  if (hit) return hit[1].toLowerCase();
  return low.replace(BREED_FILLER, ' ').replace(/\s+/g, ' ').trim();
}

// Does what the seller says fit what the photos look like? "Turkish" fits
// "Turkish Angora"; "Rottweiler" does not fit "Boerboel".
export function sameBreed(said, seen) {
  const a = breedKey(said), b = breedKey(seen);
  if (!a || !b) return true;
  if (a === b) return true;
  const wa = new Set(a.split(' ')), wb = b.split(' ');
  return wb.some((w) => w.length > 3 && wa.has(w));
}

// A word that names a family of breeds, not one: "Turkish" is a Turkish Angora
// or a Turkish Van. Asked about after the photos, with the one they look like first.
const BREED_FAMILIES = {
  turkish: ['Turkish Angora', 'Turkish Van'],
  shepherd: ['German Shepherd', 'Caucasian Shepherd', 'Anatolian Shepherd', 'Belgian Malinois'],
  terrier: ['Yorkshire Terrier', 'Jack Russell Terrier', 'American Pit Bull Terrier', 'Bull Terrier'],
  retriever: ['Golden Retriever', 'Labrador Retriever'],
  bulldog: ['English Bulldog', 'French Bulldog', 'American Bulldog'],
  mastiff: ['English Mastiff', 'Bullmastiff', 'Tibetan Mastiff', 'Neapolitan Mastiff'],
  spaniel: ['Cocker Spaniel', 'Cavalier King Charles Spaniel'],
  poodle: ['Toy Poodle', 'Miniature Poodle', 'Standard Poodle'],
  shorthair: ['British Shorthair', 'American Shorthair', 'Exotic Shorthair'],
  angora: ['Turkish Angora', 'Angora Rabbit'],
};

// The breeds a vague answer could mean, or null when it already names one.
export function breedFamily(said) {
  const key = String(said ?? '').toLowerCase().replace(BREED_FILLER, ' ').replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  return BREED_FAMILIES[key] ?? null;
}

// What the photos say the breed is: the guess the photos agree on most, weighted
// by how sure each was. Low-confidence guesses alone are not worth repeating.
const WEIGHT = { high: 3, medium: 2, low: 1 };
export function breedFromPhotos(images) {
  const votes = new Map();
  for (const img of images ?? []) {
    const v = img?.v;
    if (!v?.shows_pet || !v.breed) continue;
    const key = breedKey(v.breed) || v.breed.toLowerCase();
    const cur = votes.get(key) ?? { breed: v.breed, score: 0, best: 'low' };
    cur.score += WEIGHT[v.breed_confidence] ?? 1;
    if ((WEIGHT[v.breed_confidence] ?? 1) > WEIGHT[cur.best]) cur.best = v.breed_confidence;
    votes.set(key, cur);
  }
  const top = [...votes.values()].sort((x, y) => y.score - x.score)[0];
  if (!top || top.best === 'low') return null;
  return { breed: top.breed, confidence: top.best };
}

// "250k to 300k", "250-300k", "250k or 300": the two amounts, when a seller gives a range.
export function parsePriceRange(text) {
  const m = /^\s*(?:₦|ngn|n)?\s*([\d.,]+)\s*(k|m)?\s*(?:-|–|—|to|and|or|\/)\s*(?:₦|ngn|n)?\s*([\d.,]+)\s*(k|m)?\s*$/i.exec(String(text ?? ''));
  if (!m) return null;
  const unitA = m[2] || (m[4] && Number(m[1].replace(/,/g, '')) < 1000 ? m[4] : '');
  const unitB = m[4] || (m[2] && Number(m[3].replace(/,/g, '')) < 1000 ? m[2] : '');
  const a = parsePrice(m[1] + (unitA || '')), b = parsePrice(m[3] + (unitB || ''));
  return a && b ? [Math.min(a, b), Math.max(a, b)] : null;
}

// "50k per puppy", "45000 for female", "200k, we can negotiate": the amounts in a
// sentence, each once. An age or a count ("10 weeks", "3 pups", "2females") is
// not a price, and small numbers beside a real price ("2 males, 50k each") are counts.
// Every common way of writing it: 600k, 600K, ₦600,000, N600,000, NGN 600000,
// 600 thousand, 600,000 naira, 0.6m, 1.2 million, 600.000 (a dot for a comma).
const AMOUNT = /(?<![\p{L}\d_.,])(?:₦|ngn|naira|n)?\s*(\d{1,3}(?:[,.]\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d+)?)\s*(k|thousand|m|mil|mill|million)?(?:\s*(?:naira|ngn))?(?![\p{L}\d])(?!\s*(?:weeks?|wks?|months?|mo?nths?|mths?|mos?|years?|yrs?|days?|males?|females?|pups?|pupp(?:y|ies)|kittens?|old|litters?)\b)/giu;
const UNIT_K = { k: 'k', thousand: 'k', m: 'm', mil: 'm', mill: 'm', million: 'm' };
// "600.000" and "1.200.000" are thousands, written with dots.
const amountDigits = (s) => (/^\d{1,3}(\.\d{3})+$/.test(s) ? s.replace(/\./g, '') : s.replace(/,/g, ''));
export function pricesIn(text) {
  const found = [];
  for (const m of String(text ?? '').matchAll(AMOUNT)) {
    const n = parsePrice(amountDigits(m[1]) + (UNIT_K[String(m[2] ?? '').toLowerCase()] ?? ''));
    if (n != null && !found.includes(n)) found.push(n);
  }
  const real = found.filter((n) => n >= 1000);
  return real.length ? real : found;
}
const NEGOTIABLE_IN = /\b(negotia\w*|nego|open to offers?|offers? welcome|we (can )?(talk|discuss))\b/i;
// Below this a price is almost always "70" meaning ₦70,000, so it is checked.
const LOW_PRICE = 1000;

// ── QUESTIONS PARTWAY THROUGH ─────────────────────────────────────────────────
// What sellers ask while listing, answered before the question they were on is
// asked again. A question is never kept as an answer: "When does my listing get
// approved" is not an age, and "Can I add video" is not a photo.

// Shaped like a question: a question mark, a question word first, or "I'd like to know".
const QUESTION = /\?|^\s*(please[,\s]+)?(can|could|may|should|do|does|did|is|are|how|what|when|where|which|why|will|would|has|have)\b|\b(i'?d like to know|i would like to know|i want to know|enquiry|inquiry|wondering)\b/i;
const ASK_APPROVAL = /\b(when|how long|how soon|what time)\b[^.?!]{0,40}\b(approv\w*|review\w*|live|publish\w*|posted|visible|on the (site|website))\b/i;
const ASK_BUY = /\b(do|does|can|will|would)\s+(you|your(\s+\w+){1,2})\s+(buy|purchase|take in)\b|\byour(\s+\w+){0,2}\s+(buys|purchases)\b|\b(connect|link)\s+(me\s+)?(with|to)\s+(a\s+|the\s+)?(\w+\s+)?buyers?\b|\bfind\s+(me\s+)?(a\s+)?buyers?\b/i;
const ASK_FEE = /\b(is it free|free of charge|(how much|what)\s+(does it|do you|will it|would it|do i|will i)\s+(cost|charge|pay)|(any|a|the)\s+(fee|fees|charges?|commission)|do (i|we) (have to |need to )?pay|listing fee|cost to list)\b/i;
const ASK_VIDEO = /\b(videos?|vids?|clips?)\b/i;
const PHOTOS_LATER = /\b(later|tomorrow|tmrw|tonight|in the morning|when i (get|reach|come) (home|back)|not with (him|her|it|them|the (dog|puppy|puppies|cat|pet))|(it'?s|its|it is) (dark|night)|don'?t have (any |the )?(photos?|pictures?|pics?))\b/i;
const MANY_BREEDS = /\b(many|different|several|various|multiple)\s+(kinds? of |types? of )?breeds\b|\ball (kinds?|types?) of (dogs|breeds)\b|\bbreeder\b/i;
const ASK_PRICE_ADVICE = /\b(how much|what)\b[^.?!]{0,30}\b(should|can|do|to)\s+(i\s+)?(sell|charge|ask|price|put)\b|\bgood price\b|\b(market|normal|usual|average|current) price\b/i;

// After the listing has gone: "when will it be approved?" The store's routes
// answer it with the listing that is waiting (routes/waha.js).
export function asksAboutApproval(text) {
  const t = String(text ?? '');
  return QUESTION.test(t) && ASK_APPROVAL.test(t);
}

// ── IS THIS ANSWER THE KIND OF THING THAT WAS ASKED? ──────────────────────────
// Plain rules, checked on every answer and again at the summary, at no cost:
// a web link given as the age, "Listen" or "Okay boss" as the breed, a phone
// number as the area.
const LINK = /https?:\/\/|www\.|\.(com|ng|app|net|org|io|site)\b/i;
// Whole links, to take out of text the AI wrote before the owner sees it.
const LINKS = /(https?:\/\/|www\.)\S*|\S+\.(com|ng|app|net|org|io|site|example)\b\S*/gi;
const CHAT_REPLY = /^\s*(listen|ok(ay)?|boss|hello|hi|hey|yes|no|sir|ma|madam|agent|i am an agent|i'?m an agent|wait|please|thanks?|good|fine|sure|alright|done|later|hm+)\b/i;
const AGE_OK = /(\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a|an|half)\b)[^]*?(weeks?|wks?|wk|months?|mo?n?ths?|mnts?|mons?|mos?|years?|yrs?|yr|days?|dys?)|\bnew\s*born\b/i;
const CLEAN_AGE = /^\s*(about|around|approx\.?|i think|maybe)?\s*\d+(\.\d+)?\s*(-\s*\d+\s*)?\+?\s*(weeks?|wks?|wk|months?|mo?n?ths?|mnts?|mons?|mos?|years?|yrs?|yr|days?|dys?)(\s+old)?(\s*plus|\+)?\s*$/i;
const HIGH_PRICE = 20_000_000;

export const notABreed = (t) => !t || LINK.test(t) || CHAT_REPLY.test(t) || /\d{4,}/.test(t) || !/\p{L}{2}/u.test(t);
export const ageOk = (t) => Boolean(t) && !LINK.test(t) && AGE_OK.test(t);
export const placeOk = (t) => Boolean(t) && !LINK.test(t) && !/\d{7,}/.test(String(t).replace(/\s/g, '')) && /\p{L}{2}/u.test(t);

// What at the summary does not look right, by the rules. [{ field, why }]
export function irregularities(d) {
  const out = [];
  if (notABreed(d.breed)) out.push({ field: 'breed', why: "doesn't look like a breed" });
  if (!ageOk(d.age)) out.push({ field: 'age', why: "doesn't look like an age" });
  if (d.listing_type === 'sale' && (d.price < LOW_PRICE || d.price > HIGH_PRICE)) out.push({ field: 'price', why: 'looks unusual for a pet' });
  if (!placeOk(d.location)) out.push({ field: 'location', why: "doesn't look like a place" });
  return out;
}

// Whether the rules can vouch for every answer. When they cannot (a breed
// they do not know, an age written oddly, a price far from usual, a long
// seller name), the AI is asked to look; a listing they can vouch for costs
// nothing.
export function vouchedFor(d) {
  const breeds = breedsNamedIn(d.breed);
  const breedKnown = breeds.length === 1 && shortAnswer(String(d.breed ?? '').trim());
  const ageClean = CLEAN_AGE.test(String(d.age ?? ''));
  const priceUsual = d.listing_type !== 'sale' || (d.price >= 5_000 && d.price <= 5_000_000);
  const nameShort = String(d.name ?? '').trim().split(/\s+/).length <= 3;
  return breedKnown && ageClean && priceUsual && nameShort;
}

// The answers as the AI is shown them: what each question was, and what the
// seller typed, short. Never anything else from the chat.
export const DETAIL_FIELDS = ['breed', 'age', 'price', 'location', 'notes', 'seller_name'];
export function detailsForCheck(d) {
  const short = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  return {
    pet: d.type === 'Other' ? 'pet (not a dog or cat)' : String(d.type ?? 'Dog').toLowerCase(),
    breed: short(d.breed, 60),
    age: short(d.age, 40),
    price: d.listing_type === 'adoption' ? 'adoption (free)' : `₦${Number(d.price ?? 0).toLocaleString('en-NG')}`,
    location: short(d.location, 80),
    health: healthLine(d).replace(/^💉 /, ''),
    notes: short(d.notes, 300),
    seller_name: short(d.name, 60),
  };
}

const petWord = (draft) => (draft.type === 'Cat' ? 'cat' : draft.type === 'Dog' ? 'dog' : 'pet');

const SAY = {
  start: (store) =>
    `🐾 Hi! I'm the ${store} listing assistant. I'll help you list your pet for sale or adoption — it's free.\n\n` +
    'It takes a few quick questions and some photos. Reply *cancel* any time.',
  askType: 'What are you listing?\n\n1 Dog\n2 Cat\n3 Another pet\n4 Pet food, toys or accessories\n\nReply with the number.',
  badType: 'Reply 1 for a dog, 2 for a cat, 3 for another pet or 4 for pet products.',
  products: (store) => `Thanks! 🙌 For pet food, toys and accessories, the ${store} team will reply to you here shortly.`,
  askBreed: (d) =>
    d.type === 'Other'
      ? 'What kind of pet is it, and what breed? (e.g. African Grey parrot, Lionhead rabbit)'
      : `What breed is your ${petWord(d)}? (e.g. ${d.type === 'Cat' ? 'Persian, Siamese' : 'Boerboel, German Shepherd'}, or "mixed")`,
  askAge: (d) => `How old is your ${petWord(d)}? (e.g. 10 weeks, 2 years)`,
  askDeal:
    'Are you selling or giving it up for adoption?\n\n1 Selling\n2 Adoption (free to a good home)\n\nReply with the number.',
  badDeal: 'Reply 1 if you are selling, or 2 for adoption.',
  askPrice: 'How much are you asking? (e.g. 150000 or 150k). For a litter, the price per puppy.',
  badPrice: "I didn't catch a price. Send your price in numbers on its own, like 85000 or 85k.",
  priceRange: (a, b) => `Buyers see one price. Which should I show: *${formatNaira(a)}* or *${formatNaira(b)}*? Send just that amount.`,
  priceCheck: (guess) => `Did you mean *${formatNaira(guess)}*? Reply *YES*, or send the full price (like ${guess} or ${guess / 1000}k).`,
  badBreed: (d) =>
    `What breed is it? Just the breed name, like ${d.type === 'Cat' ? '*Persian*, *Siamese*' : '*Boerboel*, *Lhasa Apso*'} or *Mixed*. (Your other details come next.)`,
  whichBreed: (named) =>
    `One breed per listing 🙂 Which one is this listing for? (${named.slice(0, 5).join(', ')}${named.length > 5 ? '…' : ''})\n\n` +
    'When it has been sent, reply *SELL* to list the next.',
  welcomeBack: (d) => `👋 Welcome back! I still have your *${d.breed}* listing from before. Carry on below, or reply *NEW* to start a different one.`,
  // Answers to what sellers ask partway through.
  approval: (store) =>
    `${store} checks every listing before it goes live, usually within a day. Once you've finished here, I'll message you in this chat with your link as soon as it's live.`,
  approvalAtReview: (store) =>
    `It hasn't been sent yet 🙂 Reply *YES* and it goes to ${store} for review. They check every listing, usually within a day, and I'll message you here with your link as soon as it's live.`,
  weDontBuy: (store) =>
    `${store} doesn't buy pets itself. We list yours free, and buyers message you directly on WhatsApp to ask questions and arrange to see it.`,
  free: (store) => `Listing on ${store} is free 🙌 There's no fee.`,
  video: (d) =>
    `Videos can't go on the listing, only photos 📸 Tip: pause your video where the ${petWord(d)}'s face is clear, take a screenshot, and send that.`,
  voiceNote: "I can't listen to voice notes 🙏 Please type your answer.",
  photosLater: (d) =>
    `No problem 👍 I'll keep your answers for ${PHOTOS_WAIT_HOURS / 24} days. When you're with your ${petWord(d)}, send the photos here (daylight is best) and type *done*.`,
  manyBreeds: 'Great 🙌 Each listing is for one breed (a whole litter is fine). Let\'s do one now. When it has been sent, reply *SELL* to list the next.',
  priceAdvice: (browseUrl) =>
    'You choose the price, and buyers can still make you an offer.' +
    (browseUrl ? ` To compare, see what similar pets are listed for:\n${browseUrl}` : ''),
  photoLost: "😕 A photo didn't come through. Please send it again.",
  breedLater: (d) => `No problem 👍 I'll look at the photos and suggest one. How old is your ${petWord(d)}? (e.g. 10 weeks, 2 years)`,
  suggestBreed: (b) => `🔎 From the photos, it looks like a *${b}* to me. Reply *YES* to use that, or type the breed.`,
  askBreedAgain: (d) => `What breed should buyers see? If you're not sure, reply *mixed*.`,
  whichOf: (said, options, seen) =>
    `Which *${said}* breed is it?\n\n` +
    options.map((o, i) => `${i + 1} ${o}${seen && o === seen ? ' (what the photos look like)' : ''}`).join('\n') +
    `\n${options.length + 1} Not sure, keep *${said}*\n\nReply with the number, or type the breed.`,
  notNow: 'No problem 👍 Send *SELL* any time you have another pet to list.',
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
  askName: (d) => `What name should buyers see as the seller? *Your* name or your kennel's, not the ${petWord(d)}'s.`,
  badName: "That doesn't look like a real name 🤔. Please send your name or your kennel's name, for example *Ade* or *Royal Paws Kennel*.",
  petNameNotSeller: (d, petName) =>
    (petName ? `Thanks, I'll show *${petName}* as the ${petWord(d)}'s name 🐾 ` : `That sounds like your ${petWord(d)}'s name 🐾 `) +
    "And what's *your* name, or your kennel's? Buyers see it as the seller.",
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
      d.petName ? `🐾 Name: ${d.petName}` : null,
      d.listing_type === 'adoption' ? 'For adoption' : `Price: ${formatNaira(d.price)}${d.negotiable ? ' (negotiable)' : ''}`,
      `📍 ${d.location}`,
      healthLine(d),
      d.notes ? `Notes: ${d.notes}` : null,
      `${d.images.length} photo${d.images.length === 1 ? '' : 's'}${d.verified ? ' ✅ checked' : ''}`,
      `Seller: ${d.name}${d.nameKnown ? ' (as before)' : ''}, +${d.whatsapp}`,
    ].filter(Boolean).join('\n') +
    '\n\nReply *YES* to send it for review, *NAME* to change the seller name, or *CANCEL*.',
  reviewAgain: 'Reply *YES* to send it for review, or *CANCEL*. To change something, say what, like *price 600k* or *age 7 months*.',
  cancelled: 'Cancelled. Nothing was sent. Message *SELL* any time to list a pet.',
  badAge: (d) => `How old is your ${petWord(d)}? Send it like *10 weeks* or *2 years*.`,
  badLocation: 'Which city and area are you in? Send the place, like *Lekki, Lagos*.',
  fixPrice: 'What price should buyers see? Send the full amount, like *150000* or *150k*.',
  fixNotes: 'What should the notes for buyers say? Reply *skip* to leave them out.',
  checkThis: (label, value, question) =>
    `🔎 One thing before your summary: the *${label}* you gave, "${value}", doesn't look right.\n\n${question}\n\nOr reply *OK* to keep it as it is.`,
};

const FIX_LABEL = { breed: 'breed', age: 'age', price: 'price', location: 'area', notes: 'notes', seller_name: 'seller name' };
const MAX_FIXES = 3;

function fixMessage(d, fix) {
  const value = fix.field === 'price' ? formatNaira(d.price) : String((fix.field === 'seller_name' ? d.name : d[fix.field]) ?? '').slice(0, 80);
  const question = {
    breed: SAY.badBreed(d),
    age: SAY.badAge(d),
    price: SAY.fixPrice,
    location: SAY.badLocation,
    notes: SAY.fixNotes,
    seller_name: SAY.askName(d),
  }[fix.field];
  return SAY.checkThis(FIX_LABEL[fix.field], value, question);
}

function healthLine(d) {
  if (d.vaccinated && d.dewormed) return '💉 Vaccinated and dewormed';
  if (d.vaccinated) return '💉 Vaccinated';
  if (d.dewormed) return 'Dewormed';
  return 'Not yet vaccinated or dewormed';
}

// manageUrl: the site's one-tap log-in to the seller's listings, when it gave one.
export function petSentMessage(store, manageUrl = null) {
  return (
    `✅ Sent! ${store} will check your listing and publish it soon. Buyers will message you directly on WhatsApp.\n\n` +
    (manageUrl && /^https:\/\//.test(manageUrl)
      ? `👤 Your listings, to change the price or photos or mark one sold:\n${manageUrl}\n\n`
      : '') +
    'Have another pet to list? Send *SELL*.'
  );
}

// "When will it be approved?" from a seller whose listing is waiting.
export function petPendingMessage({ store, breed }) {
  return (
    `⏳ Your *${breed ?? 'pet'}* listing is with ${store} for review. They check every listing, usually within a day, ` +
    "and I'll message you here with your link as soon as it's live."
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
function breedCheckLine(breed, c) {
  if (!c?.guess) return '';
  if (c.source === 'suggested') return `\n\n🔎 The seller didn't know the breed; the photos suggested *${c.guess}* and they accepted it.`;
  if (c.matches === false) {
    return `\n\n🔎 Breed check: the seller says *${breed}*, but the photos look more like *${c.guess}*${c.confidence ? ` (${c.confidence} confidence)` : ''}. Check before approving.`;
  }
  return `\n\n🔎 Breed check: the photos look like *${c.guess}*, which fits.`;
}

function flagsLine(listing, flags) {
  if (!flags?.length) return '';
  const value = (f) => (f.field === 'price' ? formatNaira(listing.price) : f.field === 'seller_name' ? listing.seller_name : f.field === 'notes' ? listing.description : listing[f.field]);
  return (
    '\n\n⚠️ Check before approving. The seller kept these as they were:\n' +
    flags.map((f) => `• ${FIX_LABEL[f.field] ?? f.field}: "${String(value(f) ?? '').slice(0, 60)}"${f.why ? `, ${f.why}` : ''}`).join('\n')
  );
}

export function newPetListingMessage({ breed, price, listing_type, location, ...listing }, { verified, note, breedCheck, flags } = {}) {
  return (
    `🐾 New pet listing sent for review: *${breed}*, ` +
    (listing_type === 'adoption' ? 'for adoption' : formatNaira(price)) +
    (location ? `, ${location}` : '') +
    '. Approve it in your site admin.' +
    (verified === undefined
      ? ''
      : verified
        ? '\n\n📸 Photos checked: a real pet, face visible.'
        : `\n\n📸 Photos weren't checked automatically${note ? ` (${note})` : ''}. Look at them before approving.`) +
    breedCheckLine(breed, breedCheck) +
    flagsLine({ breed, price, listing_type, location, ...listing }, flags)
  );
}

// To the store's owner, when a guide for a breed new to the site is waiting.
// To the owner: somebody wants to sell pet products, which the bot does not list.
export function petProductsOwnerMessage({ phone }) {
  return `🛍️ Somebody wants to sell pet food, toys or accessories${phone ? ` (+${phone})` : ''}. The bot has told them you'll reply; their chat is waiting for you.`;
}

export function breedGuideDraftMessage({ breed }) {
  return (
    `📘 New breed guide to review: *${breed}*.\n\n` +
    'Read it, fix anything wrong and approve it in your site admin → Breed guides. Buyers will not see it until you do.'
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

// ── REMINDING A SELLER WHO STOPPED AT THE PHOTOS ─────────────────────────────
// The photos are where sellers most often stop ("later, it's dark now"). Each
// listing gets one reminder, a few hours after their last message, and only in
// the daytime in Lagos: a seller is not woken for it. routes/petReminders.js
// sends it.
export const REMIND_AFTER_HOURS = 3;
const LAGOS_UTC_OFFSET = 1;
const DAY_STARTS = 8;
const DAY_ENDS = 21;

export function petReminderDue(conversation, now = Date.now()) {
  if (conversation?.state !== 'pet_photos' || conversation.draft?.remindedAt) return false;
  if (conversation.paused_until && new Date(conversation.paused_until).getTime() > now) return false;
  const quiet = now - new Date(conversation.updated_at).getTime();
  if (!(quiet >= REMIND_AFTER_HOURS * 3_600_000) || petStale(conversation, { now })) return false;
  const hour = (new Date(now).getUTCHours() + LAGOS_UTC_OFFSET) % 24;
  return hour >= DAY_STARTS && hour < DAY_ENDS;
}

export function petReminderMessage({ store, draft }) {
  const pet = petWord(draft ?? {});
  const n = draft?.images?.length ?? 0;
  return (
    `📸 Hi! Your ${draft?.breed ? `*${draft.breed}*` : pet} listing on ${store} is nearly done. ` +
    (n
      ? `You've sent ${n} photo${n === 1 ? '' : 's'}. Send any more, then type *done* and it goes for review.`
      : `It just needs photos: send a few clear ones (daylight is best, with the ${pet}'s face showing), then type *done* and it goes for review.`) +
    "\n\nI've kept your answers, so there's nothing to fill in again. Changed your mind? Reply *CANCEL*."
  );
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
    conversation && PET_STATES.includes(conversation.state) && !petStale(conversation, ctx)
      ? conversation
      : null;

  const text = String(message?.body ?? '').trim();
  const image = imageFrom(message);
  // Hours after the seller went to take the photos: only the photos, "done" for
  // ones already sent, or their opening line again, carry on. Anything else they
  // say is for the owner.
  const resumed = Boolean(live && staleness(live, ctx));
  const finishing = Boolean(live?.draft?.images?.length) && (FILLER.test(text) || YES.test(text));
  if (resumed && !image && !finishing && !wantsToSellPet(text)) return null;

  if (!live) {
    if (!wantsToSellPet(text)) return null;
    const type = typeIn(text);
    const draft = { images: image ? [image] : [], ...(type ? { type } : {}) };
    return reply(type ? 'pet_breed' : 'pet_type', draft, SAY.start(store), type ? SAY.askBreed(draft) : SAY.askType);
  }

  const draft = { ...(live.draft ?? {}), images: [...(live.draft?.images ?? [])] };

  if (!text && !message?.hasMedia) return reply(live.state, draft);
  if (CANCEL.test(text)) return { state: 'idle', draft: {}, replies: [SAY.cancelled], action: null };
  if (/^\s*(new|start (again|over|afresh)|restart)\s*[.!]*$/i.test(text)) return reply('pet_type', { images: [] }, SAY.askType);

  // A video or a voice note can't go on a listing; say so instead of acting as if nothing came.
  const mime = String(message?.mimetype ?? '');
  if (message?.hasMedia && /^video\//i.test(mime) && live.state !== 'pet_review') {
    return reply(live.state, draft, SAY.video(draft), live.state === 'pet_photos' ? (draft.images.length ? SAY.morePhotos(draft.images.length) : null) : question(live.state, draft, ctx));
  }
  if (message?.hasMedia && /^audio\//i.test(mime)) {
    return reply(live.state, draft, SAY.voiceNote, question(live.state, draft, ctx));
  }

  // Back to a listing started earlier ("Hi, I want to sell my dog" again): an
  // opening line is never an answer, so the answers kept are offered back. Only
  // a greeting or SELL, or after a while away: "I am selling them because we're
  // moving" is an answer to "anything else buyers should know?".
  const opener = wantsToSellPet(text) && (resumed || SELL_START.test(text) || GREETING.test(text));
  if (!image && draft.breed && !['pet_type', 'pet_breed', 'pet_deal'].includes(live.state) && opener) {
    return reply(live.state, draft, SAY.welcomeBack(draft), question(live.state, draft, ctx));
  }

  // A photo WhatsApp said was there but that could not be fetched: the seller
  // is asked to send it again, instead of the bot carrying on as if none came.
  if (!image && message?.hasMedia && !message.mediaUrl && !/^(video|audio)\//.test(String(message.mimetype ?? '')) && live.state !== 'pet_review') {
    if (live.state === 'pet_notes' && text && !SKIP.test(text)) {
      const d = { ...draft, notes: text.slice(0, MAX_NOTES) };
      return reply('pet_photos', d, SAY.photoLost, d.images.length ? SAY.morePhotos(d.images.length) : SAY.askPhotos(d));
    }
    return reply(live.state, draft, SAY.photoLost);
  }

  // A photo is welcome at any point before the summary.
  if (image && live.state !== 'pet_review') {
    if (draft.images.length >= MAX_PET_PHOTOS) {
      if (draft.limit_noted) return { state: live.state, draft, replies: [], action: null };
      return next(live.state, { ...draft, limit_noted: true }, SAY.photoLimit, ctx, store);
    }
    draft.images.push(image);
    // A photo with its caption in answer to "anything else buyers should know?"
    if (live.state === 'pet_notes' && text && !SKIP.test(text)) {
      const d = { ...draft, notes: text.slice(0, MAX_NOTES) };
      if (d.images.length >= MAX_PET_PHOTOS) return processPhotos(d, SAY.photoLimit);
      return reply('pet_photos', d, SAY.morePhotos(d.images.length));
    }
    if (live.state === 'pet_photos') {
      if (draft.images.length >= MAX_PET_PHOTOS) return processPhotos(draft, SAY.photoLimit);
      return reply('pet_photos', draft, SAY.morePhotos(draft.images.length));
    }
    return next(live.state, draft, '📸 Photo saved.', ctx, store);
  }

  // A question, answered. YES at the summary still sends it, and "done, I'll send
  // more later" still finishes the photos.
  const settled = (live.state === 'pet_review' && YES.test(text)) || (live.state === 'pet_photos' && draft.images.length && (FILLER.test(text) || YES.test(text)));
  if (text && !settled) {
    const answered = answerQuestion(live.state, draft, text, ctx, store);
    if (answered) return answered;
  }

  switch (live.state) {
    case 'pet_type': {
      if (/^\s*(4|food|toys?|accessor|products?|pet products?)\b/i.test(text)) {
        return { state: 'idle', draft: {}, replies: [SAY.products(store)], action: { type: 'pet_products' } };
      }
      const type = typeIn(text, true);
      if (!type && NOT_NOW.test(text) && !draft.images.length) return { state: 'idle', draft: {}, replies: [SAY.notNow], action: null };
      if (!type) return reply('pet_type', draft, SAY.badType);
      const d = { ...draft, type };
      return reply('pet_breed', d, SAY.askBreed(d));
    }

    case 'pet_breed': {
      if (!text) return reply('pet_breed', draft, SAY.askBreed(draft));
      if (UNSURE.test(text)) return reply('pet_age', { ...draft, breed: null, breedUnsure: true }, SAY.breedLater(draft));
      const several = severalBreeds(text);
      if (several) return reply('pet_breed', draft, SAY.whichBreed(several));
      const breed = parseBreed(text);
      // "Listen", "Okay boss", a website: not a breed, however short.
      if (!breed || notABreed(breed)) return reply('pet_breed', draft, SAY.badBreed(draft));
      // Picked out of a longer message: say which, so a wrong pick can be put right at the summary.
      const typed = text.replace(/\s+/g, ' ').trim().replace(TRAILING_PET, '').toLowerCase();
      const picked = breed.toLowerCase() !== typed ? `Breed: *${breed}* 👍` : null;
      return reply('pet_age', { ...draft, breed: tidyBreed(breed) }, picked, SAY.askAge(draft));
    }

    case 'pet_age':
      if (!text) return reply('pet_age', draft, SAY.askAge(draft));
      if (!ageOk(text)) return reply('pet_age', draft, SAY.badAge(draft));
      return reply('pet_deal', { ...draft, age: tidyAge(text).slice(0, MAX_AGE) }, SAY.askDeal);

    case 'pet_deal': {
      // "1", or in their own words: "Am selling", "for adoption".
      const sale = /^\s*1\b/.test(text) || (!/^\s*2\b/.test(text) && /\b(sell|selling|sale)\b/i.test(text));
      const adopt = /^\s*2\b/.test(text) || /\b(adopt\w*|free|rehom\w*|give\s+(\w+\s+)?away|giving\s+(\w+\s+)?away)\b/i.test(text);
      if (sale && !adopt) return reply('pet_price', { ...draft, listing_type: 'sale' }, SAY.askPrice);
      if (adopt && !sale) return reply('pet_location', { ...draft, listing_type: 'adoption', price: null }, SAY.askLocation);
      return reply('pet_deal', draft, SAY.badDeal);
    }

    case 'pet_price': {
      // "Did you mean ₦70,000?" answered yes.
      if (draft.priceGuess && YES.test(text)) {
        return reply('pet_location', { ...draft, price: draft.priceGuess, priceGuess: undefined }, SAY.askLocation);
      }
      const d = NEGOTIABLE_IN.test(text) ? { ...draft, negotiable: true } : draft;
      const range = parsePriceRange(text);
      // A range is never taken: buyers see one price. The same amount twice ("500,000 or 500k") is just that price.
      if (range && range[0] !== range[1]) return reply('pet_price', d, SAY.priceRange(range[0], range[1]));
      const prices = pricesIn(text);
      if (prices.length > 1) {
        const [a, b] = [...prices].sort((x, y) => x - y);
        return reply('pet_price', d, SAY.priceRange(a, b));
      }
      if (!prices.length) return reply('pet_price', d, SAY.badPrice);
      const price = prices[0];
      // Asked once; the same small amount sent again is taken as meant.
      if (price < LOW_PRICE && d.priceGuess !== price * 1000) {
        return reply('pet_price', { ...d, priceGuess: price * 1000 }, SAY.priceCheck(price * 1000));
      }
      return reply('pet_location', { ...d, price, priceGuess: undefined }, SAY.askLocation);
    }

    case 'pet_location':
      if (text.length < 2) return reply('pet_location', draft, SAY.askLocation);
      if (!placeOk(text)) return reply('pet_location', draft, SAY.badLocation);
      return reply('pet_health', { ...draft, location: tidyPlace(text).slice(0, MAX_LOCATION) }, SAY.askHealth);

    case 'pet_health': {
      const found = HEALTH.find(([, re]) => re.test(text));
      if (!found) return reply('pet_health', draft, SAY.badHealth);
      return reply('pet_notes', { ...draft, ...found[0] }, SAY.askNotes);
    }

    case 'pet_notes': {
      if (!text) return reply('pet_notes', draft, SAY.askNotes);
      const petName = SKIP.test(text) ? null : petNameIn(text);
      const d = { ...draft, notes: SKIP.test(text) ? null : text.slice(0, MAX_NOTES), ...(petName ? { petName } : {}) };
      // Photos sent earlier in the chat already count.
      if (d.images.length >= MAX_PET_PHOTOS) return processPhotos(d);
      return reply('pet_photos', d, d.images.length ? SAY.morePhotos(d.images.length) : SAY.askPhotos(d));
    }

    case 'pet_photos':
      if (!draft.images.length) return reply('pet_photos', draft, text ? SAY.noPhotos : SAY.askPhotos(draft));
      // "done" while the photos are already being checked (the sixth photo starts it): nothing more.
      if (draft.checkingSince && Date.now() - Date.parse(draft.checkingSince) < 120_000) return reply('pet_photos', draft);
      if (FILLER.test(text) || YES.test(text)) return processPhotos(draft);
      return reply('pet_photos', draft, SAY.morePhotos(draft.images.length));

    // After the photos, for a seller who did not know the breed.
    case 'pet_breed_confirm': {
      let breed = null, source = 'seller';
      const options = draft.breedOptions;
      const n = options ? Number(/^\s*(\d+)\s*$/.exec(text)?.[1]) : NaN;
      if (options && n >= 1 && n <= options.length) breed = options[n - 1];
      else if (options && (n === options.length + 1 || UNSURE.test(text))) breed = draft.breed;
      else if (draft.breedSuggest && YES.test(text)) { breed = draft.breedSuggest; source = 'suggested'; }
      else if (UNSURE.test(text)) breed = draft.breedSuggest ?? 'Mixed';
      // "No, Purebred American Eskimo": the breed, without the no.
      else breed = parseBreed(text.replace(/^\s*(no|nope|not)\b[\s,.!:-]*/i, ''));
      if (!breed) return reply('pet_breed_confirm', draft, SAY.badBreed(draft));
      const check = draft.breedSuggest ? { ...(draft.breedCheck ?? {}), guess: draft.breedSuggest, source } : draft.breedCheck;
      const d = { ...draft, breed, breedUnsure: false, breedSuggest: undefined, breedOptions: undefined, breedCheck: check ? { ...check, matches: sameBreed(breed, check.guess) } : undefined };
      return after('pet_photos', d, ctx, store);
    }

    case 'pet_name': {
      const petName = petNameIn(text);
      const d = petName ? { ...draft, petName } : draft;
      const name = parseSellerName(text);
      if (!name) return reply('pet_name', d, petName || PET_NAME_TALK.test(text) ? SAY.petNameNotSeller(d, petName) : SAY.badName);
      return after('pet_name', { ...d, name, nameKnown: false }, ctx, store);
    }

    case 'pet_contact': {
      if (ctx.phone && YES.test(text)) return toReview({ ...draft, whatsapp: ctx.phone }, ctx, store);
      const number = normalizeNumber(text);
      if (!number) return reply('pet_contact', draft, SAY.badContact);
      return toReview({ ...draft, whatsapp: number }, ctx, store);
    }

    // Something at the summary that did not look right: the seller fixes it, or keeps it.
    case 'pet_fix': {
      const [fix, ...rest] = draft.fixes ?? [];
      if (!fix) return review({ ...draft, fixes: undefined }, store);
      if (KEEP.test(text)) {
        return nextFix({ ...draft, kept: [...(draft.kept ?? []), fix] }, rest, store);
      }
      const fixed = applyFix(fix.field, text, draft);
      if (fixed.ask) return reply('pet_fix', draft, fixed.ask);
      return nextFix(fixed.draft, rest, store);
    }

    case 'pet_review': {
      if (YES.test(text)) return submit(draft);
      if (/^\s*(name|change (?:the )?(?:seller )?name|edit name)\s*$/i.test(text)) return reply('pet_name', draft, SAY.askName(draft));
      // "Change the seller name Kenny", "Add my name Remina", "Raya is the pet name, my name is Remina".
      const renamed = RENAME.exec(text)?.[1] ?? (/\bmy\s+name\s+is\b/i.test(text) ? text : null);
      const name = renamed ? parseSellerName(renamed) : null;
      const petName = petNameIn(text);
      if (name || petName) return review({ ...draft, ...(name ? { name, nameKnown: false } : {}), ...(petName ? { petName } : {}) }, store);
      const edit = EDIT.exec(text);
      const field = edit && EDIT_FIELD[edit[1].toLowerCase()];
      if (field && !(field === 'price' && draft.listing_type !== 'sale')) {
        const fixed = applyFix(field, edit[2], draft);
        if (fixed.ask) return reply('pet_review', draft, fixed.ask, SAY.reviewAgain);
        return review(fixed.draft, store);
      }
      if (NO.test(text)) return { state: 'idle', draft: {}, replies: [SAY.cancelled], action: null };
      return reply('pet_review', draft, SAY.reviewAgain);
    }

    default:
      return null;
  }
}

// The photos are saved and looked at outside this pure function (routes/waha.js)
// and the outcome comes back to petPhotosDone().
function processPhotos(draft, note) {
  return {
    state: 'pet_photos',
    draft: { ...draft, checkingSince: new Date().toISOString() },
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
  draft = { ...draft, checkNote: ctx.checkNote ?? undefined, checkingSince: undefined };
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
  const guess = breedFromPhotos(keep);
  const next = {
    ...draft,
    images: ordered,
    verified: kind ? { kind } : undefined,
    breedCheck: guess ? { guess: guess.breed, confidence: guess.confidence, matches: draft.breed ? sameBreed(draft.breed, guess.breed) : null } : undefined,
  };
  const prefix = [droppedNote, confirmed].filter(Boolean).join('\n\n');
  // A breed family ("Turkish"): which one, with what the photos look like first.
  const family = draft.breed ? breedFamily(draft.breed) : null;
  if (family) {
    const seenIn = guess ? family.find((o) => sameBreed(o, guess.breed) && breedKey(o) === breedKey(guess.breed)) ?? null : null;
    const options = seenIn ? [seenIn, ...family.filter((o) => o !== seenIn)] : family;
    return reply('pet_breed_confirm', { ...next, breedOptions: options }, prefix, SAY.whichOf(draft.breed, options, seenIn));
  }
  // The seller did not know the breed: suggest what the photos show, or ask again.
  if (!draft.breed) {
    if (guess) return reply('pet_breed_confirm', { ...next, breedSuggest: guess.breed }, prefix, SAY.suggestBreed(guess.breed));
    return reply('pet_breed_confirm', next, prefix, SAY.askBreedAgain(draft));
  }
  return after('pet_photos', next, ctx, store, prefix);
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
    if (!ctx.knownName) return reply('pet_name', draft, prefix, SAY.askName(draft));
    draft = { ...draft, name: ctx.knownName, nameKnown: true };
    note = SAY.knownName(ctx.knownName);
  }
  if (!draft.whatsapp) return reply('pet_contact', draft, prefix, note, SAY.askContact(ctx.phone));
  return toReview(draft, ctx, store);
}

// On the way to the summary, once: the rules look at every answer, and the AI
// only when the rules cannot vouch for them (ctx.detailsCheck 'auto'), always
// ('always') or never ('off'), and only where there is a key (ctx.aiCheck).
function toReview(draft, ctx, store) {
  if (draft.detailsChecked) return review(draft, store);
  const d = { ...draft, detailsChecked: true };
  const flagged = irregularities(d);
  if (flagged.length) return nextFix(d, flagged, store);
  const mode = ctx.detailsCheck ?? 'auto';
  if (ctx.aiCheck && (mode === 'always' || (mode === 'auto' && !vouchedFor(d)))) {
    return { state: 'pet_review', draft: d, replies: [], action: { type: 'check_details' } };
  }
  return review(d, store);
}

// What the AI found (routes/waha.js asks it): [{ field, problem }], or none.
export function petDetailsChecked(draft, issues, ctx = {}) {
  const store = ctx.store ?? 'the store';
  const seen = new Set();
  const fixes = (issues ?? [])
    .filter((i) => DETAIL_FIELDS.includes(i?.field) && !seen.has(i.field) && seen.add(i.field))
    .filter((i) => i.field !== 'price' || draft.listing_type === 'sale')
    .map((i) => ({ field: i.field, why: String(i.problem ?? '').replace(LINKS, '').replace(/\s+/g, ' ').trim().slice(0, 140), by: 'ai' }));
  return nextFix({ ...draft, detailsChecked: true }, fixes, store);
}

// Ask about the next thing flagged, at most a few, then show the summary.
function nextFix(draft, fixes, store) {
  const asked = draft.fixesAsked ?? 0;
  const [fix, ...rest] = asked < MAX_FIXES ? fixes : [];
  if (!fix) return review({ ...draft, fixes: undefined }, store);
  return reply('pet_fix', { ...draft, fixes: [fix, ...rest], fixesAsked: asked + 1 }, fixMessage(draft, fix));
}

// A corrected answer, checked by the same rules as the first time: { draft } or { ask }.
function applyFix(field, text, d) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (field === 'breed') {
    const several = severalBreeds(t);
    if (several) return { ask: SAY.whichBreed(several) };
    const breed = !notABreed(t) && parseBreed(t);
    return breed ? { draft: { ...d, breed: tidyBreed(breed) } } : { ask: SAY.badBreed(d) };
  }
  if (field === 'age') return ageOk(t) ? { draft: { ...d, age: tidyAge(t).slice(0, MAX_AGE) } } : { ask: SAY.badAge(d) };
  if (field === 'price') {
    const [price] = pricesIn(t);
    return price ? { draft: { ...d, price, ...(NEGOTIABLE_IN.test(t) ? { negotiable: true } : {}) } } : { ask: SAY.badPrice };
  }
  if (field === 'location') return placeOk(t) ? { draft: { ...d, location: tidyPlace(t).slice(0, MAX_LOCATION) } } : { ask: SAY.badLocation };
  if (field === 'notes') return { draft: { ...d, notes: SKIP.test(t) ? null : t.slice(0, MAX_NOTES) } };
  const name = parseSellerName(t);
  return name ? { draft: { ...d, name, nameKnown: false } } : { ask: SAY.badName };
}

// The question a conversation is waiting on, to ask again after a note.
function question(state, draft, ctx) {
  return {
    pet_type: SAY.askType,
    pet_breed: SAY.askBreed(draft),
    pet_age: SAY.askAge(draft),
    pet_deal: SAY.askDeal,
    pet_price: draft.priceGuess ? SAY.priceCheck(draft.priceGuess) : SAY.askPrice,
    pet_location: SAY.askLocation,
    pet_health: SAY.askHealth,
    pet_notes: SAY.askNotes,
    pet_photos: draft.images.length >= MAX_PET_PHOTOS ? 'Type *done* to carry on.' : draft.images.length ? SAY.morePhotos(draft.images.length) : SAY.askPhotos(draft),
    pet_breed_confirm: draft.breedOptions
      ? SAY.whichOf(draft.breed, draft.breedOptions, null)
      : draft.breedSuggest ? SAY.suggestBreed(draft.breedSuggest) : SAY.askBreedAgain(draft),
    pet_name: SAY.askName(draft),
    pet_contact: SAY.askContact(ctx.phone),
    pet_fix: draft.fixes?.[0] ? fixMessage(draft, draft.fixes[0]) : SAY.reviewAgain,
    pet_review: SAY.reviewAgain,
  }[state];
}

// Re-ask the current question, after a note.
function next(state, draft, note, ctx, store) {
  return reply(state, draft, note, question(state, draft, ctx));
}

// A seller waiting to take the photos keeps their answers for days; anywhere else,
// a conversation left for hours starts over as before.
export function petStale(conversation, ctx = {}) {
  if (conversation?.state !== 'pet_photos') return staleness(conversation, ctx);
  if (!conversation.updated_at) return false;
  const now = ctx.now ? new Date(ctx.now).getTime() : Date.now();
  const then = new Date(conversation.updated_at).getTime();
  return Number.isFinite(then) && now - then > PHOTOS_WAIT_HOURS * 3_600_000;
}

// "Leave as it is", "keep it", "it's correct", "no change": the answer stands.
const KEEP = /^\s*(ok|okay|keep|leave|no change|don'?t change|do not change|as it is|it'?s (fine|correct|right|ok)|it is (fine|correct|right|ok)|that'?s (fine|correct|right|ok)|correct|fine|right|yes|y)\b/i;

// At the summary, any answer changed in one message: "Change the price to
// 600,000 negotiable", "age 7 months", "area Port Harcourt".
const EDIT = /^\s*(?:please\s+)?(?:change|set|make|update|correct|put|edit)?\s*(?:the\s+|my\s+)?(price|amount|age|area|location|place|city|breed|notes?|description)\b\s*(?:to|is|should be|as|=|:|-)?\s*(.+)$/i;
const EDIT_FIELD = { price: 'price', amount: 'price', age: 'age', area: 'location', location: 'location', place: 'location', city: 'location', breed: 'breed', note: 'notes', notes: 'notes', description: 'notes' };

// "Change the seller name Kenny", "add my name Remina", "my name is Remina".
const RENAME = /^\s*(?:(?:please\s+)?(?:change|edit|update|correct|add|use|put)\s+(?:the\s+|my\s+)?(?:seller'?s?\s+)?name\s*(?:to|as|:|-)?\s+|my\s+name\s+is\s+)(.+)$/i;

// What a seller asked partway through, answered, then the question they were on
// asked again; null when the message is not one of these questions.
function answerQuestion(state, draft, text, ctx, store) {
  const asked = QUESTION.test(text);
  const noPhotosYet = state === 'pet_photos' && !draft.images.length;
  let said = null;
  // Whether the answer already says what to do next, so the question is not repeated.
  let complete = false;
  if (asked && ASK_APPROVAL.test(text)) {
    complete = state === 'pet_review';
    said = complete ? SAY.approvalAtReview(store) : SAY.approval(store);
  } else if (asked && ASK_BUY.test(text)) said = SAY.weDontBuy(store);
  else if (asked && ASK_FEE.test(text)) said = SAY.free(store);
  else if ((asked || state === 'pet_photos') && ASK_VIDEO.test(text)) [said, complete] = [SAY.video(draft), noPhotosYet];
  else if (state === 'pet_photos' && PHOTOS_LATER.test(text)) [said, complete] = [SAY.photosLater(draft), noPhotosYet];
  else if (state === 'pet_breed' && MANY_BREEDS.test(text)) said = SAY.manyBreeds;
  else if (state === 'pet_price' && ASK_PRICE_ADVICE.test(text) && (asked || /good price/i.test(text))) said = SAY.priceAdvice(ctx.browseUrl);
  if (!said) return null;

  // A breed named in the same message still counts: "I have a purebred Eskimo
  // puppy… does your store buy puppies?"
  if (state === 'pet_breed') {
    const named = breedsNamedIn(text).filter((b) => b !== 'Mixed');
    if (named.length === 1) return reply('pet_age', { ...draft, breed: named[0] }, said, `Breed: *${named[0]}* 👍`, SAY.askAge(draft));
  }
  return reply(state, draft, said, complete ? null : question(state, draft, ctx));
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
      breedCheck: draft.breedCheck ?? null,
      // Flagged at the summary and kept by the seller: the owner looks before approving.
      flags: (draft.kept ?? []).map((f) => ({ field: f.field, why: f.why })),
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
        description: [draft.notes, draft.negotiable && draft.listing_type === 'sale' ? 'Price is negotiable.' : null].filter(Boolean).join('\n') || null,
        seller_name: draft.name,
        whatsapp: draft.whatsapp,
        // The pet's own name, when the seller gave one ("Zoe is her name").
        ...(draft.petName ? { name: draft.petName } : {}),
      },
      images: draft.images,
    },
  };
}
