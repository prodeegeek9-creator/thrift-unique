import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../index.js';
import { makeFakeSupabase, installFetch, env, SUPABASE_URL } from './fake-supabase.mjs';
import { mediaRequest } from '../lib/media.js';

// The webhook, end to end: secret check, replay guard, the conversation, the
// upload, the product, the Status post.
//
// The conversation itself is covered branch by branch in bot.test.mjs. What
// matters here is everything around it — the parts that touch a database, a
// WAHA server and somebody's WhatsApp.

const WAHA_URL = 'https://waha.test';
const PLATFORM = 'ut-platform';
const SECRET = 'platform-webhook-secret';

const SELLER_PHONE = '2348021234567';
const SELLER_CHAT = `${SELLER_PHONE}@c.us`;
const TENANT = 'aaaaaaaa-0000-0000-0000-00000000000a';

const OWNER = { id: 'user-owner', email: 'owner@store.test' };
const STAFF = { id: 'user-staff', email: 'staff@store.test' };
const STRANGER = { id: 'user-stranger', email: 'nobody@example.test' };

const TOKENS = { 'tok-owner': OWNER, 'tok-staff': STAFF, 'tok-stranger': STRANGER };

function seed({ tenant = {}, secret = null } = {}) {
  return {
    tenants: [
      {
        id: TENANT,
        slug: 'store',
        name: 'Thrift Store',
        status: 'active',
        whatsapp_number: SELLER_PHONE,
        waha_session: null,
        waha_status: null,
        ...tenant,
      },
    ],
    // The tenant's webhook secret lives in its own table, not on the tenant
    // row — the table-level grant on `tenants` covers every column, so a
    // secret stored there is readable by every member of the store.
    whatsapp_secrets: secret ? [{ tenant_id: TENANT, webhook_secret: secret }] : [],
    tenant_members: [
      { tenant_id: TENANT, user_id: OWNER.id, role: 'owner' },
      { tenant_id: TENANT, user_id: STAFF.id, role: 'staff' },
    ],
    products: [],
    bot_conversations: [],
    bot_messages: [],
  };
}

// A WAHA stand-in that records what it was asked to do, so a test can assert
// on what the seller and their contacts would actually have seen.
function makeFakeWaha({ sessions = {}, mediaStatus = 200, lids = {}, lidsStatus = null } = {}) {
  const sent = [];
  const mediaFetches = [];
  const typing = [];
  // Typing and sending, in the order they happened.
  const events = [];
  const statuses = [];
  const started = [];
  const stopped = [];
  const created = [];
  const deleted = [];

  async function handler(url, init = {}) {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : null;

    if (path.startsWith('/api/files/')) {
      mediaFetches.push({ path, key: init.headers?.['X-Api-Key'] ?? null });
      if (mediaStatus !== 200) return new Response('gone', { status: mediaStatus });
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    }

    if (path === '/api/startTyping') {
      typing.push(body);
      events.push({ typing: body.chatId });
      return new Response('{}', { status: 200 });
    }

    if (path === '/api/sendText') {
      sent.push(body);
      events.push({ sent: body.chatId });
      return new Response(JSON.stringify({ id: { id: `out-${sent.length}` } }), { status: 200 });
    }

    if (path === '/api/sessions' && init.method === 'POST') {
      created.push(body);
      sessions[body.name] = { name: body.name, status: 'STARTING' };
      return new Response(JSON.stringify(sessions[body.name]), { status: 201 });
    }

    const status = path.match(/^\/api\/([^/]+)\/status\/(image|text)$/);
    if (status) {
      statuses.push({ session: decodeURIComponent(status[1]), kind: status[2], ...body });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    const stop = path.match(/^\/api\/sessions\/([^/]+)\/stop$/);
    if (stop) {
      stopped.push(decodeURIComponent(stop[1]));
      return new Response(JSON.stringify({ status: 'STOPPED' }), { status: 201 });
    }

    const start = path.match(/^\/api\/sessions\/([^/]+)\/start$/);
    if (start) {
      started.push(decodeURIComponent(start[1]));
      return new Response(JSON.stringify({ status: 'STARTING' }), { status: 200 });
    }

    const one = path.match(/^\/api\/sessions\/([^/]+)$/);
    if (one) {
      const name = decodeURIComponent(one[1]);
      if (init.method === 'DELETE') {
        deleted.push(name);
        delete sessions[name];
        return new Response(null, { status: 204 });
      }
      const found = sessions[name];
      return found
        ? new Response(JSON.stringify(found), { status: 200 })
        : new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    }

    const qr = path.match(/^\/api\/([^/]+)\/auth\/qr$/);
    if (qr) {
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }

    const lid = path.match(/^\/api\/([^/]+)\/lids\/([^/]+)$/);
    if (lid) {
      if (lidsStatus) {
        return new Response(JSON.stringify({ message: 'Enable NOWEB store' }), { status: lidsStatus });
      }
      const key = decodeURIComponent(lid[2]);
      return lids[key]
        ? new Response(JSON.stringify({ lid: key, pn: lids[key] }), { status: 200 })
        : new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    }

    return new Response('unexpected waha call', { status: 500 });
  }

  return { url: WAHA_URL, handler, sent, mediaFetches, typing, events, statuses, started, stopped, created, deleted, sessions };
}

function wahaEnv(extra = {}) {
  return env({
    WAHA_URL,
    WAHA_API_KEY: 'waha-key',
    WAHA_SESSION: PLATFORM,
    WAHA_WEBHOOK_SECRET: SECRET,
    PUBLIC_ORIGIN: 'https://uniquethrift.ng',
    // A real pause, just not a slow one: the typing path runs in every test.
    WAHA_TYPING_MS: '1',
    ...extra,
  });
}

function hook(payload, { secret = SECRET } = {}) {
  return new Request('https://example.com/api/waha/webhook', {
    method: 'POST',
    headers: secret ? { 'X-Thrift-Secret': secret } : {},
    body: JSON.stringify(payload),
  });
}

let counter = 0;
function incoming(body, { session = PLATFORM, from = SELLER_CHAT, media = null, id } = {}) {
  counter += 1;
  return {
    event: 'message',
    session,
    payload: {
      id: { id: id ?? `msg-${counter}` },
      timestamp: 1_700_000_000 + counter,
      from,
      body,
      hasMedia: Boolean(media),
      media: media ? { url: media, mimetype: 'image/jpeg' } : undefined,
    },
  };
}

// Walks a seller through a whole listing over the webhook, one request per
// message, exactly as WAHA would deliver them.
async function converse(messages, e, restore) {
  const responses = [];
  for (const m of messages) responses.push(await worker.fetch(hook(m), e, {}));
  return responses;
}

// ── THE SECRET ───────────────────────────────────────────────────────────────

test('a webhook without the right secret is refused and changes nothing', async () => {
  const supabase = makeFakeSupabase(seed());
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    for (const secret of [null, '', 'wrong', `${SECRET}x`]) {
      const res = await worker.fetch(hook(incoming('list'), { secret }), wahaEnv(), {});
      assert.equal(res.status, 403, `accepted ${JSON.stringify(secret)}`);
    }

    assert.equal(supabase.tables.bot_messages.length, 0);
    assert.equal(waha.sent.length, 0);
  } finally {
    restore();
  }
});

