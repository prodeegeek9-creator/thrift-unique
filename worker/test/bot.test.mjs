import test from 'node:test';
import assert from 'node:assert/strict';

import {
  step,
  parsePrice,
  parseCondition,
  listedMessage,
  formatNaira,
  MAX_IMAGES,
  MAX_TITLE,
  STALE_AFTER_HOURS,
  signupStep,
  approvedMessage,
  MAX_BUSINESS_NAME,
} from '../lib/bot.js';
import { slugFor } from '../lib/provision.js';
import { parseEvent, chatId, phoneFromChatId, sessionName } from '../lib/waha.js';
import { storagePath, publicUrl, BUCKET } from '../lib/media.js';

// The listing conversation is a pure function, which is the only reason these
// tests exist at all: every branch a seller can take is reachable without a
// WhatsApp account, a WAHA server or a network.

const TENANT = { id: 'tenant-1', slug: 'store', name: 'Thrift Store' };
const CTX = { tenant: TENANT, origin: 'https://uniquethrift.ng' };

function text(body) {
  return { body, hasMedia: false, mediaUrl: null, mimetype: null };
}

function photo(url = 'https://waha.test/files/a.jpg', mimetype = 'image/jpeg') {
  return { body: '', hasMedia: true, mediaUrl: url, mimetype };
}

// Drives a whole conversation and hands back the last result plus everything
// said along the way, so a test can assert on the shape of the exchange rather
// than on one step at a time.
function converse(messages, ctx = CTX) {
  let conversation = null;
  const said = [];
  let last = null;

  for (const m of messages) {
    last = step(conversation, m, ctx);
    said.push(...last.replies);
    conversation = { state: last.state, draft: last.draft };
  }

  return { ...last, said };
}

// ── PRICES ───────────────────────────────────────────────────────────────────

test('prices are read the way Nigerians write them', () => {
  assert.equal(parsePrice('35000'), 35000);
  assert.equal(parsePrice('35,000'), 35000);
  assert.equal(parsePrice('₦35,000'), 35000);
  assert.equal(parsePrice('NGN 35000'), 35000);
  // The one that matters. "35k" is how a price is actually typed, and a bot
  // that cannot read it looks broken on the first attempt.
  assert.equal(parsePrice('35k'), 35000);
  assert.equal(parsePrice('35 K'), 35000);
  assert.equal(parsePrice('1.5m'), 1_500_000);
  assert.equal(parsePrice('2500.50'), 2500.5);
});

