import test from 'node:test';
import assert from 'node:assert/strict';

import { petIntakeStep, wantsToSellPet, MAX_PET_PHOTOS, newPetListingMessage, petRejectedMessage } from '../lib/petIntake.js';
import { STALE_AFTER_HOURS } from '../lib/bot.js';

// Somebody listing a pet through a pet store's WhatsApp. Pure, so every
// branch is tested without a server.

const photo = (n = 1) => ({ hasMedia: true, mediaUrl: `https://waha.test/api/files/s/${n}.jpg`, mimetype: 'image/jpeg' });
const say = (body) => ({ body });
const ctx = { store: 'PuppyPlace', phone: '2348031234567' };

function run(messages, context = ctx) {
  let conversation = null;
  const out = [];
  for (const m of messages) {
    const r = petIntakeStep(conversation, m, context);
    out.push(r);
    if (r) conversation = { state: r.state, draft: r.draft };
  }
  return out;
}

const DOG = [
  say('Hi PuppyPlace, I want to sell my dog.'),
  say('Boerboel'),
  say('10 weeks'),
  say('1'),
  say('150k'),
  say('Lugbe, Abuja'),
  say('1'),
  say('3 males, 2 females'),
  photo(1),
  photo(2),
  say('done'),
  say('Ade Kennels'),
  say('yes'),
];

test('buyers and everybody else are left for the store', () => {
  for (const body of ['hello', 'Do you sell puppies?', 'how much is the boerboel', 'are you selling dogs', 'I want to buy a puppy', '']) {
    assert.equal(petIntakeStep(null, say(body), ctx), null, body);
    assert.equal(wantsToSellPet(body), false, body);
  }
  assert.equal(petIntakeStep(null, photo(), ctx), null);
  assert.equal(petIntakeStep({ state: 'idle', draft: {} }, say('hi'), ctx), null);
});

test('a seller in their own words, or SELL, starts it', () => {
  for (const body of ['I want to sell my dog', "Hi PuppyPlace, I'd like to sell my puppies", 'we are rehoming our cat', 'SELL', 'rehome']) {
    assert.ok(wantsToSellPet(body), body);
  }
  // The pet is taken from the opening message when it says.
  const dog = petIntakeStep(null, say('I want to sell my puppies'), ctx);
  assert.equal(dog.state, 'pet_breed');
  assert.equal(dog.draft.type, 'Dog');
  assert.match(dog.replies[0], /PuppyPlace listing assistant/);
  assert.match(dog.replies[1], /What breed is your dog/);
  const cat = petIntakeStep(null, say('I want to rehome my kitten'), ctx);
  assert.equal(cat.draft.type, 'Cat');
  // SELL alone asks.
  const plain = petIntakeStep(null, say('SELL'), ctx);
  assert.equal(plain.state, 'pet_type');
  assert.match(plain.replies[1], /1 Dog\n2 Cat\n3 Another pet/);
});

test('a dog goes from the first message to a listing for the site', () => {
  const steps = run(DOG);
  const review = steps.at(-1);
  assert.equal(review.state, 'pet_review');
  assert.match(review.replies[0], /\*Boerboel\* \(dog\), 10 weeks/);
  assert.match(review.replies[0], /Price: ₦150,000/);
  assert.match(review.replies[0], /📍 Lugbe, Abuja/);
  assert.match(review.replies[0], /Vaccinated and dewormed/);
  assert.match(review.replies[0], /2 photos/);
  assert.match(review.replies[0], /Seller: Ade Kennels, \+2348031234567/);

  const last = run([...DOG, say('YES')]).at(-1);
  assert.equal(last.state, 'idle');
  assert.deepEqual(last.draft, {});
  assert.deepEqual(last.action.listing, {
    type: 'Dog',
    breed: 'Boerboel',
    age: '10 weeks',
    listing_type: 'sale',
    price: 150000,
    location: 'Lugbe, Abuja',
    vaccinated: true,
    dewormed: true,
    description: '3 males, 2 females',
    seller_name: 'Ade Kennels',
    whatsapp: '2348031234567',
  });
  assert.equal(last.action.type, 'pet_listing');
  assert.equal(last.action.images.length, 2);
});