test('a tenant session is verified against that tenant own secret', async () => {
  const supabase = makeFakeSupabase(
    seed({ tenant: { waha_session: 'ut-store', waha_status: 'WORKING' }, secret: 'tenant-secret' })
  );
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    const event = { event: 'session.status', session: 'ut-store', payload: { status: 'FAILED' } };

    // The platform's secret must not open a tenant's session, and vice versa.
    const wrong = await worker.fetch(hook(event, { secret: SECRET }), wahaEnv(), {});
    assert.equal(wrong.status, 403);

    const right = await worker.fetch(hook(event, { secret: 'tenant-secret' }), wahaEnv(), {});
    assert.equal(right.status, 200);
    assert.equal(supabase.tables.tenants[0].waha_status, 'FAILED');
  } finally {
    restore();
  }
});

// ── WHO IS TALKING ───────────────────────────────────────────────────────────

// ── OPENING A STORE ──────────────────────────────────────────────────────────

const NEWCOMER = '2349999999999';
const NEWCOMER_CHAT = `${NEWCOMER}@c.us`;

test('a number belonging to no store is offered one, and nothing else is created', async () => {
  const supabase = makeFakeSupabase(seed());
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    const res = await worker.fetch(hook(incoming('list', { from: NEWCOMER_CHAT })), wahaEnv(), {});

    assert.equal(res.status, 200);
    assert.equal(waha.sent.length, 1);
    assert.match(waha.sent[0].text, /isn't linked to a store/i);
    assert.match(waha.sent[0].text, /business name/i);
    assert.equal(supabase.tables.signups.length, 1);
    assert.equal(supabase.tables.signups[0].state, 'name');
    assert.equal(supabase.tables.tenants.length, 1);
    assert.equal(supabase.tables.bot_messages.length, 0);
  } finally {
    restore();
  }
});

test('a business opens a store over WhatsApp, and it waits for approval', async () => {
  const supabase = makeFakeSupabase(seed());
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    const responses = await converse(
      [
        incoming('Hi! I want to set up my store.', { from: NEWCOMER_CHAT }),
        // A second hello is not a business called "hi".
        incoming('hi', { from: NEWCOMER_CHAT }),
        incoming("Ada's Thrift & Vintage", { from: NEWCOMER_CHAT }),
        incoming('1', { from: NEWCOMER_CHAT }), // thrift store
        incoming('1', { from: NEWCOMER_CHAT }), // thrift & vintage clothing
        incoming('2', { from: NEWCOMER_CHAT }), // growth
        incoming('not an email', { from: NEWCOMER_CHAT }),
        incoming(' Ada@Example.com ', { from: NEWCOMER_CHAT }),
        incoming('yes', { from: NEWCOMER_CHAT }),
      ],
      wahaEnv()
    );
    assert.ok(responses.every((r) => r.status === 200));

    const store = supabase.tables.tenants.find((t) => t.whatsapp_number === NEWCOMER);
    assert.ok(store, 'a store registered to the sender');
    assert.equal(store.name, "Ada's Thrift & Vintage");
    assert.equal(store.slug, 'adas-thrift-vintage');
    assert.equal(store.status, 'onboarding');
    assert.equal(store.tier, 'growth');
    assert.equal(store.store_type, 'consignment');
    assert.equal(store.category, 'thrift');
    assert.equal(store.commission_pct, 7);

    // The acceptance the whole commercial relationship rests on: when, and
    // which wording.
    assert.ok(store.disclaimer_accepted_at);
    assert.equal(store.disclaimer_version, 'terms-v2');

    const seeded = supabase.calls.find((c) => c.rpc === 'seed_tenant_features');
    assert.deepEqual(seeded?.args, { target: store.id, plan: 'growth' });

    // The email waits for approval rather than becoming a login now, so a
    // sign-up the operator rejects leaves no account behind.
    const signup = supabase.tables.signups.find((s) => s.phone === NEWCOMER);
    assert.equal(signup.state, 'pending');
    assert.equal(signup.email, 'ada@example.com');
    assert.equal(signup.chat_id, NEWCOMER_CHAT);
    assert.equal(supabase.tables.tenant_members.filter((m) => m.tenant_id === store.id).length, 0);

    const said = waha.sent.map((m) => m.text);
    assert.match(said[1], /business name/i);
    assert.ok(said.some((t) => /doesn't look like an email/i.test(t)));
    assert.match(said.at(-2), /our terms/i);
    assert.match(said.at(-2), /₦25,000 a month/);
    assert.match(said.at(-1), /reviewing your store/i);
    assert.ok(waha.sent.every((m) => m.chatId === NEWCOMER_CHAT));
  } finally {
    restore();
  }
});

test('a store awaiting approval can list, and nothing is posted until it is live', async () => {
  const supabase = makeFakeSupabase(
    seed({ tenant: { status: 'onboarding', waha_session: 'ut-store', waha_status: 'WORKING' }, secret: 's' })
  );
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    await converse(
      [
        incoming('', { media: `${WAHA_URL}/api/files/ut-platform/jacket.jpg` }),
        incoming('Jacket'),
        incoming('35k'),
        incoming('2'),
        incoming('yes'),
      ],
      wahaEnv()
    );

    assert.equal(supabase.tables.products.length, 1);
    assert.equal(supabase.tables.products[0].tenant_id, TENANT);
    // No Status post, and no link: both pages answer "not found" until the
    // store is approved.
    assert.equal(waha.statuses.length, 0);
    assert.match(waha.sent.at(-1).text, /saved/i);
    assert.doesNotMatch(waha.sent.at(-1).text, /\/p\//);
  } finally {
    restore();
  }
});

test('cancelling a sign-up forgets it', async () => {
  const supabase = makeFakeSupabase(seed());
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    await converse(
      [
        incoming('hello', { from: NEWCOMER_CHAT }),
        incoming('Ada Stores', { from: NEWCOMER_CHAT }),
        incoming('cancel', { from: NEWCOMER_CHAT }),
      ],
      wahaEnv()
    );

    assert.equal(supabase.tables.signups.length, 0);
    assert.equal(supabase.tables.tenants.length, 1);
    assert.match(waha.sent.at(-1).text, /nothing was set up/i);
  } finally {
    restore();
  }
});