test('prices that are not prices are refused rather than guessed at', () => {
  for (const bad of ['', '   ', 'cheap', 'abc', '0', '-100', '35k naira please', '999999999999']) {
    assert.equal(parsePrice(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});

test('a price never arrives with more precision than the column holds', () => {
  // numeric(12,2). A third decimal place would be rejected by Postgres after
  // the seller had already been told the item was going up.
  for (const input of ['1234.567', '0.999', '99.995']) {
    const parsed = parsePrice(input);
    if (parsed == null) continue;
    assert.equal(parsed, Math.round(parsed * 100) / 100, input);
  }
});

test('conditions accept both the number and the word', () => {
  assert.equal(parseCondition('1'), 'brand_new');
  assert.equal(parseCondition('brand new'), 'brand_new');
  assert.equal(parseCondition('NEW'), 'brand_new');
  assert.equal(parseCondition('2'), 'excellent');
  assert.equal(parseCondition('3'), 'good');
  assert.equal(parseCondition('fair'), 'fair');
  assert.equal(parseCondition('mint'), null);
  assert.equal(parseCondition(''), null);
});

// ── THE HAPPY PATH ───────────────────────────────────────────────────────────

test('a photo, a name, a price and a number make a listing', () => {
  const result = converse([
    photo(),
    text('Brown leather jacket'),
    text('35k'),
    text('2'),
    text('yes'),
  ]);

  assert.equal(result.action?.type, 'create_product');
  assert.deepEqual(result.action.product, {
    title: 'Brown leather jacket',
    price: 35000,
    condition: 'excellent',
    allow_negotiation: false,
  });
  assert.equal(result.action.images.length, 1);

  // Back to idle with nothing left over — the next photo starts a new item,
  // not a continuation of this one.
  assert.equal(result.state, 'idle');
  assert.deepEqual(result.draft, {});
});

test('the deep link from the dashboard starts the flow, not a greeting', () => {
  // src/lib/whatsapp.js pre-types this into WhatsApp. If it matched the
  // greeting branch the button would do nothing but print a help menu.
  const result = converse([text('Hi! I want to list a new item.\nStore: store')]);
  assert.equal(result.state, 'photo');
});

test('NEGOTIABLE posts the item and turns offers on in one word', () => {
  const result = converse([
    photo(),
    text('Sneakers'),
    text('12000'),
    text('3'),
    text('negotiable'),
  ]);

  assert.equal(result.action.product.allow_negotiation, true);
});

test('the review step says what is about to be posted', () => {
  const result = converse([photo(), text('Ankara dress'), text('8500'), text('1')]);

  const summary = result.replies.at(-1);
  assert.match(summary, /Ankara dress/);
  assert.match(summary, /₦8,500/);
  assert.match(summary, /Brand new/);
  // The store's name, because a seller with two stores needs to know which one
  // is about to carry this.
  assert.match(summary, /Thrift Store/);
});

// ── WHAT SELLERS ACTUALLY DO ─────────────────────────────────────────────────

test('several photos then a name, without a "done" in between', () => {
  const result = converse([
    photo('https://waha.test/1.jpg'),
    photo('https://waha.test/2.jpg'),
    photo('https://waha.test/3.jpg'),
    text('Vintage denim'),
    text('20k'),
    text('good'),
    text('y'),
  ]);

  assert.equal(result.action.images.length, 3);
  assert.equal(result.action.product.title, 'Vintage denim');
});

test('"done" ends the photos without becoming the item name', () => {
  const result = converse([text('list'), photo(), text('done')]);

  assert.equal(result.state, 'title');
  assert.equal(result.draft.title, undefined);
  assert.match(result.replies.at(-1), /called/i);
});

test('photos stop at the limit instead of growing without bound', () => {
  const messages = [text('list')];
  for (let i = 0; i < MAX_IMAGES + 3; i++) messages.push(photo(`https://waha.test/${i}.jpg`));

  const result = converse(messages);
  assert.equal(result.draft.images.length, MAX_IMAGES);
});

test('a photo sent mid-question is kept, not treated as an answer', () => {
  // A seller remembering a better angle while the bot is asking the price.
  const result = converse([
    photo('https://waha.test/1.jpg'),
    text('Handbag'),
    photo('https://waha.test/2.jpg'),
    text('15k'),
    text('3'),
    text('yes'),
  ]);

  assert.equal(result.action.images.length, 2);
  assert.equal(result.action.product.price, 15000);
});

test('a bad price re-asks instead of moving on with nothing', () => {
  const result = converse([photo(), text('Watch'), text('how much do you think')]);

  assert.equal(result.state, 'price');
  assert.match(result.replies.at(-1), /didn't catch a price/i);
  assert.equal(result.draft.price, undefined);
});

test('a bad condition re-asks and does not invent one', () => {
  const result = converse([photo(), text('Watch'), text('15k'), text('pretty nice')]);

  assert.equal(result.state, 'condition');
  assert.equal(result.draft.condition, undefined);
});

test('cancel works from anywhere, including one word from the end', () => {
  for (const at of [1, 2, 3, 4]) {
    const messages = [photo(), text('Shoes'), text('9000'), text('3')].slice(0, at);
    messages.push(text('cancel'));

    const result = converse(messages);
    assert.equal(result.state, 'idle', `cancel at step ${at}`);
    assert.equal(result.action, null);
    assert.deepEqual(result.draft, {});
  }
});

test('"no" at the review step posts nothing', () => {
  const result = converse([photo(), text('Shoes'), text('9000'), text('3'), text('no')]);

  assert.equal(result.action, null);
  assert.equal(result.state, 'idle');
  assert.match(result.replies.at(-1), /Nothing was posted/i);
});

test('an unrecognised answer at review re-asks rather than posting', () => {
  // The one place where guessing wrong creates a live listing, so an ambiguous
  // reply must never be read as consent.
  for (const reply of ['maybe', 'hmm', 'what', '👍']) {
    const result = converse([photo(), text('Shoes'), text('9000'), text('3'), text(reply)]);
    assert.equal(result.action, null, `"${reply}" posted an item`);
    assert.equal(result.state, 'review');
  }
});

test('a listing cannot be started without a photo', () => {
  const result = converse([text('list'), text('done')]);

  assert.equal(result.state, 'photo');
  assert.match(result.replies.at(-1), /at least one photo/i);
});

test('a long title is cut to what the column holds', () => {
  const result = converse([photo(), text('x'.repeat(MAX_TITLE + 50)), text('1000'), text('3'), text('yes')]);

  assert.equal(result.action.product.title.length, MAX_TITLE);
});

test('a video is not stored as a photo', () => {
  const result = converse([
    { body: '', hasMedia: true, mediaUrl: 'https://waha.test/clip.mp4', mimetype: 'video/mp4' },
  ]);

  // Nothing to list, so it falls through to the help text rather than opening
  // a draft whose one image will never render.
  assert.equal(result.state, 'idle');
  assert.equal(result.draft.images, undefined);
});

// ── RESUMING ─────────────────────────────────────────────────────────────────

test('a conversation left for hours starts over instead of resuming', () => {
  const stale = {
    state: 'price',
    draft: { title: 'Forgotten jacket', images: [{ url: 'x' }] },
    updated_at: new Date(Date.now() - (STALE_AFTER_HOURS + 1) * 3_600_000).toISOString(),
  };

  const result = step(stale, text('35000'), CTX);

  // "35000" answers a question the seller no longer remembers being asked, so
  // it must not silently price an item they had forgotten about.
  assert.equal(result.state, 'idle');
  assert.notEqual(result.draft.title, 'Forgotten jacket');
});

test('a conversation from a few minutes ago resumes where it was', () => {
  const fresh = {
    state: 'price',
    draft: { title: 'Jacket', images: [] },
    updated_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  };

  const result = step(fresh, text('35k'), CTX);
  assert.equal(result.state, 'condition');
  assert.equal(result.draft.title, 'Jacket');
});

test('a draft from an older version of the flow cannot produce a half product', () => {
  // A conversation resumed across a deploy: the seller answers the last
  // question, and the draft turns out to be missing a field the table needs.
  const orphan = { state: 'review', draft: { title: 'Jacket' } };

  const result = step(orphan, text('yes'), CTX);
  assert.equal(result.action, null);
  assert.equal(result.state, 'idle');
});

// ── COPY ─────────────────────────────────────────────────────────────────────

test('the confirmation carries the link a seller is meant to share', () => {
  const message = listedMessage(
    { public_code: 'AB12CD', title: 'Jacket', price: 35000 },
    { origin: 'https://uniquethrift.ng', posted: true }
  );

  assert.match(message, /uniquethrift\.ng\/p\/AB12CD/);
  assert.match(message, /₦35,000/);
  assert.match(message, /Status/);
});

test('a seller whose WhatsApp is not linked is told so, not left guessing', () => {
  const message = listedMessage(
    { public_code: 'AB12CD', title: 'Jacket', price: 35000 },
    { origin: 'https://uniquethrift.ng', posted: false }
  );

  // Believing your listings reach your contacts when they do not is the worst
  // way for this to fail, so it is said out loud.
  assert.match(message, /Link your WhatsApp/i);
});

test('naira is formatted the same way everywhere', () => {
  assert.equal(formatNaira(35000), '₦35,000');
  assert.equal(formatNaira(1234.5), '₦1,234.5');
  assert.equal(formatNaira(0), '₦0');
});

// ── THE WAHA ADAPTER ─────────────────────────────────────────────────────────

test('chat ids round-trip through a phone number', () => {
  assert.equal(chatId('+234 802 123 4567'), '2348021234567@c.us');
  assert.equal(phoneFromChatId('2348021234567@c.us'), '2348021234567');
  assert.equal(phoneFromChatId('2348021234567@g.us'), null);
  assert.equal(phoneFromChatId('2348021234567@s.whatsapp.net'), '2348021234567');
  // A privacy id is not a phone number, however much it looks like one.
  assert.equal(phoneFromChatId('99887766554433@lid'), null);
  assert.equal(chatId(''), null);
});

test('session names are derived from the slug, not invented', () => {
  assert.equal(sessionName({ slug: 'store' }), 'ut-store');
});

test('the bot never acts on its own outgoing messages', () => {
  // fromMe is how WAHA marks what the session itself sent. Acting on those
  // would have the bot answering itself, which is a loop that costs real
  // WhatsApp traffic before anybody notices.
  const event = parseEvent({
    event: 'message',
    session: 'ut-platform',
    payload: { fromMe: true, from: '2348021234567@c.us', body: 'yes' },
  });

  assert.equal(event, null);
});

test('events the bot does not handle are ignored, not crashed on', () => {
  for (const body of [null, {}, 'nonsense', { event: 'presence.update' }, { event: 'message' }]) {
    assert.doesNotThrow(() => parseEvent(body));
  }
  assert.equal(parseEvent({ event: 'presence.update' }), null);
  // A group chat is not a seller talking to the bot.
  assert.equal(
    parseEvent({ event: 'message', payload: { from: '123@g.us', body: 'hi' } }),
    null
  );
  // Nor is somebody's Status update.
  assert.equal(
    parseEvent({ event: 'message', payload: { from: 'status@broadcast', body: 'hi' } }),
    null
  );
});

test('a chat addressed by privacy id is still a message to act on', () => {
  const event = parseEvent({
    event: 'message',
    session: 'ut-platform',
    payload: { id: { id: 'L1' }, from: '99887766554433@lid', body: 'hi' },
  });

  assert.equal(event.kind, 'message');
  assert.equal(event.from, '99887766554433@lid');
});

test('a message is read the same way whichever engine sent it', () => {
  const webjs = parseEvent({
    event: 'message',
    session: 'ut-platform',
    payload: { id: { id: 'ABC' }, from: '2348021234567@c.us', body: 'list', timestamp: 1700000000 },
  });

  assert.equal(webjs.kind, 'message');
  assert.equal(webjs.id, 'ABC');
  assert.equal(webjs.timestamp, 1700000000);
  assert.equal(webjs.body, 'list');

  const noweb = parseEvent({
    event: 'message',
    session: 'ut-platform',
    data: { from: '2348021234567@c.us', text: 'list', timestamp: 1700000000 },
  });

  assert.equal(noweb.kind, 'message');
  // No id from this engine, which is exactly why routes/waha.js falls back to
  // the sender plus the timestamp for its replay guard.
  assert.equal(noweb.id, null);
  assert.equal(noweb.timestamp, 1700000000);
});

test('a session status event is recognised as one', () => {
  const event = parseEvent({
    event: 'session.status',
    session: 'ut-store',
    payload: { status: 'SCAN_QR_CODE' },
  });

  assert.deepEqual(event, { kind: 'status', session: 'ut-store', status: 'SCAN_QR_CODE' });
});

// ── STORAGE PATHS ────────────────────────────────────────────────────────────

test('an image path starts with the tenant id', () => {
  // Not cosmetic: a future storage policy scopes writes with
  // (storage.foldername(name))[1] = tenant_id, so the convention is what makes
  // a per-tenant grant possible without moving every file.
  const path = storagePath('tenant-1', 'image/png');
  assert.match(path, /^tenant-1\/[0-9a-f-]{36}\.png$/);
  assert.match(storagePath('tenant-1', 'image/jpeg'), /\.jpg$/);
  assert.match(storagePath('tenant-1', 'application/pdf'), /\.jpg$/);
});

test('a stored path resolves to the bucket, and an absolute URL is left alone', () => {
  const cfg = { supabaseUrl: 'https://project.supabase.co' };

  assert.equal(
    publicUrl(cfg, 'tenant-1/abc.jpg'),
    `https://project.supabase.co/storage/v1/object/public/${BUCKET}/tenant-1/abc.jpg`
  );
  assert.equal(publicUrl(cfg, 'https://elsewhere.test/a.jpg'), 'https://elsewhere.test/a.jpg');
  assert.equal(publicUrl(cfg, null), null);
});

// ── OPENING A STORE ──────────────────────────────────────────────────────────

test('a sign-up asks for a name, then an email, then asks for the store', () => {
  const first = signupStep(null, { body: 'hello' });
  assert.equal(first.state, 'name');
  assert.equal(first.action, null);

  const named = signupStep({ state: 'name' }, { body: '  Ada   Stores ' });
  assert.equal(named.state, 'email');
  assert.equal(named.patch.business_name, 'Ada Stores');

  const done = signupStep({ state: 'email', business_name: 'Ada Stores' }, { body: 'Ada@Example.com' });
  assert.equal(done.state, 'pending');
  assert.deepEqual(done.action, { type: 'provision', name: 'Ada Stores', email: 'ada@example.com' });
});

test('a business name has to be one', () => {
  for (const body of ['a', 'hi', 'Hello!', 'x'.repeat(MAX_BUSINESS_NAME + 1)]) {
    assert.equal(signupStep({ state: 'name' }, { body }).state, 'name', body);
  }
  assert.equal(signupStep({ state: 'name' }, { body: 'Hello Kitty Thrift' }).state, 'email');
});

test('a sign-up left for hours, or one whose store is gone, starts over', () => {
  const old = new Date(Date.now() - (STALE_AFTER_HOURS + 1) * 3_600_000).toISOString();
  assert.equal(
    signupStep({ state: 'email', business_name: 'Ada', updated_at: old }, { body: 'ada@example.com' }).state,
    'name'
  );
  // 'pending' only reaches signupStep when no store has the number any more.
  assert.equal(signupStep({ state: 'pending' }, { body: 'hi' }).state, 'name');
});

test('cancel only means cancel once a sign-up has started', () => {
  assert.equal(signupStep({ state: 'name' }, { body: 'cancel' }).state, null);
  assert.equal(signupStep(null, { body: 'cancel' }).state, 'name');
});

test('an approval sends a link only to a new account', () => {
  const fresh = approvedMessage({ name: 'Ada', link: 'https://x/verify?t=1', email: 'a@b.co' });
  assert.match(fresh, /https:\/\/x\/verify\?t=1/);

  const existing = approvedMessage({ name: 'Ada', link: null, email: 'a@b.co', origin: 'https://ut.ng' });
  assert.match(existing, /existing account \(a@b\.co\)/);
  assert.match(existing, /https:\/\/ut\.ng\/login/);
  assert.doesNotMatch(existing, /verify/);
});

test('a store name becomes a readable slug', () => {
  assert.equal(slugFor("Ada's Thrift & Vintage!"), 'adas-thrift-vintage');
  assert.equal(slugFor('Café Ọ̀ṣun'), 'cafe-osun');
  assert.equal(slugFor('AB'), 'store-ab');
  assert.equal(slugFor('!!!'), 'store');
  assert.ok(slugFor('x'.repeat(80)).length <= 32);
  assert.match(slugFor('A very long business name that goes on and on'), /^[a-z0-9-]{3,40}$/);
});