test('adoption skips the price, and notes can be skipped', () => {
  const steps = run([
    say('SELL'), say('3'), say('African grey parrot'), say('2 years'), say('2'),
    say('Ikeja, Lagos'), say('4'), say('skip'), photo(), say('done'), say('Tolu'), say('yes'), say('yes'),
  ]);
  const { listing } = steps.at(-1).action;
  assert.equal(listing.type, 'Other');
  assert.equal(listing.listing_type, 'adoption');
  assert.equal(listing.price, null);
  assert.equal(listing.vaccinated, false);
  assert.equal(listing.dewormed, false);
  assert.equal(listing.description, null);
  assert.match(steps.at(-2).replies[0], /For adoption/);
});

test('buyers can be pointed at another number', () => {
  const head = DOG.slice(0, -1);
  const other = run([...head, say('0812 345 6789'), say('yes')]).at(-1);
  assert.equal(other.action.listing.whatsapp, '2348123456789');
  const bad = run([...head, say('call me')]).at(-1);
  assert.equal(bad.state, 'pet_contact');
  assert.match(bad.replies[0], /doesn't look like a phone number/);
  // A chat whose number WhatsApp hides is asked for one.
  const hidden = run(head, { store: 'PuppyPlace', phone: null }).at(-1);
  assert.match(hidden.replies[0], /Which WhatsApp number/);
});

test('wrong answers are asked again, not guessed', () => {
  const at = (msgs) => run(msgs).at(-1);
  assert.equal(at([say('SELL'), say('a lion')]).state, 'pet_type');
  assert.equal(at([say('SELL'), say('1'), say('Lab'), say('1 yr'), say('maybe')]).state, 'pet_deal');
  assert.match(at([say('SELL'), say('1'), say('Lab'), say('1 yr'), say('1'), say('a lot')]).replies[0], /didn't catch a price/);
  assert.equal(at([...DOG.slice(0, 6), say('7')]).state, 'pet_health');
  // No photo yet: "done" is not enough.
  const noPhoto = at([...DOG.slice(0, 8), say('done')]);
  assert.equal(noPhoto.state, 'pet_photos');
  assert.match(noPhoto.replies[0], /at least one photo/);
});

test('photos sent early count, and the limit is the site limit', () => {
  // A photo with the opening message, and one mid-way, both count.
  const early = run([{ ...photo(1), body: 'I want to sell my dog' }, say('Lab'), photo(2), say('1 yr')]);
  assert.equal(early.at(-1).draft.images.length, 2);
  assert.match(early[2].replies[0], /Photo saved/);
  assert.match(early[2].replies[1], /How old/);

  const many = run([...DOG.slice(0, 8), ...Array.from({ length: MAX_PET_PHOTOS + 2 }, (_, i) => photo(i))]);
  const full = many.find((r) => r.state === 'pet_name');
  assert.ok(full, 'moves on by itself at the limit');
  assert.equal(full.draft.images.length, MAX_PET_PHOTOS);
  assert.match(full.replies[0], /6 photos, the most/);
});

test('cancel ends it, and a stale chat starts over', () => {
  const r = run([say('SELL'), say('1'), say('cancel')]).at(-1);
  assert.equal(r.state, 'idle');
  assert.match(r.replies[0], /Cancelled/);

  const old = new Date(Date.now() - (STALE_AFTER_HOURS + 1) * 3_600_000).toISOString();
  assert.equal(petIntakeStep({ state: 'pet_age', draft: { images: [] }, updated_at: old }, say('2 years'), ctx), null);
});

test('messages for the owner and for a refused listing', () => {
  assert.match(newPetListingMessage({ breed: 'Boerboel', price: 150000, listing_type: 'sale', location: 'Abuja' }), /\*Boerboel\*, ₦150,000, Abuja/);
  assert.match(newPetListingMessage({ breed: 'Cat', listing_type: 'adoption' }), /for adoption/);
  assert.match(petRejectedMessage(['photo 1: larger than 5 MB']), /• photo 1: larger than 5 MB/);
});