test('a retried sign-up answer is not applied twice', async () => {
  const supabase = makeFakeSupabase(seed());
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    await worker.fetch(hook(incoming('hello', { from: NEWCOMER_CHAT })), wahaEnv(), {});
    const name = incoming('Ada Stores', { from: NEWCOMER_CHAT, id: 'retried' });
    await worker.fetch(hook(name), wahaEnv(), {});
    const replay = await worker.fetch(hook(name), wahaEnv(), {});

    assert.deepEqual(await replay.json(), { ok: true, replayed: true });
    // Read twice, the name would have been taken as the store type as well.
    assert.equal(supabase.tables.signups[0].state, 'type');
    assert.equal(waha.sent.length, 2);
  } finally {
    restore();
  }
});

test('a seller whose WhatsApp hides their number is still recognised', async () => {
  // WhatsApp increasingly addresses a chat by privacy id (…@lid) rather than
  // by number. The store is found through WAHA's mapping, and the reply goes
  // back to the chat exactly as WhatsApp addressed it.
  const LID = '99887766554433@lid';
  const supabase = makeFakeSupabase(seed());
  const waha = makeFakeWaha({ lids: { [LID]: SELLER_CHAT } });
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    const res = await worker.fetch(hook(incoming('list', { from: LID })), wahaEnv(), {});

    assert.equal(res.status, 200);
    const inbound = supabase.tables.bot_messages.filter((m) => m.direction === 'in');
    assert.equal(inbound.length, 1);
    assert.equal(inbound[0].tenant_id, TENANT);
    assert.ok(waha.sent.length > 0);
    assert.ok(waha.sent.every((m) => m.chatId === LID));
    assert.doesNotMatch(waha.sent[0].text, /isn't linked to a store/i);
  } finally {
    restore();
  }
});

test('a hidden number WAHA cannot resolve is left alone, not told it has no store', async () => {
  const supabase = makeFakeSupabase(seed());
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    const res = await worker.fetch(
      hook(incoming('list', { from: '11122233344455@lid' })),
      wahaEnv(),
      {}
    );

    assert.equal(res.status, 200);
    assert.equal(supabase.tables.bot_messages.length, 0);
    assert.equal(waha.sent.length, 0);
  } finally {
    restore();
  }
});

test('a WAHA that cannot look up hidden numbers is not retried into the ground', async () => {
  // Without the NOWEB store WAHA answers 400 to every lookup. Answering 500
  // would have WAHA re-deliver each message fifteen times, all failing the
  // same way; a 5xx from WAHA, on the other hand, is worth a retry.
  const supabase = makeFakeSupabase(seed());

  for (const [lidsStatus, expected] of [[400, 200], [503, 500]]) {
    const waha = makeFakeWaha({ lidsStatus });
    const restore = installFetch({ supabase, waha, tokens: TOKENS });
    try {
      const res = await worker.fetch(
        hook(incoming('list', { from: '99887766554433@lid' })),
        wahaEnv(),
        {}
      );
      assert.equal(res.status, expected, `WAHA ${lidsStatus}`);
      assert.equal(supabase.tables.bot_messages.length, 0);
      assert.equal(waha.sent.length, 0);
    } finally {
      restore();
    }
  }
});

test('a suspended store cannot list anything', async () => {
  const supabase = makeFakeSupabase(seed({ tenant: { status: 'suspended' } }));
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    await converse([incoming('list'), incoming('', { media: `${WAHA_URL}/api/files/ut-platform/a.jpg` })], wahaEnv());

    assert.equal(supabase.tables.products.length, 0);
    assert.match(waha.sent[0].text, /suspended/i);
  } finally {
    restore();
  }
});

test('inbound on a tenant own session never runs the listing flow', async () => {
  // That session is the seller's real WhatsApp with their real customers in
  // it. A bot answering their buyers is not something to switch on by
  // accident.
  const supabase = makeFakeSupabase(
    seed({ tenant: { waha_session: 'ut-store' }, secret: 'tenant-secret' })
  );
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    const res = await worker.fetch(
      hook(incoming('list', { session: 'ut-store' }), { secret: 'tenant-secret' }),
      wahaEnv(),
      {}
    );

    assert.equal(res.status, 200);
    assert.equal(waha.sent.length, 0);
    assert.equal(supabase.tables.bot_conversations.length, 0);
  } finally {
    restore();
  }
});

// ── LISTING ──────────────────────────────────────────────────────────────────

test('a photo WAHA addresses as localhost is still fetched, from WAHA, with its key', async () => {
  // What production sent: WAHA writes media URLs from WAHA_BASE_URL, which
  // defaults to http://localhost:3000, and the listing failed to save.
  const supabase = makeFakeSupabase(seed());
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    await converse(
      [
        incoming('', { media: 'http://localhost:3000/api/files/ut-platform/pilot.jpeg' }),
        incoming('Honda Pilot 2006'),
        incoming('2,000,000'),
        incoming('4'),
        incoming('negotiable'),
      ],
      wahaEnv()
    );

    assert.equal(supabase.tables.products.length, 1);
    assert.equal(supabase.uploads.length, 1);
    assert.deepEqual(waha.mediaFetches, [
      { path: '/api/files/ut-platform/pilot.jpeg', key: 'waha-key' },
    ]);
  } finally {
    restore();
  }
});

