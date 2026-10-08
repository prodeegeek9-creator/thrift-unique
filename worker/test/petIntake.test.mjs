import test from 'node:test';
import assert from 'node:assert/strict';

import {
  petIntakeStep,
  petPhotosDone,
  wantsToSellPet,
  MAX_PET_PHOTOS,
  newPetListingMessage,
  petLiveMessage,
  petShareMessage,
  petInviteMessage,
  petRejectedMessage,
  petFailedOwnerMessage,
} from '../lib/petIntake.js';
import { STALE_AFTER_HOURS } from '../lib/bot.js';

// Somebody listing a pet through a pet store's WhatsApp. Pure, so every
// branch is tested without a server.

const photo = (n = 1) => ({ hasMedia: true, mediaUrl: `https://waha.test/api/files/s/${n}.jpg`, mimetype: 'image/jpeg' });
const say = (body) => ({ body });
const ctx = { store: 'PuppyPlace', phone: '2348031234567' };

// Saving and looking at the photos happens outside the pure step (routes/waha.js);
// here that is played by `look`: draft images → [{ stored, v? }]. By default the
// photos are saved and not looked at.
const unlooked = (draft) => draft.images.map((_, i) => ({ stored: `p${i}` }));

function run(messages, context = ctx, look = unlooked) {
  let conversation = null;
  const out = [];
  for (const m of messages) {
    let r = petIntakeStep(conversation, m, context);
    if (r?.action?.type === 'process_photos') r = petPhotosDone(r.draft, look(r.draft), context);
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

  // At the limit it hands over to saving and looking at them by itself, saying why.
  let conv = null;
  let handoff = null;
  for (const m of [...DOG.slice(0, 8), ...Array.from({ length: MAX_PET_PHOTOS + 2 }, (_, i) => photo(i))]) {
    const r = petIntakeStep(conv, m, ctx);
    if (r) conv = { state: r.state, draft: r.draft };
    if (r?.action?.type === 'process_photos' && !handoff) handoff = r;
  }
  assert.ok(handoff, 'moves on by itself at the limit');
  assert.equal(handoff.draft.images.length, MAX_PET_PHOTOS);
  assert.match(handoff.replies[0], /6 photos, the most/);
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

test('a finished listing keeps its draft on the action, for a retry', () => {
  const last = run([...DOG, say('YES')]).at(-1);
  assert.equal(last.action.draft.breed, 'Boerboel');
  assert.equal(last.action.draft.images.length, 2);
  assert.equal(last.action.draft.whatsapp, '2348031234567');
  // Resuming from it goes straight back to the same summary and YES submits it again.
  const again = petIntakeStep({ state: 'pet_review', draft: last.action.draft }, say('yes'), ctx);
  assert.deepEqual(again.action.listing, last.action.listing);
});

test('the owner is told why a listing failed, in plain words', () => {
  assert.match(petFailedOwnerMessage({ breed: 'Boerboel', status: 401, reason: 'Unauthorized' }), /HTTP 401 \(Unauthorized\)[\s\S]*must be the same value/);
  assert.match(petFailedOwnerMessage({ breed: 'Boerboel', status: null }), /no answer from the site/);
  assert.match(petFailedOwnerMessage({ status: 404 }), /pet listing could not be sent[\s\S]*address is wrong/);
}
);

// ── LOOKING AT THE PHOTOS ────────────────────────────────────────────────────

const pet = (extra = {}) => ({ shows_pet: true, kind: 'dog', face_visible: true, ...extra });
const NOT_A_PET = { shows_pet: false, kind: 'not_an_animal', face_visible: false };
const TO_PHOTOS = DOG.slice(0, 8); // up to the question asking for photos

test('"done" hands the photos to be saved and looked at, and says so', () => {
  const r = petIntakeStep({ state: 'pet_photos', draft: { type: 'Dog', images: [{ url: 'u' }] } }, say('done'), ctx);
  assert.equal(r.state, 'pet_photos');
  assert.equal(r.action.type, 'process_photos');
  assert.match(r.replies.at(-1), /Checking your photos/);
  // The question asking for photos says the face must show.
  assert.match(run(TO_PHOTOS.slice(0, 8)).at(-1).replies[0], /face must be clearly visible/);
});

test('photos that show the pet with a visible face are confirmed to the seller', () => {
  const steps = run([...DOG.slice(0, 11), say('Ade')], ctx, (d) => d.images.map((_, i) => ({ stored: `p${i}`, v: pet() })));
  const afterDone = steps[10];
  assert.match(afterDone.replies[0], /✅ Photos checked: I can see a dog, and its face is clearly visible/);
  assert.match(afterDone.replies.at(-1), /What name should buyers see/);
  assert.deepEqual(afterDone.draft.verified, { kind: 'dog' });
  // …and the summary shows it, and the site is told nothing it cannot store.
  const last = run([...DOG, say('YES')], ctx, (d) => d.images.map((_, i) => ({ stored: `p${i}`, v: pet() }))).at(-1);
  assert.equal(last.action.verified, true);
  assert.equal('verified' in last.action.listing, false);
  const summary = run(DOG, ctx, (d) => d.images.map((_, i) => ({ stored: `p${i}`, v: pet() }))).at(-1);
  assert.match(summary.replies[0], /2 photos ✅ checked/);
});

test('a photo with the face showing goes first, since buyers see it first', () => {
  const sides = [pet({ face_visible: false }), pet({ face_visible: true })];
  const r = run(DOG.slice(0, 11), ctx, (d) => d.images.map((_, i) => ({ stored: `p${i}`, v: sides[i] }))).at(-1);
  assert.deepEqual(r.draft.images.map((i) => i.stored), ['p1', 'p0']);
});

test('photos of something else are left out, and the seller is told which', () => {
  const verdicts = [pet(), NOT_A_PET];
  const r = run(DOG.slice(0, 11), ctx, (d) => d.images.map((_, i) => ({ stored: `p${i}`, v: verdicts[i] }))).at(-1);
  assert.match(r.replies[0], /I left out a photo:\n• Photo 2: it doesn't show a dog/);
  assert.equal(r.draft.images.length, 1);
  assert.equal(r.state, 'pet_name');
});

test('a cat in a dog listing is called out, and nothing but non-pets sends them back for new photos', () => {
  const cat = run(DOG.slice(0, 11), ctx, (d) => d.images.map((_, i) => ({ stored: `p${i}`, v: i ? pet() : pet({ kind: 'cat' }) }))).at(-1);
  assert.match(cat.replies[0], /Photo 1: it looks like a cat, not a dog/);

  const none = run(DOG.slice(0, 11), ctx, (d) => d.images.map((_, i) => ({ stored: `p${i}`, v: NOT_A_PET }))).at(-1);
  assert.equal(none.state, 'pet_photos');
  assert.equal(none.draft.images.length, 0);
  assert.match(none.replies.join('\n'), /Photo 1: it doesn't show a dog[\s\S]*Please send a clear photo of your dog/);

  // Another pet is not a dog or a cat.
  const bird = run([say('SELL'), say('3'), say('Parrot'), say('2 years'), say('1'), say('50k'), say('Lagos'), say('1'), say('skip'), photo(1), say('done')], ctx,
    (d) => d.images.map((_, i) => ({ stored: `p${i}`, v: pet({ kind: 'bird' }) }))).at(-1);
  assert.match(bird.replies[0], /I can see a bird/);
  const wrong = run([say('SELL'), say('3'), say('Parrot'), say('2 years'), say('1'), say('50k'), say('Lagos'), say('1'), say('skip'), photo(1), say('done')], ctx,
    (d) => d.images.map((_, i) => ({ stored: `p${i}`, v: pet({ kind: 'dog' }) }))).at(-1);
  assert.match(wrong.replies[0], /it looks like a dog, not a pet/);
});

test('the dog\'s face must show in at least one photo', () => {
  const r = run(DOG.slice(0, 11), ctx, (d) => d.images.map((_, i) => ({ stored: `p${i}`, v: pet({ face_visible: false }) }))).at(-1);
  assert.equal(r.state, 'pet_photos');
  assert.match(r.replies.at(-1), /can see your dog, but not its face clearly[\s\S]*type \*done\*/);
  // The photos that were fine are kept, so one more is enough.
  assert.equal(r.draft.images.length, 2);
  const again = petPhotosDone(r.draft, [...r.draft.images, { stored: 'p9', v: pet() }], ctx);
  assert.equal(again.state, 'pet_name');
  assert.equal(again.draft.images[0].stored, 'p9');
});

test('photos that could not be looked at are listed, with no claim that they were checked', () => {
  const r = run([...DOG.slice(0, 11)]).at(-1);
  assert.equal(r.state, 'pet_name');
  assert.doesNotMatch(r.replies.join(' '), /checked/);
  assert.equal(r.draft.verified, undefined);
  const none = petPhotosDone({ type: 'Dog', images: [] }, [], ctx);
  assert.match(none.replies[0], /couldn't save those photos/);
  assert.equal(none.state, 'pet_photos');
});

test('the owner learns whether the photos were checked, and the seller when the dog is live', () => {
  const listing = { breed: 'Boerboel', price: 150000, listing_type: 'sale', location: 'Abuja' };
  assert.match(newPetListingMessage(listing, { verified: true }), /Photos checked: a real pet, face visible/);
  assert.match(newPetListingMessage(listing, { verified: false }), /weren't checked automatically\. Look at them before approving/);
  // …and when it can be said, why.
  assert.match(newPetListingMessage(listing, { verified: false, note: 'OPENAI_API_KEY is not set on the Worker' }), /weren't checked automatically \(OPENAI_API_KEY is not set on the Worker\)\. Look at them/);
  assert.doesNotMatch(newPetListingMessage(listing, { verified: true, note: 'ignored' }), /ignored/);
  assert.doesNotMatch(newPetListingMessage(listing), /Photos/);
  const live = petLiveMessage({ store: 'PuppyPlace', breed: 'Lhasa', listing_type: 'sale', url: 'https://puppyplace.ng/pets/lhasa-1' });
  assert.match(live, /Your \*Lhasa\* is now live on PuppyPlace\.[\s\S]*https:\/\/puppyplace\.ng\/pets\/lhasa-1[\s\S]*Send \*SELL\*/);
  assert.match(petLiveMessage({ store: 'PuppyPlace', breed: 'Cat', listing_type: 'adoption' }), /live on PuppyPlace for adoption/);
  // The seller is asked to share it, and given something to forward.
  assert.match(live, /Please share it![\s\S]*WhatsApp Status, Instagram and Facebook/);
  assert.equal(petShareMessage({ breed: 'Lhasa', listing_type: 'sale', url: 'https://puppyplace.ng/pets/lhasa-1' }), '🐾 Lhasa for sale on PuppyPlace. See photos and details:\nhttps://puppyplace.ng/pets/lhasa-1');
  assert.match(petShareMessage({ breed: 'Cat', listing_type: 'adoption', url: 'https://x/y' }), /Cat available for adoption/);
});

test('the invitation says who it is, why, and how to start', () => {
  const msg = petInviteMessage({ store: 'PuppyPlace', browseUrl: 'https://puppyplace.ng/pets.html' });
  assert.match(msg, /This is the PuppyPlace listing assistant[\s\S]*free, in about 5 minutes[\s\S]*face visible[\s\S]*Reply \*SELL\* to start[\s\S]*pets\.html/);
  assert.doesNotMatch(petInviteMessage({ store: 'PuppyPlace' }), /Looking to buy/);
  // And "SELL", the reply it asks for, does start the conversation.
  assert.equal(petIntakeStep(null, say('SELL'), ctx).state, 'pet_type');
});

test('why the photos were not looked at travels with the listing to the owner', () => {
  const stuck = run(DOG, ctx, (d) => d.images.map((_, i) => ({ stored: `p${i}` })));
  assert.equal(stuck.at(-1).draft.checkNote, undefined);
  // The note given when the photos were handled is kept on the draft and handed on with the listing.
  let conv = null;
  let last;
  for (const m of DOG.slice(0, 11)) {
    let r = petIntakeStep(conv, m, ctx);
    if (r?.action?.type === 'process_photos') r = petPhotosDone(r.draft, r.draft.images.map((_, i) => ({ stored: `p${i}` })), { ...ctx, checkNote: 'OpenAI said HTTP 401' });
    conv = { state: r.state, draft: r.draft };
  }
  for (const m of [say('Ade Kennels'), say('yes'), say('YES')]) {
    last = petIntakeStep(conv, m, ctx);
    conv = { state: last.state, draft: last.draft };
  }
  assert.equal(last.action.verified, false);
  assert.equal(last.action.checkNote, 'OpenAI said HTTP 401');
});
