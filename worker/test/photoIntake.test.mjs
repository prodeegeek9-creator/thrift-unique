import test from 'node:test';
import assert from 'node:assert/strict';

import {
  photoIntakeStep,
  photoStatusMessage,
  shotsFor,
  flagsToAsk,
  PHOTO_STATES,
  MAX_EARLY_PHOTOS,
} from '../lib/photoIntake.js';

// The conversation alone: no database, no WhatsApp. The webhook around it is
// covered in waha.test.mjs.

const CATEGORIES = [
  { slug: 'clothing', name: 'Clothing' },
  { slug: 'shoes', name: 'Shoes' },
  { slug: 'gadgets', name: 'Gadgets' },
];

const RULES = [
  { category: 'clothing', shot_type: 'front', label: 'Front', requirement: 'required', condition_flag: null, sort_order: 1 },
  { category: 'clothing', shot_type: 'back', label: 'Back', requirement: 'required', condition_flag: null, sort_order: 2 },
  { category: 'clothing', shot_type: 'label', label: 'Size/brand label', requirement: 'required', condition_flag: null, sort_order: 3 },
  { category: 'clothing', shot_type: 'flaw', label: 'Flaw close-up', requirement: 'conditional', condition_flag: 'has_flaws', sort_order: 4 },
  { category: 'clothing', shot_type: 'on_model', label: 'Worn on a model', requirement: 'optional', condition_flag: null, sort_order: 5 },
  { category: 'gadgets', shot_type: 'front', label: 'Front', requirement: 'required', condition_flag: null, sort_order: 1 },
  { category: 'gadgets', shot_type: 'about_screen', label: 'About phone', requirement: 'conditional', condition_flag: 'is_phone', sort_order: 4 },
  { category: 'gadgets', shot_type: 'flaw', label: 'Flaw close-up', requirement: 'conditional', condition_flag: 'has_flaws', sort_order: 5 },
  { category: 'gadgets', shot_type: 'mystery', label: 'Mystery', requirement: 'conditional', condition_flag: 'unknown_flag', sort_order: 6 },
];

const CTX = { store: 'Kay Stores', categories: CATEGORIES, rules: RULES };

const text = (body) => ({ body });
const photo = (id = 'm1') => ({ id, body: '', hasMedia: true, mediaUrl: `https://waha.test/api/files/s/${id}.jpg`, mimetype: 'image/jpeg' });

// Feeds messages through the step the way the route does: each result's
// state and draft become the next turn's conversation.
function run(messages, ctx = CTX, start = null) {
  let conversation = start;
  const results = [];
  for (const m of messages) {
    const r = photoIntakeStep(conversation, m, ctx);
    results.push(r);
    if (r) conversation = { state: r.state, draft: r.draft, updated_at: new Date().toISOString() };
  }
  return { results, last: results.at(-1), conversation };
}

test('nothing in progress and no SELL: not ours, so the owner answers', () => {
  assert.equal(photoIntakeStep(null, text('Is the bag still available?'), CTX), null);
  assert.equal(photoIntakeStep({ state: 'idle', draft: {} }, text('hello'), CTX), null);
  assert.equal(photoIntakeStep(null, photo(), CTX), null);
  // "do you sell bags?" is a customer, not a seller.
  assert.equal(photoIntakeStep(null, text('do you sell bags?'), CTX), null);
});

test('SELL opens with the category menu', () => {
  const r = photoIntakeStep(null, text('SELL'), CTX);
  assert.equal(r.state, 'pi_category');
  assert.match(r.replies[0], /Kay Stores assistant/);
  assert.match(r.replies[0], /1 Clothing\n2 Shoes\n3 Gadgets/);
});