test('media anywhere but WAHA is fetched without the WAHA key', () => {
  const cfg = { wahaUrl: 'https://waha.example', wahaKey: 'secret' };

  assert.deepEqual(mediaRequest(cfg, 'http://localhost:3000/api/files/s/a.jpg'), {
    url: 'https://waha.example/api/files/s/a.jpg',
    headers: { 'X-Api-Key': 'secret' },
  });
  assert.deepEqual(mediaRequest(cfg, 'https://bucket.s3.example/a.jpg'), {
    url: 'https://bucket.s3.example/a.jpg',
    headers: {},
  });
  assert.throws(() => mediaRequest(cfg, 'not a url'), /Bad media URL/);
});

test('a seller lists an item over WhatsApp, photo and all', async () => {
  const supabase = makeFakeSupabase(seed());
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    await converse(
      [
        incoming('', { media: `${WAHA_URL}/api/files/ut-platform/jacket.jpg` }),
        incoming('Brown leather jacket'),
        incoming('35k'),
        incoming('2'),
        incoming('yes'),
      ],
      wahaEnv()
    );

    assert.equal(supabase.tables.products.length, 1);
    const product = supabase.tables.products[0];

    assert.equal(product.tenant_id, TENANT);
    assert.equal(product.title, 'Brown leather jacket');
    assert.equal(Number(product.price), 35000);
    assert.equal(product.condition, 'excellent');
    assert.equal(product.status, 'active');

    // The photo was fetched from WAHA and re-uploaded, and what is stored is
    // the path — not WAHA's URL, which stops resolving the moment that server
    // drops the file.
    assert.equal(supabase.uploads.length, 1);
    assert.equal(product.images.length, 1);
    assert.match(product.images[0], new RegExp(`^${TENANT}/`));
    assert.ok(!product.images[0].startsWith('http'));

    // And the seller was given the link to share.
    assert.match(waha.sent.at(-1).text, /\/p\/PC\d+/);
  } finally {
    restore();
  }
});

test('a linked WhatsApp gets the listing posted to Status', async () => {
  const supabase = makeFakeSupabase(
    seed({ tenant: { waha_session: 'ut-store', waha_status: 'WORKING' }, secret: 's' })
  );
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    await converse(
      [
        incoming('', { media: `${WAHA_URL}/api/files/ut-platform/jacket.jpg` }),
        incoming('Jacket'),
        incoming('35k'),
        incoming('3'),
        incoming('yes'),
      ],
      wahaEnv()
    );

    assert.equal(waha.statuses.length, 1);
    const posted = waha.statuses[0];

    // On the seller's own session, never the platform's — Status goes to
    // their contacts, which is the entire point.
    assert.equal(posted.session, 'ut-store');
    assert.equal(posted.kind, 'image');
    assert.match(posted.file.url, new RegExp(`^${SUPABASE_URL}/storage/v1/object/public/product-images/`));
    assert.match(posted.caption, /Jacket/);
    assert.match(posted.caption, /₦35,000/);
    assert.match(posted.caption, /uniquethrift\.ng\/p\//);

    assert.match(waha.sent.at(-1).text, /Status/);
  } finally {
    restore();
  }
});

test('an unlinked WhatsApp posts nothing and says so', async () => {
  const supabase = makeFakeSupabase(seed());
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    await converse(
      [
        incoming('', { media: `${WAHA_URL}/api/files/ut-platform/a.jpg` }),
        incoming('Jacket'),
        incoming('35k'),
        incoming('3'),
        incoming('yes'),
      ],
      wahaEnv()
    );

    assert.equal(waha.statuses.length, 0);
    assert.match(waha.sent.at(-1).text, /Link your WhatsApp/i);
  } finally {
    restore();
  }
});

test('a session that is linked but not working does not silently swallow a listing', async () => {
  const supabase = makeFakeSupabase(
    seed({ tenant: { waha_session: 'ut-store', waha_status: 'FAILED' }, secret: 's' })
  );
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    await converse(
      [
        incoming('', { media: `${WAHA_URL}/api/files/ut-platform/a.jpg` }),
        incoming('Jacket'),
        incoming('35k'),
        incoming('3'),
        incoming('yes'),
      ],
      wahaEnv()
    );

    // The item still exists; the seller is told it did not reach Status.
    assert.equal(supabase.tables.products.length, 1);
    assert.equal(waha.statuses.length, 0);
    assert.match(waha.sent.at(-1).text, /Link your WhatsApp/i);
  } finally {
    restore();
  }
});

test('a photo WAHA can no longer serve does not produce a listing with no picture', async () => {
  const supabase = makeFakeSupabase(seed());
  const waha = makeFakeWaha({ mediaStatus: 410 });
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    await converse(
      [
        incoming('', { media: `${WAHA_URL}/api/files/ut-platform/gone.jpg` }),
        incoming('Jacket'),
        incoming('35k'),
        incoming('3'),
        incoming('yes'),
      ],
      wahaEnv()
    );

    assert.equal(supabase.tables.products.length, 0);
    assert.match(waha.sent.at(-1).text, /couldn't save those photos/i);
  } finally {
    restore();
  }
});

// ── REPLAYS ──────────────────────────────────────────────────────────────────

test('a retried webhook does not list the same item twice', async () => {
  const supabase = makeFakeSupabase(seed());
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    const confirm = incoming('yes', { id: 'msg-confirm' });

    await converse(
      [
        incoming('', { media: `${WAHA_URL}/api/files/ut-platform/a.jpg` }),
        incoming('Jacket'),
        incoming('35k'),
        incoming('3'),
      ],
      wahaEnv()
    );

    await worker.fetch(hook(confirm), wahaEnv(), {});
    const sentAfterFirst = waha.sent.length;

    // WAHA believes the delivery failed and sends it again.
    const replay = await worker.fetch(hook(confirm), wahaEnv(), {});

    assert.equal(replay.status, 200);
    assert.equal(await replay.json().then((b) => b.replayed), true);
    assert.equal(supabase.tables.products.length, 1);
    assert.equal(waha.sent.length, sentAfterFirst);
  } finally {
    restore();
  }
});

test('an engine that sends no message id still dedupes on the timestamp', async () => {
  const supabase = makeFakeSupabase(seed());
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    const noId = {
      event: 'message',
      session: PLATFORM,
      payload: { from: SELLER_CHAT, text: 'list', timestamp: 1_700_000_500 },
    };

    await worker.fetch(hook(noId), wahaEnv(), {});
    await worker.fetch(hook(noId), wahaEnv(), {});

    assert.equal(supabase.tables.bot_messages.filter((m) => m.direction === 'in').length, 1);
    assert.equal(waha.sent.length, 1);
  } finally {
    restore();
  }
});

