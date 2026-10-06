import test from 'node:test';
import assert from 'node:assert/strict';

import worker, { EVERY_MINUTE } from '../index.js';
import { finalizeDrafts, aiReadFor } from '../routes/photoReview.js';
import { makeFakeSupabase, installFetch, env } from './fake-supabase.mjs';

// Items brought to a store, with the photos checked: the webhook side
// (worker/routes/waha.js → lib/photoIntake.js → the photo-check service) and
// the filer (routes/photoReview.js). The conversation's own branches are in
// photoIntake.test.mjs.

const WAHA_URL = 'https://waha.test';
const PLATFORM = 'ut-platform';
const STORE_SESSION = 'ut-store';
const STORE_SECRET = 'tenant-secret';
const CHECK_URL = 'https://check.test/photo-check';
const CHECK_KEY = 'photo-check-key';

const TENANT = 'aaaaaaaa-0000-0000-0000-00000000000a';
const OWNER_PHONE = '2348021234567';
const OWNER_CHAT = `${OWNER_PHONE}@c.us`;
const CONSIGNOR_PHONE = '2348097776655';
const CONSIGNOR_CHAT = `${CONSIGNOR_PHONE}@c.us`;

const CATEGORIES = [
  { slug: 'clothing', name: 'Clothing', active: true },
  { slug: 'shoes', name: 'Shoes', active: true },
];

const RULES = [
  { category: 'clothing', shot_type: 'front', label: 'Front', requirement: 'required', condition_flag: null, sort_order: 1 },
  { category: 'clothing', shot_type: 'back', label: 'Back', requirement: 'required', condition_flag: null, sort_order: 2 },
  { category: 'clothing', shot_type: 'label', label: 'Size/brand label', requirement: 'required', condition_flag: null, sort_order: 3 },
  { category: 'clothing', shot_type: 'flaw', label: 'Flaw close-up', requirement: 'conditional', condition_flag: 'has_flaws', sort_order: 4 },
  { category: 'shoes', shot_type: 'side', label: 'Side view', requirement: 'required', condition_flag: null, sort_order: 1 },
];

function seed({ tenant = {}, flag = true, ...rest } = {}) {
  return {
    tenants: [
      {
        id: TENANT,
        slug: 'kay',
        name: 'Kay Stores',
        status: 'active',
        whatsapp_number: OWNER_PHONE,
        waha_session: STORE_SESSION,
        waha_status: 'WORKING',
        ...tenant,
      },
    ],
    whatsapp_secrets: [{ tenant_id: TENANT, webhook_secret: STORE_SECRET }],
    tenant_features: flag ? [{ tenant_id: TENANT, flag: 'photo_review', enabled: true }] : [],
    photo_categories: CATEGORIES,
    photo_shot_rules: RULES,
    ...rest,
  };
}

function makeFakeWaha() {
  const sent = [];
  async function handler(url, init = {}) {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    if (path === '/api/startTyping') return new Response('{}', { status: 200 });
    if (path === '/api/sendText') {
      sent.push(body);
      return new Response(JSON.stringify({ id: { id: `out-${sent.length}` } }), { status: 200 });
    }
    return new Response('unexpected waha call', { status: 500 });
  }
  return { url: WAHA_URL, handler, sent };
}

// The photo-check service: records each call, answers with `answer(body)`.
function makeFakeCheck(answer = () => ({ status: 200, body: pending() })) {
  const calls = [];
  async function handler(url, init = {}) {
    const body = JSON.parse(init.body);
    calls.push({ url, key: init.headers?.['X-Service-Key'], body });
    const r = answer(body, calls.length);
    return new Response(JSON.stringify(r.body), { status: r.status });
  }
  return { url: CHECK_URL, handler, calls };
}

const pending = (extra = {}) => ({
  photo_id: crypto.randomUUID(),
  status: 'pending',
  reason: null,
  message: "Got it! I'll check all your photos shortly.",
  repeat_request: false,
  ...extra,
});

