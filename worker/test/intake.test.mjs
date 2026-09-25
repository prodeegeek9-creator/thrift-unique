import test from 'node:test';
import assert from 'node:assert/strict';

import {
  intakeStep,
  approvedSellerMessage,
  declinedSellerMessage,
  newSubmissionMessage,
} from '../lib/intake.js';
import { MAX_IMAGES, STALE_AFTER_HOURS } from '../lib/bot.js';

// The conversation somebody has with a thrift store's own WhatsApp to offer it
// an item. Pure, so every branch is tested without a server.

const photo = (n = 1) => ({ hasMedia: true, mediaUrl: `https://waha.test/api/files/s/${n}.jpg`, mimetype: 'image/jpeg' });
const say = (body) => ({ body });
const ctx = { store: 'Ada Thrift' };

// Runs a whole conversation, carrying state between messages the way the
// webhook does through bot_conversations.
function run(messages, context = ctx) {
  let conversation = null;
  const out = [];
  for (const m of messages) {
    const r = intakeStep(conversation, m, context);
    out.push(r);
    if (r) conversation = { state: r.state, draft: r.draft };
  }
  return out;
}

test('a message that does not start with SELL is left for the store', () => {
  for (const body of ['hello', 'Do you sell bags?', 'how much is the jacket', '']) {
    assert.equal(intakeStep(null, say(body), ctx), null, body);
  }
  assert.equal(intakeStep(null, photo(), ctx), null);
  // An idle conversation left over from before is not a reason to answer.
  assert.equal(intakeStep({ state: 'idle', draft: {} }, say('hi'), ctx), null);
});

test('SELL starts it, in the store name, and the link text counts', () => {
  const r = intakeStep(null, say("SELL — I'd like Ada Thrift to sell an item for me"), ctx);
  assert.equal(r.state, 'photo');
  assert.match(r.replies[0], /Ada Thrift assistant/);
  assert.match(r.replies[0], /photo/i);
  assert.equal(intakeStep(null, say('sell'), ctx).state, 'photo');
});

test('an item goes from SELL to a submission', () => {
  const steps = run([
    say('SELL'),
    photo(1),
    photo(2),
    say('Brown leather bag'),
    say('15k'),
    say('3'),
    say('Ada Obi'),
    say('yes'),
  ]);

  assert.deepEqual(
    steps.map((s) => s.state),
    ['photo', 'photo', 'photo', 'price', 'condition', 'name', 'review', 'idle']
  );
  assert.match(steps[6].replies[0], /Your price: ₦15,000/);
  assert.match(steps[6].replies[0], /From: Ada Obi/);

  const { action } = steps.at(-1);
  assert.equal(action.type, 'submit');
  assert.deepEqual(action.submission, {
    title: 'Brown leather bag',
    asking_price: 15000,
    condition: 'good',
    seller_name: 'Ada Obi',
  });
  assert.equal(action.images.length, 2);
});

test('a seller who has sent items before is not asked their name again', () => {
  const steps = run([say('SELL'), photo(), say('Bag'), say('10000'), say('2')], {
    ...ctx,
    knownName: 'Ada Obi',
  });
  assert.equal(steps.at(-1).state, 'review');
  assert.match(steps.at(-1).replies[0], /From: Ada Obi/);
});

test('a name is not taken before there is a photo', () => {
  const steps = run([say('SELL'), say('Bag')]);
  assert.equal(steps[1].state, 'photo');
  assert.match(steps[1].replies[0], /at least one photo/i);
});

test('bad answers are asked again, and photos stop at the limit', () => {
  const priced = run([say('SELL'), photo(), say('Bag'), say('cheap')]);
  assert.equal(priced.at(-1).state, 'price');

  const conditioned = run([say('SELL'), photo(), say('Bag'), say('5k'), say('7')]);
  assert.equal(conditioned.at(-1).state, 'condition');

  const many = run([say('SELL'), ...Array.from({ length: MAX_IMAGES + 2 }, (_, i) => photo(i))]);
  assert.equal(many.at(-1).draft.images.length, MAX_IMAGES);
  // One note about the limit, not one per extra photo.
  assert.equal(many.filter((s) => s.replies.some((r) => /limit/.test(r))).length, 1);
});

test('cancel stops it, and the review needs a yes', () => {
  const cancelled = run([say('SELL'), photo(), say('cancel')]);
  assert.equal(cancelled.at(-1).state, 'idle');
  assert.equal(cancelled.at(-1).action, null);

  const unclear = run([say('SELL'), photo(), say('Bag'), say('5k'), say('1'), say('Ada'), say('hmm')]);
  assert.equal(unclear.at(-1).state, 'review');
  assert.equal(unclear.at(-1).action, null);

  const no = run([say('SELL'), photo(), say('Bag'), say('5k'), say('1'), say('Ada'), say('no')]);
  assert.equal(no.at(-1).state, 'idle');
  assert.equal(no.at(-1).action, null);
});

test('a conversation left for hours is forgotten', () => {
  const old = new Date(Date.now() - (STALE_AFTER_HOURS + 1) * 3_600_000).toISOString();
  const stale = { state: 'price', draft: { images: [photo()], title: 'Bag' }, updated_at: old };
  assert.equal(intakeStep(stale, say('5000'), ctx), null);
  assert.equal(intakeStep(stale, say('SELL'), ctx).state, 'photo');
});

test('what the seller and the owner are told', () => {
  const yes = approvedSellerMessage({ store: 'Ada Thrift', title: 'Bag', price: 20000, link: 'https://x/p/AB12' });
  assert.match(yes, /listed your \*Bag\* for ₦20,000/);
  assert.match(yes, /https:\/\/x\/p\/AB12/);

  const no = declinedSellerMessage({ store: 'Ada Thrift', title: 'Bag', reason: 'No shoes' });
  assert.match(no, /won't be listing your \*Bag\*/);
  assert.match(no, /Reason: No shoes/);
  assert.doesNotMatch(declinedSellerMessage({ store: 'A', title: 'B', reason: null }), /Reason/);

  const owner = newSubmissionMessage({ title: 'Bag', price: 15000, name: 'Ada', origin: 'https://ut.ng' });
  assert.match(owner, /Bag\*, ₦15,000 asked, from Ada/);
  assert.match(owner, /https:\/\/ut\.ng\/dashboard\/submissions/);
});