// ── SESSION MANAGEMENT ───────────────────────────────────────────────────────

function sessionCall(method, { token, body, tenant = TENANT } = {}) {
  const url =
    method === 'POST'
      ? 'https://example.com/api/waha/session'
      : `https://example.com/api/waha/session?tenant=${tenant}`;

  return new Request(url, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

test('linking a WhatsApp is owner-only, and a stranger gets nothing', async () => {
  const supabase = makeFakeSupabase(seed());
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    for (const token of [undefined, 'forged', 'tok-stranger', 'tok-staff']) {
      const res = await worker.fetch(
        sessionCall('POST', { token, body: { tenant: TENANT } }),
        wahaEnv(),
        {}
      );
      assert.equal(res.status, 403, `token ${token} was allowed to link`);
    }

    assert.equal(waha.created.length, 0);
    assert.equal(supabase.tables.tenants[0].waha_session, null);
  } finally {
    restore();
  }
});

test('an owner links a session, and the webhook it registers carries a secret', async () => {
  const supabase = makeFakeSupabase(seed());
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    const res = await worker.fetch(
      sessionCall('POST', { token: 'tok-owner', body: { tenant: TENANT } }),
      wahaEnv(),
      {}
    );

    assert.equal(res.status, 200);
    assert.equal(waha.created.length, 1);
    assert.equal(waha.created[0].name, 'ut-store');
    assert.deepEqual(waha.created[0].config.webhooks[0].events, ['message', 'session.status']);
    assert.equal(
      waha.created[0].config.webhooks[0].url,
      'https://uniquethrift.ng/api/waha/webhook'
    );

    const header = waha.created[0].config.webhooks[0].customHeaders[0];
    assert.equal(header.name, 'X-Thrift-Secret');

    // The same secret is stored, because it is what every later delivery from
    // this session will be checked against — and it is stored away from the
    // tenant row, which every member of the store can read.
    const tenant = supabase.tables.tenants[0];
    assert.equal(tenant.waha_secret, undefined);
    assert.equal(supabase.tables.whatsapp_secrets.length, 1);
    assert.equal(supabase.tables.whatsapp_secrets[0].tenant_id, TENANT);
    assert.equal(supabase.tables.whatsapp_secrets[0].webhook_secret, header.value);
    assert.ok(header.value.length >= 32);
    assert.equal(tenant.waha_session, 'ut-store');
    assert.deepEqual(waha.started, ['ut-store']);
  } finally {
    restore();
  }
});

test('linking again recovers a link that stopped halfway', async () => {
  // The state production was left in: the secret saved and the session
  // created in WAHA, but never recorded on the store, and failed since.
  const supabase = makeFakeSupabase(seed({ secret: 'kept-secret' }));
  const waha = makeFakeWaha({ sessions: { 'ut-store': { name: 'ut-store', status: 'FAILED' } } });
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    const res = await worker.fetch(
      sessionCall('POST', { token: 'tok-owner', body: { tenant: TENANT } }),
      wahaEnv(),
      {}
    );

    assert.equal(res.status, 200);
    assert.equal(waha.created.length, 0);
    assert.deepEqual(waha.stopped, ['ut-store']);
    assert.deepEqual(waha.started, ['ut-store']);
    assert.equal(supabase.tables.tenants[0].waha_session, 'ut-store');
    // WAHA already signs this session's webhooks with the stored secret.
    assert.equal(supabase.tables.whatsapp_secrets.length, 1);
    assert.equal(supabase.tables.whatsapp_secrets[0].webhook_secret, 'kept-secret');
  } finally {
    restore();
  }
});

test('a member can read the session state, and sees the QR while it waits', async () => {
  const supabase = makeFakeSupabase(
    seed({ tenant: { waha_session: 'ut-store', waha_status: 'STARTING' }, secret: 's' })
  );
  const waha = makeFakeWaha({ sessions: { 'ut-store': { name: 'ut-store', status: 'SCAN_QR_CODE' } } });
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    const res = await worker.fetch(sessionCall('GET', { token: 'tok-staff' }), wahaEnv(), {});
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.status, 'SCAN_QR_CODE');
    assert.equal(body.healthy, false);
    assert.match(body.qr, /^data:image\/png;base64,/);

    // WAHA is the authority, so the cached column is corrected on the way past.
    assert.equal(supabase.tables.tenants[0].waha_status, 'SCAN_QR_CODE');
  } finally {
    restore();
  }
});

test('unlinking removes the session and the secret with it', async () => {
  const supabase = makeFakeSupabase(
    seed({ tenant: { waha_session: 'ut-store', waha_status: 'WORKING' }, secret: 'tenant-secret' })
  );
  const waha = makeFakeWaha({ sessions: { 'ut-store': { name: 'ut-store', status: 'WORKING' } } });
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    const res = await worker.fetch(sessionCall('DELETE', { token: 'tok-owner' }), wahaEnv(), {});
    assert.equal(res.status, 200);

    assert.deepEqual(waha.deleted, ['ut-store']);

    const tenant = supabase.tables.tenants[0];
    assert.equal(tenant.waha_session, null);
    assert.equal(tenant.waha_status, null);
    // A secret left behind for a session nobody owns is a credential with no
    // purpose, and it would still authorise a webhook.
    assert.deepEqual(supabase.tables.whatsapp_secrets, []);
  } finally {
    restore();
  }
});

test('a member cannot ask about a store they do not belong to', async () => {
  const supabase = makeFakeSupabase(seed());
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    const other = 'bbbbbbbb-0000-0000-0000-00000000000b';
    const res = await worker.fetch(
      sessionCall('GET', { token: 'tok-owner', tenant: other }),
      wahaEnv(),
      {}
    );

    assert.equal(res.status, 403);
  } finally {
    restore();
  }
});

// ── CONFIGURATION ────────────────────────────────────────────────────────────

test('a deployment with no WAHA answers rather than crashing', async () => {
  // The Worker ships before the VPS does. Nothing here should 500 just because
  // WAHA_URL has not been set yet.
  const supabase = makeFakeSupabase(seed());
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    const bare = env({ WAHA_SESSION: PLATFORM, WAHA_WEBHOOK_SECRET: SECRET });
    const res = await worker.fetch(hook(incoming('list')), bare, {});

    assert.equal(res.status, 200);
    assert.equal(waha.sent.length, 0);
    // The conversation still advanced, so nothing is lost when WAHA appears.
    assert.equal(supabase.tables.bot_conversations.length, 1);
    assert.equal(supabase.tables.bot_conversations[0].state, 'photo');
  } finally {
    restore();
  }
});

