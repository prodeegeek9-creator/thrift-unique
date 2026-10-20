import test from 'node:test';
import assert from 'node:assert/strict';

import {
  petIntakeStep,
  petPhotosDone,
  parseSellerName,
  wantsToSellPet,
  MAX_PET_PHOTOS,
  newPetListingMessage,
  petLiveMessage,
  petShareMessage,
  petInviteMessage,
  petRejectedMessage,
  petFailedOwnerMessage,
  petSentMessage,
  parseBreed,
  parsePriceRange,
  pricesIn,
  petNameIn,
  asksAboutApproval,
  petPendingMessage,
  PHOTOS_WAIT_HOURS,
  petReminderDue,
  petReminderMessage,
  REMIND_AFTER_HOURS,
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

// ── THE SELLER'S NAME ────────────────────────────────────────────────────────

test('real names and kennel names are accepted, with "my name is" taken off', () => {
  for (const [typed, name] of [
    ['Ade', 'Ade'],
    ['Royal Paws Kennel', 'Royal Paws Kennel'],
    ['Dave_k9', 'Dave_k9'],
    ['Humblesmith kennel', 'Humblesmith kennel'],
    ['Ed', 'Ed'],
    ['Ọlá Bẹ́ kennels', 'Ọlá Bẹ́ kennels'],
    ['my name is Ade', 'Ade'],
    ['My name is Royal Paws Kennel', 'Royal Paws Kennel'],
    ['Name: Tolu', 'Tolu'],
    ["I'm Bola", 'Bola'],
    ['I am Bola', 'Bola'],
    ['call me Chi', 'Chi'],
    ['  "Ade"  ', 'Ade'],
    ['Ade   Obi', 'Ade Obi'],
  ]) {
    assert.equal(parseSellerName(typed), name, typed);
  }
});

test('"my name", placeholders, numbers and web addresses are not names', () => {
  for (const typed of [
    'my name', 'My Name', 'my name is', 'name', 'Name:', 'my kennel', 'kennel', 'the owner', 'no name', 'your name',
    'none', 'N/A', 'nil', 'test', 'testing', 'me', 'myself', 'hello', 'dog', 'seller', 'anonymous', 'skip', 'yes', 'no',
    'a', 'x', '1', 'aaaa', '!!!', '?', '08031234567', '+2348031234567', '1234567', 'www.shop.com', 'http://x.y', 'ade@mail.com',
    'puppies.com', '', '   ', 'x'.repeat(81),
  ]) {
    assert.equal(parseSellerName(typed), null, JSON.stringify(typed));
  }
});

test('a name that is not one is flagged, and asked for again', () => {
  const asked = run(DOG.slice(0, 11)).at(-1);
  assert.equal(asked.state, 'pet_name');
  for (const typed of ['my name', 'none', '08031234567']) {
    const flagged = petIntakeStep({ state: 'pet_name', draft: asked.draft }, say(typed), ctx);
    assert.equal(flagged.state, 'pet_name');
    assert.match(flagged.replies[0], /doesn't look like a real name[\s\S]*\*Ade\* or \*Royal Paws Kennel\*/);
    assert.equal(flagged.draft.name, undefined);
  }
  // "my name is Ade" is taken as Ade, and the next question follows.
  const ok = petIntakeStep({ state: 'pet_name', draft: asked.draft }, say('my name is Ade'), ctx);
  assert.equal(ok.state, 'pet_contact');
  assert.equal(ok.draft.name, 'Ade');
});

test('a seller who has given a name before is not asked again, and can change it at the summary', () => {
  const known = { ...ctx, knownName: 'Dave_k9' };
  // Straight from the photos to the number, with the name already in place.
  const afterPhotos = run(DOG.slice(0, 11), known).at(-1);
  assert.equal(afterPhotos.state, 'pet_contact');
  assert.equal(afterPhotos.draft.name, 'Dave_k9');
  assert.ok(afterPhotos.replies.some((r) => /I'll list this under \*Dave_k9\*, as last time/.test(r)));
  assert.ok(!afterPhotos.replies.some((r) => /What name should buyers see/.test(r)));

  const summary = run([...DOG.slice(0, 11), say('yes')], known).at(-1);
  assert.equal(summary.state, 'pet_review');
  assert.match(summary.replies[0], /Seller: Dave_k9 \(as before\), \+2348031234567/);
  assert.match(summary.replies[0], /\*YES\* to send it for review, \*NAME\* to change the seller name, or \*CANCEL\*/);

  // NAME asks again; a bad answer is flagged; a good one goes straight back to the summary.
  const asking = petIntakeStep({ state: 'pet_review', draft: summary.draft }, say('name'), known);
  assert.equal(asking.state, 'pet_name');
  assert.match(asking.replies[0], /What name should buyers see/);
  assert.equal(petIntakeStep({ state: 'pet_name', draft: asking.draft }, say('my name'), known).state, 'pet_name');
  const changed = petIntakeStep({ state: 'pet_name', draft: asking.draft }, say('Royal Paws Kennel'), known);
  assert.equal(changed.state, 'pet_review');
  assert.match(changed.replies[0], /Seller: Royal Paws Kennel, \+2348031234567/);
  assert.doesNotMatch(changed.replies[0], /as before/);
  // …and what is sent is the new name.
  assert.equal(petIntakeStep({ state: 'pet_review', draft: changed.draft }, say('YES'), known).action.listing.seller_name, 'Royal Paws Kennel');
  // The unchanged name is what is sent otherwise.
  assert.equal(petIntakeStep({ state: 'pet_review', draft: summary.draft }, say('YES'), known).action.listing.seller_name, 'Dave_k9');
});

test('a first-time seller is still asked, and NAME at the summary works for them too', () => {
  const first = run(DOG.slice(0, 11)).at(-1);
  assert.match(first.replies.at(-1), /What name should buyers see/);
  const summary = run(DOG).at(-1);
  assert.doesNotMatch(summary.replies[0], /as before/);
  assert.equal(petIntakeStep({ state: 'pet_review', draft: summary.draft }, say('NAME'), ctx).state, 'pet_name');
});

// ── BREEDS, PRICE RANGES, CAPTIONS, LOST PHOTOS, "DONE" ─────────────────────

test('a breed is kept as typed when it is short, and picked out of a sentence when it is not', () => {
  for (const [typed, breed] of [
    ['Boerboel', 'Boerboel'],
    ['Purebred Lhasa Apso', 'Purebred Lhasa Apso'],
    ['Boerboel puppies', 'Boerboel'],
    ['Eskimo puppy', 'Eskimo'],
    ['mixed', 'mixed'],
    ['Please, I would like to make an enquiry. I have a purebred Eskimo puppy, and I’m looking for a buyer.', 'American Eskimo'],
    ['I have a German shepherd', 'German Shepherd'],
    ['I want to sell my alsatian and her pups', 'German Shepherd'],
    ['Hello I have pit bull puppies for sale in Lagos', 'American Pit Bull Terrier'],
  ]) assert.equal(parseBreed(typed), breed, typed);
  for (const typed of ['', 'puppy', 'Dogs', 'Please can you help me sell my dog?', 'I am looking for a buyer for my puppy, she is lovely']) {
    assert.equal(parseBreed(typed), null, typed);
  }
});

test('a breed picked out of a message is said back; one that cannot be found is asked for again', () => {
  const conv = { state: 'pet_breed', draft: { type: 'Dog', images: [] } };
  const picked = petIntakeStep(conv, say('Please, I would like to make an enquiry. I have a purebred Eskimo puppy, and I’m looking for a buyer.'), ctx);
  assert.equal(picked.state, 'pet_age');
  assert.equal(picked.draft.breed, 'American Eskimo');
  assert.match(picked.replies[0], /Breed: \*American Eskimo\*/);
  const plain = petIntakeStep(conv, say('Boerboel'), ctx);
  assert.equal(plain.replies.length, 1);
  const unclear = petIntakeStep(conv, say('I am looking for a buyer for my puppy, she is lovely'), ctx);
  assert.equal(unclear.state, 'pet_breed');
  assert.match(unclear.replies[0], /Just the breed name/);
  // A question is answered, and the breed asked for again.
  const asked = petIntakeStep(conv, say('Please can you help me find a buyer for my dog?'), ctx);
  assert.equal(asked.state, 'pet_breed');
  assert.match(asked.replies[0], /doesn't buy pets itself/);
  assert.match(asked.replies[1], /What breed is your dog/);
});

test('a price range is answered with a question using the seller\'s own amounts, not an example to copy', () => {
  assert.deepEqual(parsePriceRange('250k to 300'), [250000, 300000]);
  assert.deepEqual(parsePriceRange('250-300k'), [250000, 300000]);
  assert.deepEqual(parsePriceRange('₦300,000 - ₦250,000'), [250000, 300000]);
  assert.equal(parsePriceRange('150k'), null);
  assert.equal(parsePriceRange('call me'), null);
  const conv = { state: 'pet_price', draft: { type: 'Dog', images: [], listing_type: 'sale' } };
  const r = petIntakeStep(conv, say('250k to 300'), ctx);
  assert.equal(r.state, 'pet_price');
  assert.match(r.replies[0], /one price.*₦250,000.*₦300,000/s);
  const bad = petIntakeStep(conv, say('negotiable'), ctx);
  assert.ok(!/150/.test(bad.replies[0]), bad.replies[0]);
});

test('a photo sent with its caption as the answer to "anything else" keeps both', () => {
  const conv = { state: 'pet_notes', draft: { type: 'Dog', images: [] } };
  const r = petIntakeStep(conv, { ...photo(1), body: 'She is a female, 8 weeks old.' }, ctx);
  assert.equal(r.state, 'pet_photos');
  assert.equal(r.draft.notes, 'She is a female, 8 weeks old.');
  assert.equal(r.draft.images.length, 1);
  assert.match(r.replies[0], /Got it/);
});

test('a photo that did not come through is reported, and its caption still counts', () => {
  const lost = { hasMedia: true, mediaUrl: null, mimetype: 'image/jpeg' };
  const inPhotos = petIntakeStep({ state: 'pet_photos', draft: { type: 'Dog', images: [{ url: 'u' }] } }, lost, ctx);
  assert.equal(inPhotos.state, 'pet_photos');
  assert.equal(inPhotos.draft.images.length, 1);
  assert.match(inPhotos.replies[0], /didn't come through/);
  const inNotes = petIntakeStep({ state: 'pet_notes', draft: { type: 'Dog', images: [] } }, { ...lost, body: 'Female, white' }, ctx);
  assert.equal(inNotes.state, 'pet_photos');
  assert.equal(inNotes.draft.notes, 'Female, white');
  assert.match(inNotes.replies.join(' '), /didn't come through[\s\S]*send clear, recent photos/);
  // A voice note or video is not a lost photo.
  const voice = petIntakeStep({ state: 'pet_photos', draft: { type: 'Dog', images: [{ url: 'u' }] } }, { hasMedia: true, mediaUrl: null, mimetype: 'audio/ogg' }, ctx);
  assert.ok(!/didn't come through/.test(voice.replies.join(' ')));
});

test('"done" or "sorry, that\'s all" at the first question ends it politely', () => {
  for (const t of ['Done', "Sorry I'm done, I only what to sell the one I have show you", 'no thanks', "that's all"]) {
    const r = petIntakeStep({ state: 'pet_type', draft: { images: [] } }, say(t), ctx);
    assert.equal(r.state, 'idle', t);
    assert.match(r.replies[0], /No problem/, t);
  }
  assert.equal(petIntakeStep({ state: 'pet_type', draft: { images: [] } }, say('1'), ctx).state, 'pet_breed');
  assert.match(petSentMessage('PuppyPlace'), /Have another pet to list\? Send \*SELL\*/);
});

test('sellers are recognised however they put it, and buyers still are not', () => {
  for (const t of [
    "Hi PuppyPlace, I'd like to sell on PuppyPlace.",
    'I have Boerboel puppies for sale',
    'I have 3 puppies available for sale',
    "I've got kittens available",
    'My puppies are for sale',
    'Does your pet store buy puppies?',
    'Can I list on your site?',
  ]) assert.equal(wantsToSellPet(t), true, t);
  for (const t of ['Do you have puppies for sale?', 'Do you sell puppies?', 'How much is the puppy?', 'I need a dog for sale', 'Is the puppy available?']) {
    assert.equal(wantsToSellPet(t), false, t);
  }
  const start = petIntakeStep(null, say("Hi PuppyPlace, I'd like to sell on PuppyPlace."), ctx);
  assert.equal(start.state, 'pet_type');
  assert.match(start.replies.at(-1), /4 Pet food, toys or accessories/);
});

test('somebody selling pet products is told the team will reply, and the owner is told', () => {
  const r = petIntakeStep({ state: 'pet_type', draft: { images: [] } }, say('4'), ctx);
  assert.equal(r.state, 'idle');
  assert.match(r.replies[0], /PuppyPlace team will reply/);
  assert.deepEqual(r.action, { type: 'pet_products' });
});

// ── THE BREED FROM THE PHOTOS ────────────────────────────────────────────────

const seen = (breed, breed_confidence = 'high', extra = {}) => ({ stored: 'p', v: { shows_pet: true, kind: 'dog', face_visible: true, breed, breed_confidence, ...extra } });

test('the photos agree on a breed, weighted by how sure each was; low guesses alone are not repeated', async () => {
  const { breedFromPhotos, sameBreed } = await import('../lib/petIntake.js');
  assert.deepEqual(breedFromPhotos([seen('Boerboel', 'medium'), seen('Bullmastiff', 'low'), seen('Boerboel', 'high')]), { breed: 'Boerboel', confidence: 'high' });
  assert.equal(breedFromPhotos([seen('Boerboel', 'low'), seen('Cane Corso', 'low')]), null);
  assert.equal(breedFromPhotos([{ stored: 'p' }, seen('', 'high')]), null);
  for (const [a, b] of [['Alsatian', 'German Shepherd'], ['Eskimo', 'American Eskimo'], ['Turkish', 'Turkish Angora'], ['Purebred Lhasa Apso', 'Lhasa Apso'], ['GSD puppies', 'German Shepherd']]) {
    assert.equal(sameBreed(a, b), true, `${a} ~ ${b}`);
  }
  for (const [a, b] of [['Rottweiler', 'Boerboel'], ['Persian', 'Siamese'], ['Caucasian Shepherd', 'Tibetan Mastiff']]) assert.equal(sameBreed(a, b), false, `${a} vs ${b}`);
});

test("a breed that doesn't fit the photos is flagged to the store, one that does is confirmed", () => {
  const draft = { type: 'Dog', breed: 'Rottweiler', images: [{ url: 'u' }] };
  const r = petPhotosDone(draft, [seen('Boerboel', 'medium')], { ...ctx, knownName: 'Ade' });
  assert.deepEqual(r.draft.breedCheck, { guess: 'Boerboel', confidence: 'medium', matches: false });
  const msg = newPetListingMessage({ breed: 'Rottweiler', price: 1, listing_type: 'sale' }, { verified: true, breedCheck: r.draft.breedCheck });
  assert.match(msg, /the seller says \*Rottweiler\*, but the photos look more like \*Boerboel\* \(medium confidence\)\. Check before approving/);
  const ok = petPhotosDone({ ...draft, breed: 'Alsatian' }, [seen('German Shepherd')], { ...ctx, knownName: 'Ade' });
  assert.equal(ok.draft.breedCheck.matches, true);
  assert.match(newPetListingMessage({ breed: 'Alsatian', price: 1, listing_type: 'sale' }, { verified: true, breedCheck: ok.draft.breedCheck }), /look like \*German Shepherd\*, which fits/);
  // The seller is never told, and the breed they gave is kept.
  assert.equal(ok.draft.breed, 'Alsatian');
  assert.equal(newPetListingMessage({ breed: 'X', price: 1, listing_type: 'sale' }, { verified: true }).includes('Breed check'), false);
});

test("a seller who doesn't know the breed is offered the one the photos show, and can type another", () => {
  const atBreed = petIntakeStep({ state: 'pet_breed', draft: { type: 'Dog', images: [] } }, say("I don't know"), ctx);
  assert.equal(atBreed.state, 'pet_age');
  assert.equal(atBreed.draft.breedUnsure, true);
  assert.match(atBreed.replies[0], /look at the photos and suggest one/);

  const draft = { ...atBreed.draft, age: '8 weeks', listing_type: 'sale', price: 1, location: 'Lekki', images: [{ url: 'u' }] };
  const asked = petPhotosDone(draft, [seen('German Shepherd', 'high')], ctx);
  assert.equal(asked.state, 'pet_breed_confirm');
  assert.match(asked.replies.at(-1), /looks like a \*German Shepherd\* to me\. Reply \*YES\*/);

  const yes = petIntakeStep({ state: asked.state, draft: asked.draft }, say('yes'), ctx);
  assert.equal(yes.draft.breed, 'German Shepherd');
  assert.equal(yes.draft.breedCheck.source, 'suggested');
  assert.equal(yes.state, 'pet_name');
  assert.match(newPetListingMessage({ breed: 'German Shepherd', price: 1, listing_type: 'sale' }, { verified: true, breedCheck: yes.draft.breedCheck }), /didn't know the breed; the photos suggested/);

  const typed = petIntakeStep({ state: asked.state, draft: asked.draft }, say('Belgian Malinois'), ctx);
  assert.equal(typed.draft.breed, 'Belgian Malinois');
  assert.equal(typed.draft.breedCheck.matches, false);

  // No guess from the photos: asked again, and "not sure" becomes Mixed.
  const none = petPhotosDone(draft, [{ stored: 'p', v: { shows_pet: true, kind: 'dog', face_visible: true } }], ctx);
  assert.equal(none.state, 'pet_breed_confirm');
  assert.match(none.replies.at(-1), /If you're not sure, reply \*mixed\*/);
  assert.equal(petIntakeStep({ state: none.state, draft: none.draft }, say('not sure'), ctx).draft.breed, 'Mixed');
});

test('"Turkish" is asked about after the photos: which Turkish breed, with what the photos look like first', async () => {
  const { breedFamily } = await import('../lib/petIntake.js');
  assert.deepEqual(breedFamily('Turkish'), ['Turkish Angora', 'Turkish Van']);
  assert.deepEqual(breedFamily('turkish cat'), ['Turkish Angora', 'Turkish Van']);
  assert.equal(breedFamily('Turkish Angora'), null);
  assert.equal(breedFamily('German Shepherd'), null);
  assert.ok(breedFamily('Shepherd').includes('German Shepherd'));

  const cat = (breed, breed_confidence = 'high') => ({ stored: 'p', v: { shows_pet: true, kind: 'cat', face_visible: true, breed, breed_confidence } });
  const draft = { type: 'Cat', breed: 'Turkish', age: '4 months', listing_type: 'sale', price: 300000, location: 'Surulere', images: [{ url: 'u' }] };
  const asked = petPhotosDone(draft, [cat('Turkish Van')], ctx);
  assert.equal(asked.state, 'pet_breed_confirm');
  const q = asked.replies.at(-1);
  assert.match(q, /Which \*Turkish\* breed is it\?\n\n1 Turkish Van \(what the photos look like\)\n2 Turkish Angora\n3 Not sure, keep \*Turkish\*/);

  assert.equal(petIntakeStep({ state: asked.state, draft: asked.draft }, say('1'), ctx).draft.breed, 'Turkish Van');
  assert.equal(petIntakeStep({ state: asked.state, draft: asked.draft }, say('2'), ctx).draft.breed, 'Turkish Angora');
  const keep = petIntakeStep({ state: asked.state, draft: asked.draft }, say('3'), ctx);
  assert.equal(keep.draft.breed, 'Turkish');
  assert.equal(keep.state, 'pet_name');
  assert.equal(petIntakeStep({ state: asked.state, draft: asked.draft }, say('Turkish Angora'), ctx).draft.breed, 'Turkish Angora');

  // Photos that could not tell: the same question, in the usual order.
  const blind = petPhotosDone(draft, [{ stored: 'p', v: { shows_pet: true, kind: 'cat', face_visible: true } }], ctx);
  assert.match(blind.replies.at(-1), /1 Turkish Angora\n2 Turkish Van\n3 Not sure/);
  // A breed that names one breed is not asked about.
  assert.notEqual(petPhotosDone({ ...draft, breed: 'Persian' }, [cat('Persian')], { ...ctx, knownName: 'Ade' }).state, 'pet_breed_confirm');
});

// ── WHAT SELLERS ASKED AND TYPED IN REAL CHATS ───────────────────────────────

const at = (state, draft = {}) => ({ state, draft: { type: 'Dog', images: [], ...draft } });
const browse = { ...ctx, browseUrl: 'https://pets.test/pets.html' };

test('"when does my listing get approved?" is answered, and never kept as the age', () => {
  const r = petIntakeStep(at('pet_age', { breed: 'American Eskimo' }), say('When does my listing get approved'), ctx);
  assert.equal(r.state, 'pet_age');
  assert.equal(r.draft.age, undefined);
  assert.match(r.replies[0], /PuppyPlace checks every listing before it goes live, usually within a day/);
  assert.match(r.replies[1], /How old is your dog/);
  // At the summary it has not been sent yet: say so, and that YES sends it.
  const review = petIntakeStep(at('pet_review', { breed: 'Boerboel' }), say('When can I get review'), ctx);
  assert.equal(review.state, 'pet_review');
  assert.equal(review.action, null);
  assert.deepEqual(review.replies.length, 1);
  assert.match(review.replies[0], /hasn't been sent yet.*Reply \*YES\*/s);
  // YES with a question still sends it.
  const done = run([...DOG, say('Yes, when will it be live?')]).at(-1);
  assert.equal(done.action.type, 'pet_listing');
  assert.ok(asksAboutApproval('When will my listing be approved?'));
  assert.ok(!asksAboutApproval('Lekki, Lagos'));
  assert.match(petPendingMessage({ store: 'PuppyPlace', breed: 'Boerboel' }), /Your \*Boerboel\* listing is with PuppyPlace for review/);
});

test('a seller asking about videos is told photos only, with how to get one from the video', () => {
  for (const body of ['Can I add video', 'I have the vid only']) {
    const r = petIntakeStep(at('pet_photos'), say(body), ctx);
    assert.equal(r.state, 'pet_photos', body);
    assert.deepEqual(r.replies, ["Videos can't go on the listing, only photos 📸 Tip: pause your video where the dog's face is clear, take a screenshot, and send that."], body);
  }
  // A video that is sent, rather than asked about, is answered the same, not met with the photo question again.
  const sent = petIntakeStep(at('pet_photos'), { hasMedia: true, mediaUrl: 'https://waha.test/v.mp4', mimetype: 'video/mp4', body: '' }, ctx);
  assert.match(sent.replies[0], /Videos can't go on the listing/);
  assert.equal(sent.replies.length, 1);
  const withPhotos = petIntakeStep(at('pet_photos', { images: [{ url: 'u' }] }), { hasMedia: true, mediaUrl: 'https://waha.test/v.mp4', mimetype: 'video/mp4' }, ctx);
  assert.match(withPhotos.replies[1], /Send more, or type \*done\*/);
  // A voice note is not taken as an answer either.
  const voice = petIntakeStep(at('pet_age'), { hasMedia: true, mediaUrl: 'https://waha.test/a.ogg', mimetype: 'audio/ogg; codecs=opus' }, ctx);
  assert.equal(voice.state, 'pet_age');
  assert.match(voice.replies[0], /can't listen to voice notes/);
  assert.match(voice.replies[1], /How old/);
});

test('a seller who will take the photos later keeps their answers for days, and is welcomed back', () => {
  for (const body of ["Can I snap it when I get home later If it's not late for Me to do that because am not with her", 'Later its dark now']) {
    const r = petIntakeStep(at('pet_photos', { breed: 'Lhasa' }), say(body), ctx);
    assert.equal(r.state, 'pet_photos', body);
    assert.deepEqual(r.replies, [`No problem 👍 I'll keep your answers for ${PHOTOS_WAIT_HOURS / 24} days. When you're with your dog, send the photos here (daylight is best) and type *done*.`], body);
  }
  const now = Date.parse('2026-10-20T10:00:00Z');
  const hoursAgo = (h) => new Date(now - h * 3_600_000).toISOString();
  const waiting = (h, state = 'pet_photos') => ({ ...at(state, { breed: 'Lhasa', age: '1yr' }), updated_at: hoursAgo(h) });
  // Next morning: the photo carries on where they left off.
  const back = petIntakeStep(waiting(20), photo(1), { ...ctx, now });
  assert.equal(back.state, 'pet_photos');
  assert.match(back.replies[0], /Got it/);
  // Or they open with the site's message again: offered their answers back.
  const opener = petIntakeStep(waiting(20), say('Hi PuppyPlace, I want to sell my dog.'), { ...ctx, now });
  assert.equal(opener.state, 'pet_photos');
  assert.match(opener.replies[0], /Welcome back! I still have your \*Lhasa\* listing.*reply \*NEW\*/s);
  assert.match(opener.replies[1], /Now send clear, recent photos/);
  const fresh = petIntakeStep(opener, say('new'), ctx);
  assert.equal(fresh.state, 'pet_type');
  assert.deepEqual(fresh.draft, { images: [] });
  // Anything else, hours later, is left for the owner rather than met with a reminder.
  assert.equal(petIntakeStep(waiting(20), say('Good morning sir, how is business?'), { ...ctx, now }), null);
  // Photos sent last night and "done" this morning: checked as usual.
  const sentLastNight = { ...waiting(20), draft: { ...waiting(20).draft, images: [{ url: 'u' }] } };
  assert.equal(petIntakeStep(sentLastNight, say('Done'), { ...ctx, now }).action.type, 'process_photos');
  // Within the hour, "done, more later" still finishes the photos.
  const finish = petIntakeStep(at('pet_photos', { breed: 'Lhasa', images: [{ url: 'u' }] }), say("Done, I'll send more later"), ctx);
  assert.equal(finish.action.type, 'process_photos');
  // And a seller telling buyers why they are selling is answering, not starting over.
  const notes = petIntakeStep(at('pet_notes', { breed: 'Lhasa' }), say("I am selling my puppies because we're relocating"), ctx);
  assert.equal(notes.state, 'pet_photos');
  assert.equal(notes.draft.notes, "I am selling my puppies because we're relocating");
  // Past the wait, or left for hours at any other question, it starts over as before.
  assert.equal(petIntakeStep(waiting(PHOTOS_WAIT_HOURS + 1), photo(1), { ...ctx, now }), null);
  assert.equal(petIntakeStep(waiting(STALE_AFTER_HOURS + 1, 'pet_age'), say('10 weeks'), { ...ctx, now }), null);
});

test('"does your store buy puppies?" is answered, and the breed in the same message is kept', () => {
  const r = petIntakeStep(
    at('pet_breed'),
    say('Please, I would like to make an enquiry. I have a purebred Eskimo puppy, and I’m looking for a buyer. I would like to know if your pet store buys puppies directly or if you could help me connect with buyers'),
    ctx
  );
  assert.equal(r.state, 'pet_age');
  assert.equal(r.draft.breed, 'American Eskimo');
  assert.match(r.replies[0], /PuppyPlace doesn't buy pets itself. We list yours free/);
  assert.match(r.replies[1], /Breed: \*American Eskimo\*/);
  assert.match(r.replies[2], /How old/);
});

test('a breeder with many breeds lists one at a time', () => {
  const many = petIntakeStep(at('pet_breed'), say('Am a dog breeder So I sell many breeds'), ctx);
  assert.equal(many.state, 'pet_breed');
  assert.match(many.replies[0], /Each listing is for one breed.*reply \*SELL\* to list the next/s);
  assert.match(many.replies[1], /What breed is your dog/);
  const list = petIntakeStep(at('pet_breed'), say('Borehole Eskimo Husky German Shepherd Lhasa apso Rottweiler Cane corso'), ctx);
  assert.equal(list.state, 'pet_breed');
  assert.match(list.replies[0], /Which one is this listing for\? \(.*German Shepherd.*Lhasa Apso/);
  // A cross is one dog, and a short answer is kept as typed.
  assert.equal(petIntakeStep(at('pet_breed'), say('Eskimo husky mix'), ctx).draft.breed, 'Eskimo husky mix');
  assert.equal(petIntakeStep(at('pet_breed'), say('Rottweiler and Boerboel cross, 2 pups'), ctx).state, 'pet_age');
  // Two puppies are not a breeder's list.
  const two = petIntakeStep(at('pet_breed'), say('2 different puppies, both females and are rottweiler crossbreed.'), ctx);
  assert.ok(!/one breed/.test(two.replies.join(' ')), two.replies.join(' '));
});

test('"is it free?" and "what price should I sell?" are answered', () => {
  const free = petIntakeStep(at('pet_type'), say('Is it free to list?'), ctx);
  assert.equal(free.state, 'pet_type');
  assert.match(free.replies[0], /Listing on PuppyPlace is free/);
  assert.match(free.replies[1], /What are you listing/);
  const advice = petIntakeStep(at('pet_price', { listing_type: 'sale' }), say('How much should I sell it?'), browse);
  assert.equal(advice.state, 'pet_price');
  assert.equal(advice.draft.price, undefined);
  assert.match(advice.replies[0], /You choose the price.*https:\/\/pets\.test\/pets\.html/s);
  assert.match(advice.replies[1], /How much are you asking/);
});

test('a price with words around it is found, and "negotiable" is kept for buyers', () => {
  assert.deepEqual(pricesIn('50k per puppy'), [50000]);
  assert.deepEqual(pricesIn('45000 for female'), [45000]);
  assert.deepEqual(pricesIn('2 males, 50k each'), [50000]);
  assert.deepEqual(pricesIn('8weeks 150k'), [150000]);
  assert.deepEqual(pricesIn('₦200,000'), [200000]);
  assert.deepEqual(pricesIn('call me'), []);
  assert.deepEqual(pricesIn('N150k'), [150000]);
  for (const body of ['10 weeks', 'Around 12 weeks I guess', '3 pups', '1male 2females', 'Dave_k9']) assert.deepEqual(pricesIn(body), [], body);
  assert.equal(petIntakeStep(at('pet_price', { listing_type: 'sale' }), say('10 weeks'), ctx).replies[0], "I didn't catch a price. Send your price in numbers on its own, like 85000 or 85k.");
  const sale = at('pet_price', { listing_type: 'sale' });
  for (const [body, price] of [['50k per puppy', 50000], ['45000 for female', 45000], ['200,000', 200000]]) {
    const r = petIntakeStep(sale, say(body), ctx);
    assert.equal(r.state, 'pet_location', body);
    assert.equal(r.draft.price, price, body);
  }
  const nego = petIntakeStep(sale, say('200k the we negotiate'), ctx);
  assert.equal(nego.draft.price, 200000);
  assert.equal(nego.draft.negotiable, true);
  // Two prices: which one buyers see.
  const two = petIntakeStep(sale, say('45k for female, 40k for male'), ctx);
  assert.equal(two.state, 'pet_price');
  assert.match(two.replies[0], /₦40,000.*₦45,000/);
  // Negotiable shows at the summary and goes to the site with the notes.
  const out = run([...DOG.slice(0, 4), say('150k negotiable'), ...DOG.slice(5), say('yes')]);
  assert.match(out.at(-2).replies[0], /Price: ₦150,000 \(negotiable\)/);
  assert.equal(out.at(-1).action.listing.description, '3 males, 2 females\nPrice is negotiable.');
});

test('a price under ₦1,000 is checked: "70" is far more often ₦70,000', () => {
  const sale = at('pet_price', { listing_type: 'sale' });
  const asked = petIntakeStep(sale, say('70'), ctx);
  assert.equal(asked.state, 'pet_price');
  assert.match(asked.replies[0], /Did you mean \*₦70,000\*\? Reply \*YES\*, or send the full price \(like 70000 or 70k\)/);
  const yes = petIntakeStep(asked, say('yes'), ctx);
  assert.equal(yes.state, 'pet_location');
  assert.equal(yes.draft.price, 70000);
  assert.equal(yes.draft.priceGuess, undefined);
  assert.equal(petIntakeStep(asked, say('75k'), ctx).draft.price, 75000);
  // The same small amount again is taken as meant.
  assert.equal(petIntakeStep(asked, say('70'), ctx).draft.price, 70);
});

test('"Am selling" and "for adoption" are understood without the number', () => {
  const deal = at('pet_deal');
  for (const body of ['Am selling', 'Selling', 'I want to sell', '1']) assert.equal(petIntakeStep(deal, say(body), ctx).draft.listing_type, 'sale', body);
  for (const body of ['for adoption', 'Free to a good home', 'I want to give her away', '2']) assert.equal(petIntakeStep(deal, say(body), ctx).draft.listing_type, 'adoption', body);
  assert.equal(petIntakeStep(deal, say('maybe'), ctx).state, 'pet_deal');
});

test("the pet's name given as the seller's is kept as the pet's, and the seller's asked for", () => {
  assert.equal(petNameIn('Zoe is her name'), 'Zoe');
  assert.equal(petNameIn("She's female, color white mix with black and her name is Zoe"), 'Zoe');
  assert.equal(petNameIn('Raya is the pet name my name is remina'), 'Raya');
  assert.equal(petNameIn('Ade Kennels'), null);
  for (const body of ['Zoe is her name', 'Lucy is her name']) {
    const r = petIntakeStep(at('pet_name', { breed: 'Lhasa' }), say(body), ctx);
    assert.equal(r.state, 'pet_name', body);
    assert.equal(r.draft.name, undefined, body);
    assert.match(r.replies[0], /I'll show \*(Zoe|Lucy)\* as the dog's name 🐾 And what's \*your\* name/, body);
  }
  const both = petIntakeStep(at('pet_name', { breed: 'Husky' }), say('Raya is the pet name my name is remina'), ctx);
  assert.equal(both.state, 'pet_contact');
  assert.equal(both.draft.name, 'Remina');
  assert.equal(both.draft.petName, 'Raya');
  // Sent to the site as the pet's name; the summary shows it.
  const out = run([...DOG.slice(0, 7), say('Female, her name is Zoe'), ...DOG.slice(8), say('yes')]);
  assert.match(out.at(-2).replies[0], /🐾 Name: Zoe/);
  assert.equal(out.at(-1).action.listing.name, 'Zoe');
  assert.equal(run([...DOG, say('yes')]).at(-1).action.listing.name, undefined);
});

test('words typed in passing are not names: "Done", "Or", "My kennel Brand name", a question', () => {
  for (const body of ['Done', 'Or', 'My kennel Brand name', 'My name is', 'Can I use my kennel name?', 'TQ']) {
    assert.equal(parseSellerName(body), null, body);
  }
  assert.equal(parseSellerName('Will Smith Kennels'), 'Will Smith Kennels');
  assert.equal(parseSellerName('golden kennels'), 'Golden Kennels');
  assert.equal(parseSellerName('Dave_k9'), 'Dave_k9');
  assert.match(petIntakeStep(at('pet_name'), say('Done'), ctx).replies[0], /doesn't look like a real name/);
});

test('the seller name can be changed at the summary in one message', () => {
  const summary = at('pet_review', { breed: 'Lhasa', age: '1yr', listing_type: 'sale', price: 70000, location: 'Mowe', name: 'Zoe is her name', whatsapp: '2348031234567', images: [{ url: 'u' }] });
  for (const [body, name] of [['Change the seller name Kenny', 'Kenny'], ['Add my name remina', 'Remina'], ['my name is Kenny', 'Kenny']]) {
    const r = petIntakeStep(summary, say(body), ctx);
    assert.equal(r.state, 'pet_review', body);
    assert.equal(r.draft.name, name, body);
    assert.match(r.replies[0], new RegExp(`Seller: ${name}, \\+2348031234567`), body);
  }
  const both = petIntakeStep(summary, say('Raya is the pet name my name is remina'), ctx);
  assert.equal(both.draft.name, 'Remina');
  assert.equal(both.draft.petName, 'Raya');
  assert.equal(petIntakeStep(summary, say('TQ'), ctx).draft.name, 'Zoe is her name');
});

test('"No, <breed>" to a breed the photos suggested keeps the breed without the no', () => {
  const r = petIntakeStep(at('pet_breed_confirm', { breed: null, breedSuggest: 'mixed', age: '1-3months', images: [{ stored: 'p0' }] }), say('No Purebreed American Eskimo'), ctx);
  assert.equal(r.draft.breed, 'Purebreed American Eskimo');
});

test('a cat or another pet is asked for its breed with examples that fit', () => {
  assert.match(petIntakeStep(null, say('I want to sell my kitten'), ctx).replies[1], /What breed is your cat\? \(e\.g\. Persian, Siamese, or "mixed"\)/);
  assert.match(petIntakeStep(at('pet_type'), say('3'), ctx).replies[0], /What kind of pet is it, and what breed\?/);
});

test('a seller who stopped at the photos is due one reminder, hours later, in the Lagos daytime', () => {
  // 13:00 in Lagos is 12:00 UTC.
  const noon = Date.parse('2026-10-20T12:00:00Z');
  const conv = (hoursAgo, draft = {}, extra = {}) => ({
    state: 'pet_photos', draft: { type: 'Dog', breed: 'Boerboel', images: [], ...draft },
    updated_at: new Date(noon - hoursAgo * 3_600_000).toISOString(), paused_until: null, ...extra,
  });
  assert.equal(petReminderDue(conv(REMIND_AFTER_HOURS + 0.1), noon), true);
  assert.equal(petReminderDue(conv(REMIND_AFTER_HOURS - 0.5), noon), false, 'too soon');
  assert.equal(petReminderDue(conv(PHOTOS_WAIT_HOURS + 1), noon), false, 'answers no longer kept');
  assert.equal(petReminderDue(conv(5, { remindedAt: '2026-10-20T08:00:00Z' }), noon), false, 'reminded already');
  assert.equal(petReminderDue(conv(5, {}, { paused_until: new Date(noon + 3_600_000).toISOString() }), noon), false, 'owner is in the chat');
  assert.equal(petReminderDue({ ...conv(5), state: 'pet_age' }, noon), false, 'only the photos step');
  // Not at night: 23:00 and 06:00 in Lagos wait for the morning.
  const at = (iso) => { const t = Date.parse(iso); return [{ ...conv(0), updated_at: new Date(t - 5 * 3_600_000).toISOString() }, t]; };
  assert.equal(petReminderDue(...at('2026-10-20T22:00:00Z')), false, '23:00 in Lagos');
  assert.equal(petReminderDue(...at('2026-10-20T05:00:00Z')), false, '06:00 in Lagos');
  assert.equal(petReminderDue(...at('2026-10-20T07:00:00Z')), true, '08:00 in Lagos');

  assert.match(petReminderMessage({ store: 'PuppyPlace', draft: conv(5).draft }), /Your \*Boerboel\* listing on PuppyPlace is nearly done\. It just needs photos.*type \*done\*.*nothing to fill in again.*\*CANCEL\*/s);
  assert.match(petReminderMessage({ store: 'PuppyPlace', draft: { type: 'Cat', images: [{ url: 'u' }, { url: 'v' }] } }), /Your cat listing on PuppyPlace is nearly done\. You've sent 2 photos\. Send any more, then type \*done\*/);
});