function testEnv(extra = {}) {
  return env({
    WAHA_URL,
    WAHA_API_KEY: 'waha-key',
    WAHA_SESSION: PLATFORM,
    WAHA_WEBHOOK_SECRET: 'platform-secret',
    PUBLIC_ORIGIN: 'https://vendwyze.test',
    WAHA_TYPING_MS: '0',
    PHOTO_CHECK_URL: CHECK_URL,
    PHOTO_CHECK_KEY: CHECK_KEY,
    ...extra,
  });
}

let counter = 0;
function fromConsignor(body, { media = null, id } = {}) {
  counter += 1;
  return {
    event: 'message',
    session: STORE_SESSION,
    payload: {
      id: { id: id ?? `pr-msg-${counter}` },
      timestamp: 1_800_000_000 + counter,
      from: CONSIGNOR_CHAT,
      body,
      hasMedia: Boolean(media),
      media: media ? { url: media, mimetype: 'image/jpeg' } : undefined,
    },
  };
}

// As WAHA writes them: its own (often localhost) host, which the Worker
// swaps for WAHA_URL before handing the URL to the photo-check service.
const wahaFile = (name) => `http://localhost:3000/api/files/${STORE_SESSION}/${name}.jpg`;

async function toStore(messages, e = testEnv()) {
  const out = [];
  for (const m of messages) {
    out.push(
      await worker.fetch(
        new Request('https://example.com/api/waha/webhook', {
          method: 'POST',
          headers: { 'X-Thrift-Secret': STORE_SECRET },
          body: JSON.stringify(m),
        }),
        e,
        {}
      )
    );
  }
  return out;
}

const DETAILS = ['SELL', '1', 'Black Zara blazer', '15k', '3', 'no', 'Ada Obi', 'yes'];

// store_shot_rules_for(), as 0041 defines it: the defaults with this store's
// overrides applied, and switched-off shots left out.
const RPCS = {
  store_shot_rules_for: ({ p_tenant_id, p_category = null }, tables) =>
    tables.photo_shot_rules
      .filter((r) => p_category == null || r.category === p_category)
      .map((r) => {
        const o = tables.store_shot_rules.find(
          (x) => x.tenant_id === p_tenant_id && x.category === r.category && x.shot_type === r.shot_type
        );
        return { ...r, requirement: o?.requirement ?? r.requirement };
      })
      .filter((r) => r.requirement !== 'off'),
};

function setup(seedOptions, checkAnswer) {
  const supabase = makeFakeSupabase(seed(seedOptions), { rpcs: RPCS });
  const waha = makeFakeWaha();
  const check = makeFakeCheck(checkAnswer);
  const restore = installFetch({ supabase, waha, photoCheck: check });
  return { supabase, waha, check, restore };
}

const toSeller = (waha) => waha.sent.filter((m) => m.chatId === CONSIGNOR_CHAT);
const conversationOf = (supabase) =>
  supabase.tables.bot_conversations.find((c) => c.tenant_id === TENANT && c.chat_id === CONSIGNOR_CHAT);

// ── WHICH INTAKE RUNS ────────────────────────────────────────────────────────

test('without the photo_review flag, SELL runs the old intake', async () => {
  const { supabase, waha, check, restore } = setup({ flag: false });
  try {
    await toStore([fromConsignor('SELL')]);
    assert.equal(conversationOf(supabase).state, 'photo');
    assert.match(toSeller(waha)[0].text, /Send a photo of the item/);
    assert.equal(supabase.tables.listing_drafts.length, 0);
    assert.equal(check.calls.length, 0);
  } finally {
    restore();
  }
});

test('with the flag on but the photo-check service unconfigured, the old intake still runs', async () => {
  const { supabase, restore } = setup();
  try {
    await toStore([fromConsignor('SELL')], testEnv({ PHOTO_CHECK_URL: '', PHOTO_CHECK_KEY: '' }));
    assert.equal(conversationOf(supabase).state, 'photo');
  } finally {
    restore();
  }
});