// ── HOW A REPLY ARRIVES ──────────────────────────────────────────────────────

test('every reply is preceded by a moment of "typing…" in the same chat', async () => {
  const supabase = makeFakeSupabase(seed());
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    await converse([incoming('hi'), incoming('list')], wahaEnv());

    assert.ok(waha.sent.length >= 2);
    assert.equal(waha.typing.length, waha.sent.length);
    for (let i = 0; i < waha.events.length; i += 2) {
      assert.deepEqual(waha.events[i], { typing: SELLER_CHAT });
      assert.deepEqual(waha.events[i + 1], { sent: SELLER_CHAT });
    }
    assert.ok(waha.typing.every((t) => t.session === PLATFORM));
  } finally {
    restore();
  }
});

test('typing can be switched off, and a refusal to show it never loses the reply', async () => {
  const supabase = makeFakeSupabase(seed());
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    await worker.fetch(hook(incoming('hi')), wahaEnv({ WAHA_TYPING_MS: '0' }), {});
    assert.equal(waha.typing.length, 0);
    assert.equal(waha.sent.length, 1);
  } finally {
    restore();
  }

  const quiet = makeFakeWaha();
  const handler = quiet.handler;
  quiet.handler = (url, init) =>
    new URL(url).pathname === '/api/startTyping'
      ? new Response('nope', { status: 500 })
      : handler(url, init);
  const restore2 = installFetch({ supabase: makeFakeSupabase(seed()), waha: quiet, tokens: TOKENS });
  try {
    await worker.fetch(hook(incoming('hi')), wahaEnv(), {});
    assert.equal(quiet.sent.length, 1);
  } finally {
    restore2();
  }
});

// ── ITEMS BROUGHT TO A STORE ─────────────────────────────────────────────────
//
// On the store's own session: somebody offers the store an item, it lands in
// the review queue, and the store approves or declines it from the dashboard.

const CONSIGNOR_PHONE = '2348097776655';
const CONSIGNOR_CHAT = `${CONSIGNOR_PHONE}@c.us`;
const STORE_SESSION = 'ut-store';
const STORE_SECRET = 'tenant-secret';

function storeSeed(tenant = {}) {
  return seed({
    tenant: { waha_session: STORE_SESSION, waha_status: 'WORKING', ...tenant },
    secret: STORE_SECRET,
  });
}

async function toStore(messages) {
  for (const m of messages) {
    await worker.fetch(hook(m, { secret: STORE_SECRET }), wahaEnv(), {});
  }
}

const fromConsignor = (body, extra = {}) =>
  incoming(body, { session: STORE_SESSION, from: CONSIGNOR_CHAT, ...extra });

function decideCall(token, body) {
  return new Request('https://uniquethrift.ng/api/submissions/decide', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test("somebody offers an item on the store's own number, and it waits for review", async () => {
  const supabase = makeFakeSupabase(storeSeed());
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    await toStore([
      fromConsignor('SELL'),
      fromConsignor('', { media: `${WAHA_URL}/api/files/${STORE_SESSION}/bag.jpg` }),
      fromConsignor('Brown leather bag'),
      fromConsignor('15k'),
      fromConsignor('3'),
      fromConsignor('Ada Obi'),
      fromConsignor('yes'),
    ]);

    assert.equal(supabase.tables.submissions.length, 1);
    const item = supabase.tables.submissions[0];
    assert.equal(item.tenant_id, TENANT);
    assert.equal(item.title, 'Brown leather bag');
    assert.equal(item.asking_price, 15000);
    assert.equal(item.condition, 'good');
    assert.equal(item.seller_name, 'Ada Obi');
    assert.equal(item.seller_chat_id, CONSIGNOR_CHAT);
    assert.equal(item.seller_phone, CONSIGNOR_PHONE);
    assert.equal(item.images.length, 1);
    assert.match(item.images[0], new RegExp(`^${TENANT}/`));
    // Nothing is listed until the store says so.
    assert.equal(supabase.tables.products.length, 0);

    // Every answer to the seller came from the store's own number.
    const toSeller = waha.sent.filter((m) => m.chatId === CONSIGNOR_CHAT);
    assert.ok(toSeller.length >= 7);
    assert.ok(toSeller.every((m) => m.session === STORE_SESSION));
    assert.match(toSeller.at(-1).text, /Sent!/);

    // And the owner heard about it on the platform number.
    const toOwner = waha.sent.filter((m) => m.chatId === SELLER_CHAT);
    assert.equal(toOwner.length, 1);
    assert.equal(toOwner[0].session, PLATFORM);
    assert.match(toOwner[0].text, /New item to review: \*Brown leather bag\*/);
    assert.match(toOwner[0].text, /\/dashboard\/submissions/);
  } finally {
    restore();
  }
});

test("a store's customers are not answered, and their messages are not stored", async () => {
  const supabase = makeFakeSupabase(storeSeed());
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    await toStore([
      fromConsignor('Hi, is the bag still available?'),
      fromConsignor('do you sell shoes?'),
      fromConsignor('', { media: `${WAHA_URL}/api/files/${STORE_SESSION}/x.jpg` }),
    ]);

    assert.equal(waha.sent.length, 0);
    assert.equal(supabase.tables.bot_messages.length, 0);
    assert.equal(supabase.tables.bot_conversations.length, 0);
  } finally {
    restore();
  }
});

test('a brand store sells its own stock, so SELL is left for the owner', async () => {
  const supabase = makeFakeSupabase(storeSeed({ store_type: 'brand' }));
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    await toStore([fromConsignor('SELL')]);
    assert.equal(waha.sent.length, 0);
    assert.equal(supabase.tables.bot_conversations.length, 0);
  } finally {
    restore();
  }
});

function queued(extra = {}) {
  return {
    id: 'bbbbbbbb-0000-0000-0000-00000000000b',
    tenant_id: TENANT,
    seller_chat_id: CONSIGNOR_CHAT,
    seller_phone: CONSIGNOR_PHONE,
    seller_name: 'Ada Obi',
    title: 'Brown leather bag',
    asking_price: 15000,
    condition: 'good',
    images: [`${TENANT}/bag.jpg`],
    status: 'pending',
    ...extra,
  };
}