test('with no categories configured, SELL gets an apology rather than a dead end', () => {
  const r = photoIntakeStep(null, text('SELL'), { ...CTX, categories: [] });
  assert.equal(r.state, 'idle');
  assert.match(r.replies[0], /can't take items/);
});

test('a full item, from SELL to the photo list', () => {
  const { results, last } = run([
    text('SELL'),
    text('1'),
    text('Black Zara blazer, size M'),
    text('15k'),
    text('3'),
    text('yes'), // has flaws
    text('Ada Obi'),
    text('YES'),
  ]);

  assert.equal(results[1].state, 'pi_title');
  assert.equal(results[4].state, 'pi_flag');
  assert.match(results[4].replies[0], /flaws/);
  assert.equal(results[6].state, 'pi_review');
  assert.match(results[6].replies[0], /\*Black Zara blazer, size M\*/);
  assert.match(results[6].replies[0], /Clothing/);
  assert.match(results[6].replies[0], /₦15,000/);
  assert.match(results[6].replies[0], /Good/);
  assert.match(results[6].replies[0], /Has flaws/);
  assert.match(results[6].replies[0], /From: Ada Obi/);

  assert.equal(last.state, 'pi_photos');
  assert.deepEqual(last.action, {
    type: 'create_draft',
    item: {
      category: 'clothing',
      flags: ['has_flaws'],
      title: 'Black Zara blazer, size M',
      asking_price: 15000,
      condition: 'good',
      seller_name: 'Ada Obi',
    },
    early: [],
  });
  // The flaw close-up is asked for because they said it has flaws.
  assert.match(last.replies[0], /• Front\n• Back\n• Size\/brand label\n• Flaw close-up/);
  assert.match(last.replies[0], /Optional: Worn on a model/);
});

test('no flaws means no flaw close-up', () => {
  const { last } = run([text('SELL'), text('1'), text('Shirt'), text('5000'), text('2'), text('no'), text('Ada'), text('y')]);
  assert.deepEqual(last.action.item.flags, []);
  assert.doesNotMatch(last.replies[0], /Flaw/);
});

test('every flag the category asks about is asked, once, in rule order — and an unknown flag never is', () => {
  const { results, last } = run([
    text('SELL'),
    text('3'),
    text('iPhone 12'),
    text('250k'),
    text('2'),
    text('yes'), // is a phone
    text('no'), // no flaws
    text('Tobi'),
    text('yes'),
  ]);
  assert.match(results[4].replies[0], /phone/i);
  assert.match(results[5].replies[0], /flaws/);
  assert.equal(results[6].state, 'pi_name');
  assert.deepEqual(last.action.item.flags, ['is_phone']);
  assert.match(last.replies[0], /About phone/);
});

test('a category with no conditional rules goes straight from condition to name', () => {
  const { results } = run([text('SELL'), text('2'), text('Nike Air Max'), text('40000'), text('1')]);
  assert.equal(results[4].state, 'pi_name');
});

test('a seller we know is not asked their name again', () => {
  const { results } = run(
    [text('SELL'), text('2'), text('Nike Air Max'), text('40000'), text('1')],
    { ...CTX, knownName: 'Ada Obi' }
  );
  assert.equal(results[4].state, 'pi_review');
  assert.match(results[4].replies[0], /From: Ada Obi/);
});

test('categories by name, and bad answers asked again', () => {
  const { results } = run([text('SELL'), text('9'), text('sho'), text('Boots'), text('a lot'), text('12k'), text('9'), text('4')]);
  assert.equal(results[1].state, 'pi_category');
  assert.match(results[1].replies[0], /Reply with one of these numbers/);
  assert.equal(results[2].state, 'pi_title'); // "sho" → Shoes
  assert.equal(results[4].state, 'pi_price');
  assert.match(results[4].replies[0], /didn't catch a price/);
  assert.equal(results[6].state, 'pi_condition');
  assert.equal(results[7].state, 'pi_name');
});

test('a flag question that is not answered yes or no is asked again', () => {
  const { results } = run([text('SELL'), text('1'), text('Shirt'), text('5k'), text('3'), text('maybe')]);
  assert.equal(results[5].state, 'pi_flag');
  assert.match(results[5].replies[0], /flaws/);
});

test('photos sent before the details are kept, and checked once the draft exists', () => {
  const { results, last } = run([
    { ...photo('early-1'), body: 'SELL' },
    text('1'),
    photo('early-2'),
    text('Shirt'),
    text('5k'),
    text('3'),
    text('no'),
    text('Ada'),
    text('yes'),
  ]);
  assert.match(results[2].replies[0], /Got the photo/);
  assert.match(results[2].replies[0], /What is the item called/);
  assert.equal(results[2].state, 'pi_title');

  assert.equal(last.action.early.length, 2);
  assert.equal(last.action.early[0].id, 'early-1');
  assert.equal(last.action.early[1].url, 'https://waha.test/api/files/s/early-2.jpg');
  assert.match(last.replies[0], /checking the 2 photos you already sent/);
  // Already acknowledged, so the next photo is not "checking…" again.
  assert.equal(last.draft.acked, true);
});

test('early photos are capped', () => {
  const many = Array.from({ length: MAX_EARLY_PHOTOS + 3 }, (_, i) => photo(`p${i}`));
  const { conversation } = run([text('SELL'), ...many]);
  assert.equal(conversation.draft.early.length, MAX_EARLY_PHOTOS);
});

test('while photos come in: each is checked, and only the first is acknowledged', () => {
  const start = { state: 'pi_photos', draft: { draft_id: 'd1', title: 'Shirt', category: 'clothing', acked: false } };
  const { results } = run([photo('a'), photo('b')], CTX, start);
  assert.equal(results[0].action.type, 'check_photo');
  assert.equal(results[0].action.ack, true);
  assert.equal(results[0].action.image.id, 'a');
  assert.equal(results[1].action.ack, false);
  assert.deepEqual(results[0].replies, []);
});

test('while photos come in: status words ask where things stand; chat is left for the owner', () => {
  const start = { state: 'pi_photos', draft: { draft_id: 'd1', title: 'Shirt' } };
  for (const t of ['status', 'done', 'ok', 'SELL', '?']) {
    assert.deepEqual(photoIntakeStep(start, text(t), CTX).action, { type: 'photo_status' }, t);
  }
  const chat = photoIntakeStep(start, text('Thank you, I will send the rest tomorrow evening'), CTX);
  assert.equal(chat.state, 'pi_photos');
  assert.equal(chat.action, null);
  assert.deepEqual(chat.replies, []);
});

test('waiting on photos does not go stale; a half-answered question does', () => {
  const old = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const waiting = { state: 'pi_photos', draft: { draft_id: 'd1' }, updated_at: old };
  assert.equal(photoIntakeStep(waiting, photo(), CTX).action.type, 'check_photo');

  const asking = { state: 'pi_price', draft: {}, updated_at: old };
  assert.equal(photoIntakeStep(asking, text('15k'), CTX), null);
});

test('cancel drops the open draft while photos come in, and just ends the chat before', () => {
  const during = photoIntakeStep({ state: 'pi_photos', draft: { draft_id: 'd1' } }, text('cancel'), CTX);
  assert.equal(during.state, 'idle');
  assert.deepEqual(during.action, { type: 'cancel_draft', draftId: 'd1' });

  const before = photoIntakeStep({ state: 'pi_price', draft: {} }, text('cancel'), CTX);
  assert.equal(before.state, 'idle');
  assert.equal(before.action, null);
  assert.match(before.replies[0], /Cancelled/);
});

test('NO at the summary cancels; anything else asks again', () => {
  const start = { state: 'pi_review', draft: { category: 'clothing', title: 'Shirt', price: 5000, condition: 'good', name: 'Ada' } };
  assert.equal(photoIntakeStep(start, text('no'), CTX).state, 'idle');
  const again = photoIntakeStep(start, text('hmm'), CTX);
  assert.equal(again.state, 'pi_review');
  assert.match(again.replies[0], /Reply \*YES\*/);
});

test('a summary missing something after a deploy starts over rather than filing half an item', () => {
  const r = photoIntakeStep({ state: 'pi_review', draft: { category: 'clothing', title: 'Shirt' } }, text('yes'), CTX);
  assert.equal(r.state, 'idle');
  assert.equal(r.action, null);
});

test('shotsFor and flagsToAsk read the rules the way the database does', () => {
  assert.deepEqual(shotsFor(RULES, 'clothing'), { needed: ['Front', 'Back', 'Size/brand label'], optional: ['Worn on a model'] });
  assert.deepEqual(shotsFor(RULES, 'clothing', ['has_flaws']).needed.at(-1), 'Flaw close-up');
  assert.deepEqual(flagsToAsk(RULES, 'gadgets'), ['is_phone', 'has_flaws']);
  assert.deepEqual(flagsToAsk(RULES, 'shoes'), []);
});

test('the status message', () => {
  assert.match(photoStatusMessage({ title: 'Shirt', missing: ['Back', 'Size/brand label'], store: 'Kay' }), /Still needed for \*Shirt\*:\n• Back\n• Size\/brand label/);
  assert.match(photoStatusMessage({ title: 'Shirt', missing: [], store: 'Kay' }), /All the photos for \*Shirt\* are in/);
});

test('states never collide with the old intake', () => {
  for (const s of PHOTO_STATES) assert.match(s, /^pi_/);
});