test('a conversation under way in the old intake finishes there after the flag is switched on', async () => {
  const { supabase, restore } = setup({
    bot_conversations: [{ tenant_id: TENANT, chat_id: CONSIGNOR_CHAT, state: 'title', draft: { images: [{ url: wahaFile('x'), mimetype: 'image/jpeg' }] }, updated_at: new Date().toISOString() }],
  });
  try {
    await toStore([fromConsignor('Old flow item')]);
    assert.equal(conversationOf(supabase).state, 'price');
  } finally {
    restore();
  }
});

// ── THE DETAILS, THEN A DRAFT ────────────────────────────────────────────────

test('the details become a listing draft, and the seller is told which photos to send', async () => {
  const { supabase, waha, check, restore } = setup();
  try {
    await toStore(DETAILS.map((t) => fromConsignor(t)));

    assert.equal(supabase.tables.listing_drafts.length, 1);
    const draft = supabase.tables.listing_drafts[0];
    assert.equal(draft.tenant_id, TENANT);
    assert.equal(draft.seller_chat_id, CONSIGNOR_CHAT);
    assert.equal(draft.category, 'clothing');
    assert.deepEqual(draft.flags, []);
    assert.deepEqual(draft.extracted, {
      source: 'sell',
      title: 'Black Zara blazer',
      asking_price: 15000,
      condition: 'good',
      seller_name: 'Ada Obi',
    });

    const conv = conversationOf(supabase);
    assert.equal(conv.state, 'pi_photos');
    assert.equal(conv.draft.draft_id, draft.id);

    const last = toSeller(waha).at(-1);
    assert.equal(last.session, STORE_SESSION);
    assert.match(last.text, /• Front\n• Back\n• Size\/brand label/);
    // Nothing filed and nothing checked yet.
    assert.equal(supabase.tables.submissions.length, 0);
    assert.equal(check.calls.length, 0);
  } finally {
    restore();
  }
});

// ── THE STORE'S OWN EXPECTATIONS ─────────────────────────────────────────────

test("a category the store doesn't take is not offered", async () => {
  const { waha, restore } = setup({
    store_photo_categories: [{ tenant_id: TENANT, category: 'shoes', accepted: false }],
  });
  try {
    await toStore([fromConsignor('SELL')]);
    const menu = toSeller(waha).at(-1).text;
    assert.match(menu, /1 Clothing/);
    assert.doesNotMatch(menu, /Shoes/);
  } finally {
    restore();
  }
});

test("a shot the store switched off isn't asked for, and another store's choices don't leak in", async () => {
  const { waha, restore } = setup({
    store_shot_rules: [
      { tenant_id: TENANT, category: 'clothing', shot_type: 'label', requirement: 'off' },
      { tenant_id: 'some-other-store', category: 'clothing', shot_type: 'back', requirement: 'off' },
    ],
  });
  try {
    await toStore(DETAILS.map((t) => fromConsignor(t)));
    const list = toSeller(waha).at(-1).text;
    assert.match(list, /• Front\n• Back(\n|$)/);
    assert.doesNotMatch(list, /label/i);
  } finally {
    restore();
  }
});