test('approving lists the item at the store price, posts it and tells the seller', async () => {
  const supabase = makeFakeSupabase({ ...storeSeed(), submissions: [queued()] });
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    const res = await worker.fetch(
      decideCall('tok-staff', { tenant: TENANT, id: queued().id, decision: 'approve', price: '20k' }),
      wahaEnv(),
      {}
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'approved');
    assert.equal(body.notified, true);
    assert.equal(body.posted, true);

    const product = supabase.tables.products[0];
    assert.equal(product.tenant_id, TENANT);
    assert.equal(product.title, 'Brown leather bag');
    assert.equal(product.price, 20000);
    assert.equal(product.status, 'active');
    assert.deepEqual(product.images, [`${TENANT}/bag.jpg`]);

    const item = supabase.tables.submissions[0];
    assert.equal(item.status, 'approved');
    assert.equal(item.product_id, product.id);
    assert.equal(item.decided_by, STAFF.id);
    assert.equal(item.asking_price, 15000);

    assert.equal(waha.statuses.length, 1);
    assert.equal(waha.statuses[0].session, STORE_SESSION);

    const told = waha.sent.at(-1);
    assert.equal(told.chatId, CONSIGNOR_CHAT);
    assert.equal(told.session, STORE_SESSION);
    assert.match(told.text, /listed your \*Brown leather bag\* for ₦20,000/);
    assert.match(told.text, new RegExp(`/p/${product.public_code}`));

    // Once decided, it stays decided.
    const again = await worker.fetch(
      decideCall('tok-owner', { tenant: TENANT, id: queued().id, decision: 'decline' }),
      wahaEnv(),
      {}
    );
    assert.equal(again.status, 409);
    assert.equal(supabase.tables.submissions[0].status, 'approved');
  } finally {
    restore();
  }
});

test('approving without a price lists it at what the seller asked', async () => {
  const supabase = makeFakeSupabase({ ...storeSeed(), submissions: [queued()] });
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    const res = await worker.fetch(
      decideCall('tok-owner', { tenant: TENANT, id: queued().id, decision: 'approve' }),
      wahaEnv(),
      {}
    );
    assert.equal(res.status, 200);
    assert.equal(supabase.tables.products[0].price, 15000);

    const bad = makeFakeSupabase({ ...storeSeed(), submissions: [queued()] });
    restore();
    const again = installFetch({ supabase: bad, waha, tokens: TOKENS });
    try {
      const refused = await worker.fetch(
        decideCall('tok-owner', { tenant: TENANT, id: queued().id, decision: 'approve', price: 'lots' }),
        wahaEnv(),
        {}
      );
      assert.equal(refused.status, 400);
      assert.equal(bad.tables.products.length, 0);
      assert.equal(bad.tables.submissions[0].status, 'pending');
    } finally {
      again();
    }
  } finally {
    restore();
  }
});

test('declining tells the seller why, and lists nothing', async () => {
  const supabase = makeFakeSupabase({ ...storeSeed(), submissions: [queued()] });
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    const res = await worker.fetch(
      decideCall('tok-owner', {
        tenant: TENANT,
        id: queued().id,
        decision: 'decline',
        reason: "  We're full on bags   right now ",
      }),
      wahaEnv(),
      {}
    );
    assert.equal(res.status, 200);
    assert.equal(supabase.tables.products.length, 0);

    const item = supabase.tables.submissions[0];
    assert.equal(item.status, 'declined');
    assert.equal(item.decline_reason, "We're full on bags right now");

    assert.equal(waha.sent.at(-1).chatId, CONSIGNOR_CHAT);
    assert.equal(waha.sent.at(-1).session, STORE_SESSION);
    assert.match(waha.sent.at(-1).text, /Reason: We're full on bags right now/);
  } finally {
    restore();
  }
});

test('only the store team can decide, and only on its own items', async () => {
  const other = 'cccccccc-0000-0000-0000-00000000000c';
  const supabase = makeFakeSupabase({
    ...storeSeed(),
    submissions: [queued({ tenant_id: other })],
  });
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    const stranger = await worker.fetch(
      decideCall('tok-stranger', { tenant: TENANT, id: queued().id, decision: 'approve' }),
      wahaEnv(),
      {}
    );
    assert.equal(stranger.status, 403);

    // A member of this store naming another store's item finds nothing.
    const elsewhere = await worker.fetch(
      decideCall('tok-owner', { tenant: TENANT, id: queued().id, decision: 'approve' }),
      wahaEnv(),
      {}
    );
    assert.equal(elsewhere.status, 404);

    assert.equal(supabase.tables.products.length, 0);
    assert.equal(waha.sent.length, 0);
  } finally {
    restore();
  }
});

test('a store whose WhatsApp is unlinked can still decide, and is told the seller was not', async () => {
  const supabase = makeFakeSupabase({
    ...storeSeed({ waha_status: 'FAILED' }),
    submissions: [queued()],
  });
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    const res = await worker.fetch(
      decideCall('tok-owner', { tenant: TENANT, id: queued().id, decision: 'approve' }),
      wahaEnv(),
      {}
    );
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.notified, false);
    assert.equal(supabase.tables.products.length, 1);
    assert.equal(waha.sent.length, 0);
  } finally {
    restore();
  }
});

// ── POSTING TO STATUS FROM THE DASHBOARD ─────────────────────────────────────