test('when every category is switched off, SELL says so instead of showing an empty menu', async () => {
  const { supabase, waha, restore } = setup({
    store_photo_categories: [
      { tenant_id: TENANT, category: 'clothing', accepted: false },
      { tenant_id: TENANT, category: 'shoes', accepted: false },
    ],
  });
  try {
    await toStore([fromConsignor('SELL')]);
    assert.match(toSeller(waha).at(-1).text, /can't take items/);
    assert.equal(supabase.tables.listing_drafts.length, 0);
  } finally {
    restore();
  }
});

test('starting again replaces an abandoned open draft instead of colliding with it', async () => {
  const { supabase, restore } = setup({
    listing_drafts: [{ id: 'old-draft', tenant_id: TENANT, seller_chat_id: CONSIGNOR_CHAT, category: 'shoes', status: 'awaiting_photos', extracted: { source: 'sell' } }],
  });
  try {
    await toStore(DETAILS.map((t) => fromConsignor(t)));
    const old = supabase.tables.listing_drafts.find((d) => d.id === 'old-draft');
    assert.equal(old.status, 'cancelled');
    assert.equal(supabase.tables.listing_drafts.filter((d) => d.status === 'awaiting_photos' || d.status == null).length, 1);
  } finally {
    restore();
  }
});

// ── PHOTOS ───────────────────────────────────────────────────────────────────

test("each photo goes to the photo-check service with WAHA's public URL and the service key", async () => {
  const { supabase, waha, check, restore } = setup();
  try {
    await toStore([
      ...DETAILS.map((t) => fromConsignor(t)),
      fromConsignor('', { media: wahaFile('front'), id: 'photo-1' }),
      fromConsignor('', { media: wahaFile('back'), id: 'photo-2' }),
    ]);

    const draft = supabase.tables.listing_drafts[0];
    assert.equal(check.calls.length, 2);
    assert.equal(check.calls[0].url, `${CHECK_URL}/check`);
    assert.equal(check.calls[0].key, CHECK_KEY);
    assert.deepEqual(check.calls[0].body, {
      tenant_id: TENANT,
      draft_id: draft.id,
      message_id: 'photo-1',
      media_url: `${WAHA_URL}/api/files/${STORE_SESSION}/front.jpg`,
    });

    // The first photo is acknowledged; the second, also fine, is not.
    const after = toSeller(waha).slice(-1);
    assert.match(after[0].text, /check all your photos shortly/);
    assert.equal(toSeller(waha).filter((m) => /check all your photos shortly/.test(m.text)).length, 1);
  } finally {
    restore();
  }
});

test("a rejected photo's reason is passed on to the seller", async () => {
  const { waha, restore } = setup({}, (body, n) =>
    n === 1
      ? { status: 200, body: pending({ status: 'rejected', reason: 'blurry', message: 'This photo is blurry. Hold your phone steady.' }) }
      : { status: 200, body: pending() }
  );
  try {
    await toStore([
      ...DETAILS.map((t) => fromConsignor(t)),
      fromConsignor('', { media: wahaFile('blurry'), id: 'false_234809@c.us_BLURRY1' }),
    ]);
    const answer = toSeller(waha).at(-1);
    assert.match(answer.text, /blurry/);
    // Quoting the photo it means, so a seller who sent four can tell which.
    assert.equal(answer.reply_to, 'false_234809@c.us_BLURRY1');
    assert.ok(toSeller(waha).slice(0, -1).every((m) => !m.reply_to), 'nothing else is a reply');
  } finally {
    restore();
  }
});

test('when the photo-check service is down, the seller is asked to resend rather than left hanging', async () => {
  const { waha, restore } = setup({}, () => ({ status: 502, body: { error: 'media_download_failed' } }));
  try {
    await toStore([...DETAILS.map((t) => fromConsignor(t)), fromConsignor('', { media: wahaFile('x') })]);
    assert.match(toSeller(waha).at(-1).text, /couldn't check that photo/);
  } finally {
    restore();
  }
});

test('a photo WAHA delivers twice is checked once', async () => {
  const { check, restore } = setup();
  try {
    const photo = fromConsignor('', { media: wahaFile('front'), id: 'dup-photo' });
    await toStore([...DETAILS.map((t) => fromConsignor(t)), photo, photo]);
    assert.equal(check.calls.length, 1);
  } finally {
    restore();
  }
});

test('photos sent before the details are checked once the draft exists, under their own message ids', async () => {
  const { supabase, waha, check, restore } = setup();
  try {
    await toStore([
      fromConsignor('SELL', { media: wahaFile('early'), id: 'early-photo' }),
      ...DETAILS.slice(1).map((t) => fromConsignor(t)),
    ]);
    assert.equal(check.calls.length, 1);
    assert.equal(check.calls[0].body.message_id, 'early-photo');
    assert.equal(check.calls[0].body.draft_id, supabase.tables.listing_drafts[0].id);
    assert.match(toSeller(waha).at(-1).text, /checking the photo you already sent/);
  } finally {
    restore();
  }
});

test('"status" lists what is still needed, by label', async () => {
  const { supabase, waha, restore } = setup();
  try {
    await toStore(DETAILS.map((t) => fromConsignor(t)));
    // What the triggers would have set after a front shot passed.
    supabase.tables.listing_drafts[0].missing_shots = ['back', 'label'];
    await toStore([fromConsignor('status')]);
    assert.match(toSeller(waha).at(-1).text, /Still needed for \*Black Zara blazer\*:\n• Back\n• Size\/brand label/);
  } finally {
    restore();
  }
});

test('cancel drops the draft', async () => {
  const { supabase, waha, restore } = setup();
  try {
    await toStore([...DETAILS.map((t) => fromConsignor(t)), fromConsignor('cancel')]);
    assert.equal(supabase.tables.listing_drafts[0].status, 'cancelled');
    assert.equal(conversationOf(supabase).state, 'idle');
    assert.match(toSeller(waha).at(-1).text, /Cancelled/);
  } finally {
    restore();
  }
});

test('a photo for an item already sent to the store is told so, and the chat lets go', async () => {
  const { supabase, waha, check, restore } = setup();
  try {
    await toStore(DETAILS.map((t) => fromConsignor(t)));
    supabase.tables.listing_drafts[0].status = 'published';
    await toStore([fromConsignor('', { media: wahaFile('late') })]);
    assert.equal(check.calls.length, 0);
    assert.match(toSeller(waha).at(-1).text, /already gone to Kay Stores/);
    assert.equal(conversationOf(supabase).state, 'idle');
  } finally {
    restore();
  }
});

test('while the owner is answering the chat, photos are still checked and text is left alone', async () => {
  const { supabase, check, waha, restore } = setup();
  try {
    await toStore(DETAILS.map((t) => fromConsignor(t)));
    const conv = conversationOf(supabase);
    conv.paused_until = new Date(Date.now() + 3_600_000).toISOString();
    const before = waha.sent.length;

    await toStore([fromConsignor('status'), fromConsignor('', { media: wahaFile('front') })]);
    assert.equal(check.calls.length, 1);
    // The pause stays: the owner is still answering everything else.
    assert.ok(conversationOf(supabase).paused_until);
    // "status" got no answer; only the photo's acknowledgement went out.
    assert.equal(waha.sent.length - before, 1);
  } finally {
    restore();
  }
});

// ── FILING A READY DRAFT ─────────────────────────────────────────────────────

function readySeed(extra = {}) {
  return {
    listing_drafts: [
      {
        id: 'draft-1',
        tenant_id: TENANT,
        seller_chat_id: CONSIGNOR_CHAT,
        category: 'clothing',
        flags: [],
        status: 'ready',
        missing_shots: [],
        updated_at: new Date().toISOString(),
        extracted: { source: 'sell', title: 'Black Zara blazer', asking_price: 15000, condition: 'good', seller_name: 'Ada Obi' },
      },
    ],
    // Out of order on purpose: the label arrived first.
    listing_photos: [
      { id: 'p-label', tenant_id: TENANT, draft_id: 'draft-1', storage_path: `${TENANT}/draft-1/label.jpg`, shot_type: 'label', status: 'passed', created_at: '2026-10-05T10:00:00Z' },
      { id: 'p-front', tenant_id: TENANT, draft_id: 'draft-1', storage_path: `${TENANT}/draft-1/front.jpg`, shot_type: 'front', status: 'passed', created_at: '2026-10-05T10:01:00Z' },
      { id: 'p-bad', tenant_id: TENANT, draft_id: 'draft-1', storage_path: `${TENANT}/draft-1/bad.jpg`, shot_type: null, status: 'rejected', created_at: '2026-10-05T10:02:00Z' },
      { id: 'p-back', tenant_id: TENANT, draft_id: 'draft-1', storage_path: `${TENANT}/draft-1/back.jpg`, shot_type: 'back', status: 'passed', created_at: '2026-10-05T10:03:00Z' },
    ],
    bot_conversations: [
      { tenant_id: TENANT, chat_id: CONSIGNOR_CHAT, state: 'pi_photos', draft: { draft_id: 'draft-1' }, updated_at: new Date().toISOString() },
    ],
    ...extra,
  };
}

test('a ready draft becomes a submission: photos copied out in shot order, seller and owner told', async () => {
  const { supabase, waha, restore } = setup(readySeed());
  try {
    const result = await finalizeDrafts(testEnv());
    assert.equal(result.filed, 1);

    assert.equal(supabase.tables.submissions.length, 1);
    const item = supabase.tables.submissions[0];
    assert.equal(item.tenant_id, TENANT);
    assert.equal(item.draft_id, 'draft-1');
    assert.equal(item.title, 'Black Zara blazer');
    assert.equal(item.asking_price, 15000);
    assert.equal(item.condition, 'good');
    assert.equal(item.seller_name, 'Ada Obi');
    assert.equal(item.seller_phone, CONSIGNOR_PHONE);

    // Only passed photos, out of the private bucket, front → back → label.
    assert.deepEqual(supabase.downloads, [
      `listing-photos/${TENANT}/draft-1/front.jpg`,
      `listing-photos/${TENANT}/draft-1/back.jpg`,
      `listing-photos/${TENANT}/draft-1/label.jpg`,
    ]);
    assert.equal(item.images.length, 3);
    for (const path of item.images) assert.match(path, new RegExp(`^${TENANT}/[0-9a-f-]+\\.jpg$`));
    assert.ok(supabase.uploads.every((u) => u.path.startsWith('product-images/')));

    assert.equal(supabase.tables.listing_drafts[0].status, 'published');

    const seller = toSeller(waha);
    assert.match(seller[0].text, /Sent!/);
    assert.ok(seller.every((m) => m.session === STORE_SESSION));
    // First item, so they're asked where to be paid, as the old intake does.
    assert.match(seller[1].text, /bank/i);
    assert.equal(conversationOf(supabase).state, 'bank');

    const owner = waha.sent.filter((m) => m.chatId === OWNER_CHAT);
    assert.equal(owner.length, 1);
    assert.equal(owner[0].session, PLATFORM);
    assert.match(owner[0].text, /New item to review: \*Black Zara blazer\*/);
  } finally {
    restore();
  }
});

test("what the AI noticed reaches the review queue and the owner's message", async () => {
  const seed = readySeed();
  seed.listing_drafts[0].ai_item = {
    description: 'a black blazer',
    has_screen: false,
    fits_category: true,
    issues: ['dirty', 'stained'],
  };
  const { supabase, waha, restore } = setup(seed);
  try {
    await finalizeDrafts(testEnv());
    const item = supabase.tables.submissions[0];
    assert.deepEqual(item.ai_issues, ['dirty', 'stained']);
    // Stains are a flaw, and the seller said there were none.
    assert.equal(item.ai_note, 'It looks dirty and has stains. The seller said it has no flaws.');

    const owner = waha.sent.find((m) => m.chatId === OWNER_CHAT);
    assert.match(owner.text, /⚠️ AI noticed: It looks dirty and has stains\./);
  } finally {
    restore();
  }
});

test('the AI note: nothing to say, dirt alone, a declared flaw, the wrong category, junk from the model', () => {
  assert.deepEqual(aiReadFor({ ai_item: null }), { ai_issues: [], ai_note: null });
  assert.deepEqual(aiReadFor({ ai_item: { issues: [], fits_category: true } }), { ai_issues: [], ai_note: null });

  // Dirt washes off: not a contradiction of "no flaws".
  assert.equal(aiReadFor({ flags: [], ai_item: { issues: ['dirty'] } }, { askedFlaws: true }).ai_note, 'It looks dirty.');
  // Damage the seller owned up to is not news.
  assert.equal(
    aiReadFor({ flags: ['has_flaws'], ai_item: { issues: ['damaged'] } }, { askedFlaws: true }).ai_note,
    'It looks damaged.'
  );
  // And if nobody asked, nobody "said" anything.
  assert.equal(aiReadFor({ flags: [], ai_item: { issues: ['worn'] } }).ai_note, 'It looks worn.');

  assert.equal(
    aiReadFor({ ai_item: { issues: [], fits_category: false, description: 'a TV remote' } }).ai_note,
    'It may be in the wrong category: it looks like a TV remote.'
  );

  // Unknown issues are dropped rather than breaking the insert's check.
  assert.deepEqual(aiReadFor({ ai_item: { issues: ['haunted', 'worn', 'worn'] } }).ai_issues, ['worn']);
});

test('filing twice files once', async () => {
  const { supabase, waha, restore } = setup(readySeed());
  try {
    await finalizeDrafts(testEnv());
    const sent = waha.sent.length;
    // As if the draft had been put back mid-way and picked up again.
    supabase.tables.listing_drafts[0].status = 'ready';
    const again = await finalizeDrafts(testEnv());
    assert.equal(again.filed, 0);
    assert.equal(supabase.tables.submissions.length, 1);
    assert.equal(waha.sent.length, sent);
  } finally {
    restore();
  }
});

test('only ready drafts the intake made are filed', async () => {
  const seedData = readySeed();
  seedData.listing_drafts.push(
    { id: 'other-source', tenant_id: TENANT, seller_chat_id: 'x@c.us', category: 'clothing', status: 'ready', extracted: { source: 'listing' } },
    { id: 'still-waiting', tenant_id: TENANT, seller_chat_id: 'y@c.us', category: 'clothing', status: 'awaiting_photos', extracted: { source: 'sell' } }
  );
  const { supabase, restore } = setup(seedData);
  try {
    await finalizeDrafts(testEnv());
    assert.deepEqual(supabase.tables.submissions.map((s) => s.draft_id), ['draft-1']);
    assert.equal(supabase.tables.listing_drafts.find((d) => d.id === 'other-source').status, 'ready');
    assert.equal(supabase.tables.listing_drafts.find((d) => d.id === 'still-waiting').status, 'awaiting_photos');
  } finally {
    restore();
  }
});

test('a photo that cannot be read puts the draft back in the queue, with nothing filed', async () => {
  const { supabase, waha, restore } = setup(readySeed());
  supabase.missingObjects.push(`listing-photos/${TENANT}/draft-1/back.jpg`);
  try {
    const result = await finalizeDrafts(testEnv());
    assert.equal(result.failed, 1);
    assert.equal(supabase.tables.submissions.length, 0);
    assert.equal(supabase.tables.listing_drafts[0].status, 'ready');
    assert.equal(waha.sent.length, 0);
  } finally {
    restore();
  }
});

test("a suspended store's ready items wait instead of being filed or lost", async () => {
  const { supabase, restore } = setup({ ...readySeed(), tenant: { status: 'suspended' } });
  try {
    const result = await finalizeDrafts(testEnv());
    assert.equal(result.filed, 0);
    assert.equal(supabase.tables.submissions.length, 0);
    assert.equal(supabase.tables.listing_drafts[0].status, 'ready');
  } finally {
    restore();
  }
});

test('the minute cron files drafts and runs nothing else', async () => {
  const { supabase, restore } = setup(readySeed());
  try {
    const waits = [];
    await worker.scheduled({ cron: EVERY_MINUTE, scheduledTime: Date.now() }, testEnv(), { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    assert.equal(supabase.tables.submissions.length, 1);
    const rpcs = supabase.calls.filter((c) => c.table === 'rpc').map((c) => c.rpc);
    assert.deepEqual(rpcs, ['expire_stale_listing_drafts']);
    // The hourly jobs (escrow, payouts, billing) never touched their tables.
    assert.ok(!supabase.calls.some((c) => ['orders', 'payouts', 'plan_invoices'].includes(c.table)));
  } finally {
    restore();
  }
});