function statusCall(token, body) {
  return new Request('https://uniquethrift.ng/api/listings/status', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const LISTING = {
  id: 'dddddddd-0000-0000-0000-00000000000d',
  tenant_id: TENANT,
  public_code: 'AB12CD',
  title: 'Linen shirt',
  price: 9500,
  condition: 'good',
  images: [`${TENANT}/shirt.jpg`],
  status: 'active',
};

test('a listing added in the dashboard can be posted to Status, and the post is recorded', async () => {
  const supabase = makeFakeSupabase({ ...storeSeed(), products: [LISTING] });
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    const res = await worker.fetch(statusCall('tok-staff', { tenant: TENANT, id: LISTING.id }), wahaEnv(), {});
    assert.equal(res.status, 200);

    assert.equal(waha.statuses.length, 1);
    assert.equal(waha.statuses[0].session, STORE_SESSION);
    assert.match(waha.statuses[0].caption, /Linen shirt/);
    assert.match(waha.statuses[0].caption, /\/p\/AB12CD/);

    const row = supabase.tables.listing_channel_posts[0];
    assert.equal(row.product_id, LISTING.id);
    assert.equal(row.channel, 'whatsapp');
    assert.equal(row.status, 'posted');

    // Posting again updates the same row rather than adding one.
    await worker.fetch(statusCall('tok-owner', { tenant: TENANT, id: LISTING.id }), wahaEnv(), {});
    assert.equal(supabase.tables.listing_channel_posts.length, 1);
    assert.equal(waha.statuses.length, 2);
  } finally {
    restore();
  }
});

test('posting to Status says why it cannot, and posts nothing', async () => {
  const cases = [
    [{ tenant: { waha_status: 'FAILED' } }, /Link your WhatsApp/],
    [{ tenant: { status: 'onboarding' } }, /waiting for approval/],
    [{ product: { status: 'sold' } }, /Only live listings/],
    [{ product: { images: [] } }, /Add a photo/],
  ];

  for (const [change, message] of cases) {
    const supabase = makeFakeSupabase({
      ...storeSeed(change.tenant ?? {}),
      products: [{ ...LISTING, ...(change.product ?? {}) }],
    });
    const waha = makeFakeWaha();
    const restore = installFetch({ supabase, waha, tokens: TOKENS });
    try {
      const res = await worker.fetch(statusCall('tok-owner', { tenant: TENANT, id: LISTING.id }), wahaEnv(), {});
      assert.equal(res.status, 409, String(message));
      assert.match((await res.json()).error, message);
      assert.equal(waha.statuses.length, 0);
    } finally {
      restore();
    }
  }

  const supabase = makeFakeSupabase({ ...storeSeed(), products: [LISTING] });
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });
  try {
    const res = await worker.fetch(statusCall('tok-stranger', { tenant: TENANT, id: LISTING.id }), wahaEnv(), {});
    assert.equal(res.status, 403);
    assert.equal(waha.statuses.length, 0);
  } finally {
    restore();
  }
});

test("a bot listing's Status post lights its WhatsApp icon too", async () => {
  const supabase = makeFakeSupabase(storeSeed());
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });
  try {
    await converse(
      [
        incoming('', { media: `${WAHA_URL}/api/files/ut-platform/jacket.jpg` }),
        incoming('Jacket'),
        incoming('35k'),
        incoming('3'),
        incoming('yes'),
      ],
      wahaEnv()
    );
    const product = supabase.tables.products[0];
    const row = supabase.tables.listing_channel_posts.find((r) => r.product_id === product.id);
    assert.equal(row?.status, 'posted');
  } finally {
    restore();
  }
});

test('an owner saying hi gets the menu, with the items waiting for them', async () => {
  const supabase = makeFakeSupabase({ ...seed(), submissions: [queued(), queued({ id: 'x2', status: 'approved' })] });
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });
  try {
    await converse([incoming('hi')], wahaEnv());
    assert.equal(waha.sent.length, 1);
    assert.equal(waha.sent[0].session, PLATFORM);
    assert.match(waha.sent[0].text, /Hi Thrift Store!/);
    assert.match(waha.sent[0].text, /\(1 waiting\)/);
  } finally {
    restore();
  }
});

// PASSWORD: a new set-password link for the owner, sent back to the store's
// own number, pointing at our welcome page rather than Supabase's one-time
// link (WAHA fetches every URL it sends for a preview, which would spend it).
test('an owner who replies PASSWORD gets a fresh set-password link for their own account', async () => {
  const supabase = makeFakeSupabase({
    ...seed(),
    tenant_members: [
      { tenant_id: TENANT, user_id: OWNER.id, role: 'owner', email: 'owner@store.test', invited_at: '2026-09-01T00:00:00Z' },
      { tenant_id: TENANT, user_id: STAFF.id, role: 'staff', email: 'staff@store.test', invited_at: '2026-09-02T00:00:00Z' },
    ],
  });
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });
  const routed = globalThis.fetch;
  const generated = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/auth/v1/admin/generate_link')) {
      const body = JSON.parse(init.body);
      generated.push({ ...body, url });
      return new Response(
        JSON.stringify({
          user: { id: OWNER.id, email: body.email },
          properties: { action_link: 'https://x.supabase.co/auth/v1/verify?token=t', hashed_token: 'hashed-t', verification_type: body.type },
        }),
        { status: 200 }
      );
    }
    return routed(input, init);
  };
  try {
    await converse([incoming('PASSWORD')], wahaEnv());
    assert.equal(generated.length, 1);
    assert.equal(generated[0].type, 'recovery');
    assert.equal(generated[0].email, 'owner@store.test');

    assert.equal(waha.sent.length, 1);
    assert.equal(waha.sent[0].chatId, SELLER_CHAT);
    assert.match(waha.sent[0].text, /https:\/\/uniquethrift\.ng\/welcome#token_hash=hashed-t&type=recovery/);
    assert.doesNotMatch(waha.sent[0].text, /auth\/v1\/verify/);
  } finally {
    globalThis.fetch = routed;
    restore();
  }
});

test('PASSWORD before approval explains there is no account yet', async () => {
  const supabase = makeFakeSupabase({ ...seed({ tenant: { status: 'onboarding' } }), tenant_members: [] });
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });
  try {
    await converse([incoming('forgot password')], wahaEnv());
    assert.equal(waha.sent.length, 1);
    assert.match(waha.sent[0].text, /created when your store is approved/);
  } finally {
    restore();
  }
});

test('every webhook that gets through records when WhatsApp last reached us', async () => {
  const supabase = makeFakeSupabase(seed());
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });
  try {
    await converse([incoming('hi')], wahaEnv());
    const row = supabase.tables.webhook_activity.find((r) => r.session === PLATFORM);
    assert.ok(row?.last_message_at, 'message time recorded');

    await worker.fetch(hook({ event: 'session.status', session: PLATFORM, payload: { status: 'FAILED' } }), wahaEnv(), {});
    assert.equal(supabase.tables.webhook_activity.length, 1);
    assert.equal(row.last_status, 'FAILED');
    // A status event keeps the last message time.
    assert.ok(row.last_message_at);

    // A refused webhook is not activity.
    await worker.fetch(hook(incoming('hi', { session: 'ut-nobody' }), { secret: 'wrong' }), wahaEnv(), {});
    assert.equal(supabase.tables.webhook_activity.length, 1);
  } finally {
    restore();
  }
});
