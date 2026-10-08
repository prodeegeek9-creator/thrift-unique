import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../index.js';
import { sendPetInvites } from '../routes/petInvites.js';
import { notifyLivePets } from '../routes/petListings.js';
import { ensurePetCallEvents } from '../routes/petCalls.js';
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
function makeFakeWaha({ sessions = {}, mediaStatus = 200, lids = {}, lidsStatus = null, rejectStatus = 200 } = {}) {
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
  const updated = [];
  const rejected = [];

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

    if (path === '/api/rejectCall') {
      rejected.push(body);
      return new Response(rejectStatus === 200 ? '{}' : 'no', { status: rejectStatus });
    }

    if (path === '/api/startTyping') {
      typing.push(body);
      events.push({ typing: body.chatId });
      return new Response('{}', { status: 200 });
    }

    if (path === '/api/sendImage') {
      sent.push({ ...body, image: body.file?.url });
      events.push({ sent: body.chatId });
      return new Response(JSON.stringify({ id: { id: `out-${sent.length}` } }), { status: 200 });
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
      if (init.method === 'PUT' && sessions[name]) {
        sessions[name] = { ...sessions[name], config: body.config };
        updated.push({ name, config: body.config });
        return new Response(JSON.stringify(sessions[name]), { status: 200 });
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

  return { url: WAHA_URL, handler, sent, mediaFetches, typing, events, statuses, started, stopped, created, deleted, updated, rejected, sessions };
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
    assert.equal(store.disclaimer_version, 'terms-v3');

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
    // Messages, status, and calls (answered only for stores that take pets).
    assert.deepEqual(waha.created[0].config.webhooks[0].events, ['message.any', 'session.status', 'call.received']);
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
    assert.match(toSeller.at(-2).text, /Sent!/);
    // Then, since it's their first item: where to pay them, with the rules.
    assert.match(toSeller.at(-1).text, /bank\* and \*account number[\s\S]*2 times in 6 months[\s\S]*same name/);

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

// SHARE: the photos and a caption for Instagram, TikTok or Facebook, sent
// back to the owner on the platform number.
test('SHARE sends the latest item\'s photos and a caption with its link; SHARE <code> picks the item', async () => {
  const supabase = makeFakeSupabase({
    ...seed(),
    products: [
      { id: 'p-old', tenant_id: TENANT, public_code: 'OLD001', title: 'Denim jacket', price: 18000, condition: 'good', status: 'active', images: ['t/a.jpg', 't/b.jpg'], created_at: '2026-09-01T00:00:00Z' },
      { id: 'p-new', tenant_id: TENANT, public_code: 'NEW002', title: 'Leather boots', price: 25000, condition: 'excellent', description: 'Size 42, barely worn.', status: 'active', images: ['t/c.jpg'], created_at: '2026-09-20T00:00:00Z' },
      { id: 'p-sold', tenant_id: TENANT, public_code: 'SLD003', title: 'Sold bag', price: 5000, condition: 'good', status: 'sold', images: ['t/d.jpg'], created_at: '2026-09-25T00:00:00Z' },
    ],
  });
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });
  try {
    await converse([incoming('share')], wahaEnv());
    const [intro, photo, caption] = waha.sent;
    assert.match(intro.text, /Leather boots\*, ready to post/);
    assert.match(photo.image, /t\/c\.jpg$/);
    assert.equal(caption.text, 'Leather boots\n₦25,000 · Excellent\n\nSize 42, barely worn.\n\nOrder here 👉 https://uniquethrift.ng/p/NEW002');

    waha.sent.length = 0;
    await converse([incoming('SHARE old001')], wahaEnv());
    assert.equal(waha.sent.filter((m) => m.image).length, 2);
    assert.match(waha.sent.at(-1).text, /Denim jacket[\s\S]*\/p\/OLD001/);

    waha.sent.length = 0;
    await converse([incoming('share SLD003')], wahaEnv());
    assert.equal(waha.sent.length, 1);
    assert.match(waha.sent[0].text, /can't find an item for sale with the code \*SLD003\*/);
  } finally {
    restore();
  }
});

// A store with no payout account is reminded with every listing, until it
// adds one.
test('every listing reminds a store with no payout account to add one, and stops once it has', async () => {
  const supabase = makeFakeSupabase({ ...seed(), payout_accounts: [] });
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });
  const list = (name) =>
    converse(
      [
        incoming('', { media: `${WAHA_URL}/api/files/ut-platform/${name}.jpg` }),
        incoming(name),
        incoming('35k'),
        incoming('2'),
        incoming('yes'),
      ],
      wahaEnv()
    );
  try {
    await list('Jacket');
    assert.match(waha.sent.at(-1).text, /haven't added the bank account we pay your sales into[\s\S]*\/dashboard\/payouts/);
    await list('Boots');
    assert.match(waha.sent.at(-1).text, /haven't added the bank account/, 'every listing, not just the first');

    supabase.tables.payout_accounts.push({ tenant_id: TENANT, bank_name: 'GTBank', account_last4: '6789' });
    await list('Bag');
    assert.doesNotMatch(waha.sent.at(-1).text, /haven't added the bank account/);
  } finally {
    restore();
  }
});

// ── SIGNING UP ON THE WEB, OPENING THE STORE ON WHATSAPP ────────────────────

const WEB_USER = { id: 'web-user-1', email: 'Ada@Web.ng' };

function webSeed(code = {}) {
  const s = seed();
  s.web_signup_codes = [{ user_id: WEB_USER.id, code: '7K3P9Q', email: 'ada@web.ng', ...code }];
  return s;
}

test('a web account’s code opens the store for that account, without asking for an email', async () => {
  const supabase = makeFakeSupabase(webSeed());
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });
  try {
    await converse(
      [
        incoming('Hi! I want to set up my store. My Vendwyze code is VW-7K3P9Q', { from: NEWCOMER_CHAT }),
        incoming("Ada's Shop", { from: NEWCOMER_CHAT }),
        incoming('2', { from: NEWCOMER_CHAT }), // brand
        incoming('1', { from: NEWCOMER_CHAT }),
        incoming('1', { from: NEWCOMER_CHAT }), // starter
        incoming('yes', { from: NEWCOMER_CHAT }),
      ],
      wahaEnv()
    );
    const said = waha.sent.map((m) => m.text);
    assert.match(said[0], /Linked to your Vendwyze account \(\*ada@web\.ng\*\)/);
    assert.ok(!said.some((t) => /What email should/.test(t)), 'never asked for an email');

    const signup = supabase.tables.signups.find((s) => s.phone === NEWCOMER);
    assert.equal(signup.state, 'pending');
    assert.equal(signup.email, 'ada@web.ng');
    assert.ok(supabase.tables.tenants.find((t) => t.whatsapp_number === NEWCOMER));

    const code = supabase.tables.web_signup_codes[0];
    assert.equal(code.used_phone, NEWCOMER);
    assert.ok(code.used_at);
  } finally { restore(); }
});

test('a code sent part way through a sign-up links the account and asks the same question again', async () => {
  const supabase = makeFakeSupabase(webSeed());
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });
  try {
    await converse(
      [
        incoming('hello', { from: NEWCOMER_CHAT }),
        incoming("Ada's Shop", { from: NEWCOMER_CHAT }),
        incoming('VW-7K3P9Q', { from: NEWCOMER_CHAT }),
      ],
      wahaEnv()
    );
    const last = waha.sent.at(-1).text;
    assert.match(last, /Linked to your Vendwyze account/);
    assert.match(last, /What kind of store is it/, 'still on the store type question');
    const signup = supabase.tables.signups.find((s) => s.phone === NEWCOMER);
    assert.equal(signup.state, 'type');
    assert.equal(signup.email, 'ada@web.ng');
    assert.equal(signup.business_name, "Ada's Shop", 'the code was not taken as the business name');
  } finally { restore(); }
});

test('a code another number has used is ignored: the email is asked for as usual', async () => {
  const supabase = makeFakeSupabase(webSeed({ used_phone: '2348000000001', used_at: new Date().toISOString() }));
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });
  try {
    await converse(
      [
        incoming('Hi! My Vendwyze code is VW-7K3P9Q', { from: NEWCOMER_CHAT }),
        incoming("Ada's Shop", { from: NEWCOMER_CHAT }),
        incoming('2', { from: NEWCOMER_CHAT }),
        incoming('1', { from: NEWCOMER_CHAT }),
        incoming('1', { from: NEWCOMER_CHAT }),
      ],
      wahaEnv()
    );
    assert.match(waha.sent[0].text, /isn't linked to a store/);
    assert.match(waha.sent.at(-1).text, /What email should/);
    assert.equal(supabase.tables.signups.find((s) => s.phone === NEWCOMER).email, null);
    assert.equal(supabase.tables.web_signup_codes[0].used_phone, '2348000000001');
  } finally { restore(); }
});

test('a web account gets one code, and sees its store waiting for approval once opened', async () => {
  const supabase = makeFakeSupabase(seed());
  const restore = installFetch({ supabase, tokens: { ...TOKENS, 'tok-web': WEB_USER } });
  const me = async (token) => {
    const res = await worker.fetch(
      new Request('https://vendwyze.test/api/signup/me', { headers: token ? { Authorization: `Bearer ${token}` } : {} }),
      wahaEnv(),
      {}
    );
    return { status: res.status, body: await res.json() };
  };
  try {
    assert.equal((await me(null)).status, 401);

    const first = await me('tok-web');
    assert.equal(first.status, 200);
    assert.match(first.body.code, /^VW-[A-HJ-NP-Z2-9]{6}$/);
    assert.equal(first.body.hasStore, false);
    assert.equal(first.body.signup, null);
    assert.equal(supabase.tables.web_signup_codes[0].email, 'ada@web.ng', 'kept lower-case');

    assert.equal((await me('tok-web')).body.code, first.body.code, 'the same code every time');
    assert.equal(supabase.tables.web_signup_codes.length, 1);

    supabase.tables.signups.push({ phone: NEWCOMER, state: 'pending', business_name: "Ada's Shop", email: 'ada@web.ng', updated_at: new Date().toISOString() });
    assert.deepEqual((await me('tok-web')).body.signup, { state: 'waiting_approval', business_name: "Ada's Shop" });

    supabase.tables.tenant_members.push({ tenant_id: 'x', user_id: WEB_USER.id, role: 'owner' });
    assert.equal((await me('tok-web')).body.hasStore, true);
  } finally { restore(); }
});

// ── PETS LISTED ON THE STORE'S OWN SITE ──────────────────────────────────────

const PET_SITE = 'https://pets.test/api/seller-listings';

// `sequence` answers the calls in order, then falls back to status/body:
// each entry is { status, body, text } or { throws: true }.
function makeFakePetSite({ status = 201, body = null, sequence = [], states = {}, statusCode = 200 } = {}) {
  const received = [];
  const statusCalls = [];
  const queue = [...sequence];
  const site = {
    url: PET_SITE,
    received,
    statusCalls,
    // slug → 'live' | 'pending' | 'missing', as the site's admin would have left it
    states,
    async handler(url, init) {
      if ((init.method ?? 'GET') === 'GET') {
        const slugs = (new URL(url).searchParams.get('slugs') ?? '').split(',').filter(Boolean);
        statusCalls.push({ url, auth: init.headers?.Authorization ?? null, slugs });
        if (statusCode !== 200) return new Response('no', { status: statusCode });
        return new Response(JSON.stringify({
          live: slugs.filter((x) => site.states[x] === 'live'),
          pending: slugs.filter((x) => site.states[x] === 'pending'),
          missing: slugs.filter((x) => !site.states[x] || site.states[x] === 'missing'),
        }));
      }
      received.push({ url, auth: init.headers?.Authorization ?? null, body: JSON.parse(init.body) });
      const next = queue.shift();
      if (next?.throws) throw new TypeError('network down');
      if (next?.text !== undefined) return new Response(next.text, { status: next.status, headers: { 'content-type': 'text/html' } });
      return new Response(JSON.stringify(next?.body ?? body ?? { ok: true, status: 'pending', id: 'pet-1', slug: 'boerboel-1' }), {
        status: next?.status ?? status,
      });
    },
  };
  return site;
}

function petSeed(enabled = true) {
  return {
    ...storeSeed({ name: 'PuppyPlace' }),
    tenant_features: [{ tenant_id: TENANT, flag: 'pet_listings', enabled }],
    submissions: [],
    ai_usage: [],
    pet_listings: [],
    pet_sellers: [],
  };
}

async function toPetStore(messages, extraEnv = {}) {
  const e = wahaEnv({ PET_LISTINGS_URL: PET_SITE, PET_LISTINGS_KEY: 'pet-key', ...extraEnv });
  for (const m of messages) await worker.fetch(hook(m, { secret: STORE_SECRET }), e, {});
}

const PET_CHAT = [
  fromConsignor('Hi PuppyPlace, I want to sell my dog.'),
  fromConsignor('Boerboel'),
  fromConsignor('10 weeks'),
  fromConsignor('1'),
  fromConsignor('150k'),
  fromConsignor('Lugbe, Abuja'),
  fromConsignor('1'),
  fromConsignor('skip'),
  fromConsignor('', { media: `${WAHA_URL}/api/files/${STORE_SESSION}/pup.jpg` }),
  fromConsignor('done'),
  fromConsignor('Ade'),
  fromConsignor('yes'),
  fromConsignor('yes'),
];

test('a pet store sends a listed dog to its site, and files nothing here', async () => {
  const supabase = makeFakeSupabase(petSeed());
  const waha = makeFakeWaha();
  const petSite = makeFakePetSite();
  const restore = installFetch({ supabase, waha, tokens: TOKENS, petSite });

  try {
    await toPetStore(PET_CHAT);

    assert.equal(petSite.received.length, 1);
    const sent = petSite.received[0];
    assert.equal(sent.auth, 'Bearer pet-key');
    assert.equal(sent.body.breed, 'Boerboel');
    assert.equal(sent.body.type, 'Dog');
    assert.equal(sent.body.price, 150000);
    assert.equal(sent.body.whatsapp, CONSIGNOR_PHONE);
    assert.equal(sent.body.seller_name, 'Ade');
    assert.equal(sent.body.photos.length, 1);
    // Our public copy, not WAHA's private URL.
    assert.match(sent.body.photos[0], new RegExp(`^${SUPABASE_URL}/storage/v1/object/public/product-images/${TENANT}/`));

    assert.equal(supabase.tables.submissions.length, 0);
    assert.equal(supabase.tables.products.length, 0);

    // Remembered against the chat it came from, to tell the seller when it is approved.
    assert.equal(supabase.tables.pet_listings.length, 1);
    assert.deepEqual(
      (({ tenant_id, slug, breed, listing_type, chat_id, status }) => ({ tenant_id, slug, breed, listing_type, chat_id, status }))(supabase.tables.pet_listings[0]),
      { tenant_id: TENANT, slug: 'boerboel-1', breed: 'Boerboel', listing_type: 'sale', chat_id: CONSIGNOR_CHAT, status: 'pending' }
    );

    const toSeller = waha.sent.filter((m) => m.chatId === CONSIGNOR_CHAT);
    assert.ok(toSeller.every((m) => m.session === STORE_SESSION));
    assert.match(toSeller.at(-1).text, /Sent! PuppyPlace will check your listing/);
    const toOwner = waha.sent.filter((m) => m.chatId === SELLER_CHAT);
    assert.equal(toOwner.length, 1);
    assert.match(toOwner[0].text, /New pet listing sent for review: \*Boerboel\*, ₦150,000, Lugbe, Abuja/);
  } finally {
    restore();
  }
});

test('the site refusing a listing tells the seller why', async () => {
  const supabase = makeFakeSupabase(petSeed());
  const waha = makeFakeWaha();
  const petSite = makeFakePetSite({ status: 400, body: { error: 'Invalid listing', details: ['photo 1: larger than 5 MB'] } });
  const restore = installFetch({ supabase, waha, tokens: TOKENS, petSite });

  try {
    await toPetStore(PET_CHAT);
    const last = waha.sent.filter((m) => m.chatId === CONSIGNOR_CHAT).at(-1);
    assert.match(last.text, /couldn't send that listing[\s\S]*photo 1: larger than 5 MB/);
    assert.equal(waha.sent.filter((m) => m.chatId === SELLER_CHAT).length, 0);
  } finally {
    restore();
  }
});

test('buyers on a pet store are not answered', async () => {
  const supabase = makeFakeSupabase(petSeed());
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS, petSite: makeFakePetSite() });

  try {
    await toPetStore([fromConsignor('Do you sell puppies?'), fromConsignor('How much is the Boerboel?')]);
    assert.equal(waha.sent.length, 0);
    assert.equal(supabase.tables.bot_messages.length, 0);
  } finally {
    restore();
  }
});

test('without the flag, or without the site configured, SELL is the usual item intake', async () => {
  for (const [label, seedData, extraEnv] of [
    ['flag off', petSeed(false), {}],
    ['no site', petSeed(true), { PET_LISTINGS_URL: '', PET_LISTINGS_KEY: '' }],
  ]) {
    const supabase = makeFakeSupabase(seedData);
    const waha = makeFakeWaha();
    const petSite = makeFakePetSite();
    const restore = installFetch({ supabase, waha, tokens: TOKENS, petSite });
    try {
      await toPetStore([fromConsignor('SELL')], extraEnv);
      assert.equal(supabase.tables.bot_conversations[0]?.state, 'photo', label);
      assert.equal(petSite.received.length, 0, label);
    } finally {
      restore();
    }
  }
});

test('a failure on the site side keeps the seller answers, tells the owner why, and one YES retries it', async () => {
  const supabase = makeFakeSupabase(petSeed());
  const waha = makeFakeWaha();
  const petSite = makeFakePetSite({ sequence: [{ status: 401, body: { error: 'Unauthorized' } }] });
  const restore = installFetch({ supabase, waha, tokens: TOKENS, petSite });

  try {
    await toPetStore(PET_CHAT);

    // The first send was refused…
    assert.equal(petSite.received.length, 1);
    const toSeller = waha.sent.filter((m) => m.chatId === CONSIGNOR_CHAT);
    assert.match(toSeller.at(-1).text, /kept your answers\. Reply \*YES\* to try again/);
    // …the seller is back at the summary, with everything they said…
    const conv = supabase.tables.bot_conversations.find((c) => c.chat_id === CONSIGNOR_CHAT);
    assert.equal(conv.state, 'pet_review');
    assert.equal(conv.draft.breed, 'Boerboel');
    assert.equal(conv.draft.images.length, 1);
    // …and the owner learns what really happened, and what to check.
    const toOwner = waha.sent.filter((m) => m.chatId === SELLER_CHAT);
    assert.equal(toOwner.length, 1);
    assert.match(toOwner[0].text, /Boerboel listing could not be sent to the site: HTTP 401 \(Unauthorized\)/);
    assert.match(toOwner[0].text, /PET_LISTINGS_KEY here and SELLER_API_KEY on the site must be the same value/);
    assert.equal(toOwner[0].session, PLATFORM);

    // One YES, and it goes through.
    await toPetStore([fromConsignor('yes')]);
    assert.equal(petSite.received.length, 2);
    // The retry used the copy already saved: WhatsApp's link is not fetched
    // again (it would have expired), and nothing is uploaded twice.
    assert.equal(waha.mediaFetches.length, 1);
    assert.equal(supabase.uploads.length, 1);
    assert.deepEqual(petSite.received[1].body.photos, petSite.received[0].body.photos);
    assert.equal(petSite.received[1].body.breed, 'Boerboel');
    assert.match(waha.sent.filter((m) => m.chatId === CONSIGNOR_CHAT).at(-1).text, /Sent! PuppyPlace will check/);
    assert.equal(supabase.tables.bot_conversations.find((c) => c.chat_id === CONSIGNOR_CHAT).state, 'idle');
    assert.match(waha.sent.filter((m) => m.chatId === SELLER_CHAT).at(-1).text, /New pet listing sent for review/);
  } finally {
    restore();
  }
});

test('a site that cannot be reached, or answers with a firewall page, is explained to the owner', async () => {
  for (const [sequence, expected] of [
    [[{ throws: true }], /no answer from the site[\s\S]*PET_LISTINGS_URL/],
    [[{ status: 403, text: '<html>Attention Required</html>' }], /HTTP 403\.[\s\S]*firewall/],
    [[{ status: 503, body: { error: 'Server not configured' } }], /HTTP 503 \(Server not configured\)[\s\S]*SELLER_API_KEY is missing/],
    [[{ status: 500, body: { error: 'Could not save listing', details: ['null value in column "location" of relation "pets" violates not-null constraint'] } }],
      /HTTP 500 \(Could not save listing: null value in column "location" of relation "pets" violates not-null constraint\)[\s\S]*error saving it/],
  ]) {
    const supabase = makeFakeSupabase(petSeed());
    const waha = makeFakeWaha();
    const restore = installFetch({ supabase, waha, tokens: TOKENS, petSite: makeFakePetSite({ sequence }) });
    try {
      await toPetStore(PET_CHAT);
      const toOwner = waha.sent.filter((m) => m.chatId === SELLER_CHAT);
      assert.equal(toOwner.length, 1, String(expected));
      assert.match(toOwner[0].text, expected);
      assert.match(waha.sent.filter((m) => m.chatId === CONSIGNOR_CHAT).at(-1).text, /Reply \*YES\* to try again/);
    } finally {
      restore();
    }
  }
});

// ── LOOKING AT THE PHOTOS, AND TELLING THE SELLER IT IS LIVE ─────────────────

// A stand-in for the photo-checking model. `verdicts` answers each call in
// order; each is one entry per photo sent in that call.
function makeFakeVision(verdicts, { status = 200 } = {}) {
  const queue = [...verdicts];
  const calls = [];
  return {
    calls,
    async handler(url, init) {
      const body = JSON.parse(init.body);
      const photos = body.messages[0].content.filter((p) => p.type === 'image_url').length;
      calls.push({ photos, key: init.headers.Authorization, detail: body.messages[0].content[1]?.image_url.detail });
      if (status !== 200) return new Response('no', { status });
      const next = queue.shift() ?? Array.from({ length: photos }, () => ({ shows_pet: true, kind: 'dog', face_visible: true }));
      const answers = next.map((v, index) => ({ index, ...v }));
      return new Response(
        JSON.stringify({
          model: 'gpt-4o-mini-2024-07-18',
          choices: [{ message: { content: JSON.stringify({ photos: answers }) } }],
          usage: { prompt_tokens: 300 * photos, completion_tokens: 20 * photos, prompt_tokens_details: { cached_tokens: 0 } },
        }),
        { status: 200 }
      );
    },
  };
}

const DOGFACE = { shows_pet: true, kind: 'dog', face_visible: true };
const NOFACE = { shows_pet: true, kind: 'dog', face_visible: false };
const NOTPET = { shows_pet: false, kind: 'not_an_animal', face_visible: false };
const pic = (n) => fromConsignor('', { media: `${WAHA_URL}/api/files/${STORE_SESSION}/p${n}.jpg` });

function petChatThrough(photos, tail = []) {
  return [
    fromConsignor('Hi PuppyPlace, I want to sell my dog.'), fromConsignor('Boerboel'), fromConsignor('10 weeks'),
    fromConsignor('1'), fromConsignor('150k'), fromConsignor('Lugbe, Abuja'), fromConsignor('1'), fromConsignor('skip'),
    ...photos, fromConsignor('done'), ...tail,
  ];
}
const NAME_TO_YES = [fromConsignor('Ade'), fromConsignor('yes'), fromConsignor('yes')];

const textsTo = (waha, chat) => waha.sent.filter((m) => m.chatId === chat).map((m) => m.text);

test('photos are saved at "done", looked at, and the seller is told what was found', async () => {
  const supabase = makeFakeSupabase(petSeed());
  const waha = makeFakeWaha();
  const petSite = makeFakePetSite();
  const vision = makeFakeVision([[NOTPET, DOGFACE]]);
  const restore = installFetch({ supabase, waha, tokens: TOKENS, petSite, vision });

  try {
    await toPetStore(petChatThrough([pic(1), pic(2)], NAME_TO_YES), { OPENAI_API_KEY: 'oa-key' });

    // Both photos were saved at "done", and looked at in one call.
    assert.equal(vision.calls.length, 1);
    assert.deepEqual(vision.calls[0], { photos: 2, key: 'Bearer oa-key', detail: 'low' });
    // And what it cost is in the same log as the item reviews.
    assert.equal(supabase.tables.ai_usage.length, 1);
    assert.deepEqual(
      (({ tenant_id, purpose, model, images, input_tokens, output_tokens, image_detail }) => ({ tenant_id, purpose, model, images, input_tokens, output_tokens, image_detail }))(supabase.tables.ai_usage[0]),
      { tenant_id: TENANT, purpose: 'pet_photos', model: 'gpt-4o-mini-2024-07-18', images: 2, input_tokens: 600, output_tokens: 40, image_detail: 'low' }
    );
    const seller = textsTo(waha, CONSIGNOR_CHAT);
    assert.ok(seller.some((t) => /Checking your photos/.test(t)));
    assert.ok(seller.some((t) => /I left out a photo:\n• Photo 1: it doesn't show a dog/.test(t)));
    assert.ok(seller.some((t) => /✅ Photos checked: I can see a dog, and its face is clearly visible/.test(t)));
    assert.ok(seller.some((t) => /1 photo ✅ checked/.test(t)));

    // Only the real dog photo went to the site, and the store was told it was checked.
    assert.equal(petSite.received.length, 1);
    assert.equal(petSite.received[0].body.photos.length, 1);
    assert.match(textsTo(waha, SELLER_CHAT).at(-1), /Photos checked: a real pet, face visible/);
  } finally {
    restore();
  }
});

test("a dog whose face is hidden is asked for a face photo, and the first photos are not looked at twice", async () => {
  const supabase = makeFakeSupabase(petSeed());
  const waha = makeFakeWaha();
  const petSite = makeFakePetSite();
  const vision = makeFakeVision([[NOFACE], [DOGFACE]]);
  const restore = installFetch({ supabase, waha, tokens: TOKENS, petSite, vision });

  try {
    await toPetStore(petChatThrough([pic(1)], [pic(2), fromConsignor('done'), ...NAME_TO_YES]), { OPENAI_API_KEY: 'oa-key' });

    const seller = textsTo(waha, CONSIGNOR_CHAT);
    assert.ok(seller.some((t) => /can see your dog, but not its face clearly/.test(t)));
    // The second look was at the new photo only.
    assert.deepEqual(vision.calls.map((c) => c.photos), [1, 1]);
    assert.equal(supabase.tables.ai_usage.length, 2);
    // And both photos are listed, the one with the face first.
    assert.equal(petSite.received[0].body.photos.length, 2);
    // (the photo that was looked at second, and showed the face, is the first one listed)
    const [first, second] = supabase.uploads.map((u) => `${SUPABASE_URL}/storage/v1/object/public/${u.path}`);
    assert.deepEqual(petSite.received[0].body.photos, [second, first]);
    assert.ok(seller.some((t) => /2 photos ✅ checked/.test(t)));
  } finally {
    restore();
  }
});

test('a check that cannot be done never stops a listing, and the store is told why the photos were not checked', async () => {
  for (const [label, extraEnv, vision, expected] of [
    ['no key set up', {}, makeFakeVision([]), /weren't checked automatically \(OPENAI_API_KEY is not set on the Worker\)/],
    ['model refuses', { OPENAI_API_KEY: 'oa-key' }, makeFakeVision([], { status: 429 }), /weren't checked automatically \(OpenAI said HTTP 429\)/],
  ]) {
    const supabase = makeFakeSupabase(petSeed());
    const waha = makeFakeWaha();
    const petSite = makeFakePetSite();
    const restore = installFetch({ supabase, waha, tokens: TOKENS, petSite, vision });
    try {
      await toPetStore(petChatThrough([pic(1)], NAME_TO_YES), extraEnv);
      assert.equal(petSite.received.length, 1, label);
      const seller = textsTo(waha, CONSIGNOR_CHAT);
      assert.ok(!seller.some((t) => /checked/.test(t.replace(/Checking your photos/, ''))), label);
      assert.match(textsTo(waha, SELLER_CHAT).at(-1), expected, label);
      // Nothing was spent, so nothing is logged.
      assert.equal(supabase.tables.ai_usage.length, 0, label);
    } finally {
      restore();
    }
  }
});

// ── INVITING PEOPLE WHO MESSAGED BEFORE THE BOT WAS ANSWERING ────────────────

const INVITEES = ['2349161587256', '2348133944389', '2348130919728'];

function inviteSeed({ flag = true, status = 'pending' } = {}) {
  return {
    ...petSeed(flag),
    pet_invites: INVITEES.map((phone, i) => ({
      id: `inv-${i}`, tenant_id: TENANT, phone, status, attempts: 0, error: null, created_at: `2026-10-08T10:0${i}:00Z`, sent_at: null,
    })),
  };
}
const inviteEnv = () => wahaEnv({ PET_LISTINGS_URL: PET_SITE, PET_LISTINGS_KEY: 'pet-key' });

test('each invited number gets the bot\'s opening message once, from the store number', async () => {
  const supabase = makeFakeSupabase(inviteSeed());
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    const first = await sendPetInvites(inviteEnv());
    assert.deepEqual(first, { sent: 3, failed: 0, skipped: 0 });
    assert.deepEqual(waha.sent.map((m) => m.chatId), INVITEES.map((p) => `${p}@c.us`));
    assert.ok(waha.sent.every((m) => m.session === STORE_SESSION));
    assert.match(waha.sent[0].text, /This is the PuppyPlace listing assistant\. Sorry we missed your message earlier/);
    assert.match(waha.sent[0].text, /Reply \*SELL\* to start/);
    assert.match(waha.sent[0].text, /Looking to buy instead\?[\s\S]*https:\/\/pets\.test\/pets\.html/);
    assert.deepEqual(supabase.tables.pet_invites.map((r) => r.status), ['sent', 'sent', 'sent']);
    assert.ok(supabase.tables.pet_invites.every((r) => r.sent_at && r.attempts === 1));

    // A second sweep finds nothing to send: nobody is messaged twice.
    assert.equal(await sendPetInvites(inviteEnv()), null);
    assert.equal(waha.sent.length, 3);
  } finally {
    restore();
  }
});

test('an invitation is never sent for a store that does not take pets, or twice for one already claimed', async () => {
  const off = makeFakeSupabase(inviteSeed({ flag: false }));
  const waha = makeFakeWaha();
  let restore = installFetch({ supabase: off, waha, tokens: TOKENS });
  try {
    assert.deepEqual(await sendPetInvites(inviteEnv()), { sent: 0, failed: 3, skipped: 0 });
    assert.equal(waha.sent.length, 0);
    assert.ok(off.tables.pet_invites.every((r) => r.status === 'failed' && /not set up/.test(r.error)));
  } finally {
    restore();
  }

  // A row another sweep is already sending, or one that sent, is left alone.
  const busy = makeFakeSupabase(inviteSeed({ status: 'sending' }));
  const waha2 = makeFakeWaha();
  restore = installFetch({ supabase: busy, waha: waha2, tokens: TOKENS });
  try {
    assert.equal(await sendPetInvites(inviteEnv()), null);
    assert.equal(waha2.sent.length, 0);
  } finally {
    restore();
  }
});

test('WhatsApp refusing an invitation is retried a few times, then given up on', async () => {
  const supabase = makeFakeSupabase({ ...inviteSeed(), pet_invites: [{ id: 'i1', tenant_id: TENANT, phone: INVITEES[0], status: 'pending', attempts: 0, error: null, created_at: '2026-10-08T10:00:00Z', sent_at: null }] });
  const waha = makeFakeWaha();
  const through = waha.handler;
  waha.handler = async (url, init) => (url.endsWith('/api/sendText') ? new Response('nope', { status: 500 }) : through(url, init));
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    await sendPetInvites(inviteEnv());
    assert.deepEqual([supabase.tables.pet_invites[0].status, supabase.tables.pet_invites[0].attempts], ['pending', 1]);
    await sendPetInvites(inviteEnv());
    await sendPetInvites(inviteEnv());
    assert.deepEqual([supabase.tables.pet_invites[0].status, supabase.tables.pet_invites[0].attempts], ['failed', 3]);
    assert.match(supabase.tables.pet_invites[0].error, /did not take/);
    assert.equal(await sendPetInvites(inviteEnv()), null);
  } finally {
    restore();
  }
});

test('the every-minute job sends the invitations', async () => {
  const supabase = makeFakeSupabase(inviteSeed());
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });
  const waits = [];

  try {
    await worker.scheduled({ cron: '* * * * *' }, inviteEnv(), { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    assert.equal(waha.sent.length, 3);
    assert.ok(supabase.tables.pet_invites.every((r) => r.status === 'sent'));
  } finally {
    restore();
  }
});

// ── TELLING THE SELLER THEIR PET IS LIVE ─────────────────────────────────────

const SELLER_A = '144525699858492@lid';
const SELLER_B = '40218493227115@lid';

function listingsSeed(rows) {
  return {
    ...petSeed(),
    pet_listings: rows.map(([slug, chat, status = 'pending', extra = {}], i) => ({
      id: `pl-${i}`, tenant_id: TENANT, slug, breed: i === 0 ? 'Caucasian shepherd' : 'Lhasa', listing_type: 'sale', chat_id: chat,
      status, attempts: 0, error: null, created_at: new Date().toISOString(), notified_at: null, ...extra,
    })),
  };
}

test('a seller is told when the store approves their listing, however it was approved', async () => {
  const supabase = makeFakeSupabase(listingsSeed([['caucasian-1', SELLER_A], ['lhasa-1', SELLER_B], ['gone-1', SELLER_B]]));
  const waha = makeFakeWaha();
  const petSite = makeFakePetSite({ states: { 'caucasian-1': 'live', 'lhasa-1': 'pending' } });
  const restore = installFetch({ supabase, waha, tokens: TOKENS, petSite });

  try {
    assert.deepEqual(await notifyLivePets(inviteEnv()), { notified: 1, expired: 1, failed: 0 });

    // The site was asked about all three, with the shared key.
    assert.equal(petSite.statusCalls.length, 1);
    assert.deepEqual(petSite.statusCalls[0].slugs, ['caucasian-1', 'lhasa-1', 'gone-1']);
    assert.equal(petSite.statusCalls[0].auth, 'Bearer pet-key');

    // The seller whose pet is live is told in the chat they wrote from, from the store's number…
    assert.equal(waha.sent.length, 2);
    assert.ok(waha.sent.every((m) => m.chatId === SELLER_A && m.session === STORE_SESSION));
    assert.match(waha.sent[0].text, /Your \*Caucasian shepherd\* is now live on PuppyPlace\.[\s\S]*https:\/\/pets\.test\/pets\/caucasian-1[\s\S]*Please share it!/);
    // …with the link again, to forward.
    assert.equal(waha.sent[1].text, '🐾 Caucasian shepherd for sale on PuppyPlace. See photos and details:\nhttps://pets.test/pets/caucasian-1');

    const by = (slug) => supabase.tables.pet_listings.find((r) => r.slug === slug);
    assert.equal(by('caucasian-1').status, 'notified');
    assert.ok(by('caucasian-1').notified_at);
    // Still waiting, and one deleted on the site is no longer waited for.
    assert.equal(by('lhasa-1').status, 'pending');
    assert.equal(by('gone-1').status, 'expired');

    // A told seller is not asked about again, and nobody is told twice.
    await notifyLivePets(inviteEnv());
    assert.deepEqual(petSite.statusCalls[1].slugs, ['lhasa-1']);
    assert.equal(waha.sent.length, 2);

    // The store approves the other one later, and that seller hears too.
    petSite.states['lhasa-1'] = 'live';
    assert.deepEqual(await notifyLivePets(inviteEnv()), { notified: 1, expired: 0, failed: 0 });
    assert.ok(waha.sent.slice(2).every((m) => m.chatId === SELLER_B));
    assert.match(waha.sent[2].text, /Your \*Lhasa\* is now live/);
    assert.equal(await notifyLivePets(inviteEnv()), null);
  } finally {
    restore();
  }
});

test('nothing is asked or sent without a site configured, or when it cannot answer', async () => {
  const supabase = makeFakeSupabase(listingsSeed([['caucasian-1', SELLER_A]]));
  const waha = makeFakeWaha();
  const petSite = makeFakePetSite({ states: { 'caucasian-1': 'live' }, statusCode: 500 });
  const restore = installFetch({ supabase, waha, tokens: TOKENS, petSite });

  try {
    assert.equal(await notifyLivePets(wahaEnv()), null);
    assert.equal(petSite.statusCalls.length, 0);
    // The site down: the listing keeps waiting, and nobody is told anything.
    assert.equal(await notifyLivePets(inviteEnv()), null);
    assert.equal(petSite.statusCalls.length, 1);
    assert.equal(waha.sent.length, 0);
    assert.equal(supabase.tables.pet_listings[0].status, 'pending');
  } finally {
    restore();
  }
});

test('a notice WhatsApp refuses is tried again, a few times, never twice once sent', async () => {
  const supabase = makeFakeSupabase(listingsSeed([['caucasian-1', SELLER_A]]));
  const waha = makeFakeWaha();
  const through = waha.handler;
  waha.handler = async (url, init) => (url.endsWith('/api/sendText') ? new Response('nope', { status: 500 }) : through(url, init));
  const petSite = makeFakePetSite({ states: { 'caucasian-1': 'live' } });
  const restore = installFetch({ supabase, waha, tokens: TOKENS, petSite });

  try {
    await notifyLivePets(inviteEnv());
    assert.deepEqual([supabase.tables.pet_listings[0].status, supabase.tables.pet_listings[0].attempts], ['pending', 1]);
    for (let i = 0; i < 4; i++) await notifyLivePets(inviteEnv());
    assert.deepEqual([supabase.tables.pet_listings[0].status, supabase.tables.pet_listings[0].attempts], ['failed', 5]);
    assert.match(supabase.tables.pet_listings[0].error, /did not take/);
    assert.equal(await notifyLivePets(inviteEnv()), null);
  } finally {
    restore();
  }
});

test('a claim another sweep holds, or old listings nobody approved, are left alone', async () => {
  const old = new Date(Date.now() - 61 * 86_400_000).toISOString();
  const supabase = makeFakeSupabase(listingsSeed([['held-1', SELLER_A, 'notifying'], ['old-1', SELLER_B, 'pending', { created_at: old }]]));
  const waha = makeFakeWaha();
  const petSite = makeFakePetSite({ states: { 'held-1': 'live', 'old-1': 'live' } });
  const restore = installFetch({ supabase, waha, tokens: TOKENS, petSite });

  try {
    assert.equal(await notifyLivePets(inviteEnv()), null);
    assert.equal(waha.sent.length, 0);
    assert.equal(supabase.tables.pet_listings.find((r) => r.slug === 'old-1').status, 'expired');
    assert.equal(supabase.tables.pet_listings.find((r) => r.slug === 'held-1').status, 'notifying');
  } finally {
    restore();
  }
});

test('the every-minute job tells sellers their pet is live', async () => {
  const supabase = makeFakeSupabase(listingsSeed([['caucasian-1', SELLER_A]]));
  const waha = makeFakeWaha();
  const petSite = makeFakePetSite({ states: { 'caucasian-1': 'live' } });
  const restore = installFetch({ supabase, waha, tokens: TOKENS, petSite });
  const waits = [];

  try {
    await worker.scheduled({ cron: '* * * * *' }, inviteEnv(), { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    assert.equal(waha.sent.length, 2);
    assert.equal(supabase.tables.pet_listings[0].status, 'notified');
  } finally {
    restore();
  }
});

// ── PEOPLE WHO RING THE STORE'S WHATSAPP ─────────────────────────────────────

const ring = (extra = {}, { session = STORE_SESSION, from = CONSIGNOR_CHAT } = {}) => ({
  event: 'call.received',
  session,
  payload: { id: `call-${++counter}`, from, timestamp: 1_700_000_000 + counter, isVideo: false, isGroup: false, ...extra },
});

async function ringStore(calls, { seedData = petSeed(), env: extraEnv = {}, secret = STORE_SECRET, waha = makeFakeWaha() } = {}) {
  const supabase = makeFakeSupabase(seedData);
  const restore = installFetch({ supabase, waha, tokens: TOKENS });
  const responses = [];
  try {
    for (const c of calls) {
      const res = await worker.fetch(hook(c, { secret }), wahaEnv({ PET_LISTINGS_URL: PET_SITE, PET_LISTINGS_KEY: 'pet-key', ...extraEnv }), {});
      responses.push({ status: res.status, json: await res.json() });
    }
  } finally {
    restore();
  }
  return { supabase, waha, responses };
}

test('somebody who rings a pet store is told, by message, that it does not take calls', async () => {
  const { waha, responses } = await ringStore([ring()]);
  assert.equal(responses[0].json.told, true);
  assert.equal(waha.sent.length, 1);
  assert.equal(waha.sent[0].chatId, CONSIGNOR_CHAT);
  assert.equal(waha.sent[0].session, STORE_SESSION);
  assert.match(waha.sent[0].text, /Sorry, PuppyPlace can't take calls on this number\. Please send us a message here instead/);
  assert.match(waha.sent[0].text, /Reply \*SELL\*[\s\S]*Browse the pets for sale:\nhttps:\/\/pets\.test\/pets\.html/);
});

test('a video call, and a caller whose number WhatsApp hides, are told the same', async () => {
  const hidden = '40218493227115@lid';
  const { waha } = await ringStore([ring({ isVideo: true }), ring({}, { from: hidden })]);
  assert.deepEqual(waha.sent.map((m) => m.chatId), [CONSIGNOR_CHAT, hidden]);
});

test('ringing again within the hour is not told again, but an hour later is', async () => {
  const { waha, responses } = await ringStore([ring(), ring(), ring()]);
  assert.equal(waha.sent.length, 1);
  assert.match(responses[1].json.ignored, /already told this caller/);

  // A notice from two hours ago does not count.
  const seed = petSeed();
  seed.bot_messages.push({
    id: 'old', tenant_id: TENANT, chat_id: CONSIGNOR_CHAT, direction: 'out', body: "PuppyPlace can't take calls on this number.",
    created_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  });
  const later = await ringStore([ring()], { seedData: seed });
  assert.equal(later.waha.sent.length, 1);
  // And a different caller is told on their own account.
  const other = await ringStore([ring(), ring({}, { from: '2348000000001@c.us' })]);
  assert.equal(other.waha.sent.length, 2);
});

test('calls to a store that takes its own, to groups, and from anyone without the secret, are not answered', async () => {
  // A store that is not a pet store keeps its calls.
  const off = await ringStore([ring()], { seedData: petSeed(false) });
  assert.equal(off.waha.sent.length, 0);
  assert.match(off.responses[0].json.ignored, /takes its own calls/);
  // A group call is nobody's seller.
  assert.equal((await ringStore([ring({ isGroup: true })])).waha.sent.length, 0);
  assert.equal((await ringStore([ring({}, { from: '120363000000@g.us' })])).waha.sent.length, 0);
  // The wrong secret is refused and nothing is sent.
  const bad = await ringStore([ring()], { secret: 'wrong' });
  assert.equal(bad.responses[0].status, 403);
  assert.equal(bad.waha.sent.length, 0);
  // A session no store owns.
  assert.equal((await ringStore([ring({}, { session: 'ut-nobody' })])).responses[0].status, 403);
});

// ── keeping the session subscribed to calls ──

const OLD_HOOK = { url: 'https://app.test/api/waha/webhook', events: ['message.any', 'session.status'], customHeaders: [{ name: 'X-Thrift-Secret', value: 'tenant-secret' }] };
const sessionWith = (events) => ({ [STORE_SESSION]: { name: STORE_SESSION, status: 'WORKING', config: { webhooks: [{ ...OLD_HOOK, events }], noweb: { store: { enabled: true } } } } });

test('a pet store linked before calls were answered is subscribed to them, once, keeping its address and secret', async () => {
  const supabase = makeFakeSupabase(petSeed());
  const waha = makeFakeWaha({ sessions: sessionWith(['message.any', 'session.status']) });
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    assert.deepEqual(await ensurePetCallEvents(wahaEnv()), { updated: 1, failed: 0 });
    assert.equal(waha.updated.length, 1);
    const hook = waha.updated[0].config.webhooks[0];
    assert.deepEqual(hook.events, ['message.any', 'session.status', 'call.received']);
    assert.equal(hook.url, OLD_HOOK.url);
    assert.deepEqual(hook.customHeaders, OLD_HOOK.customHeaders);
    // The rest of the session's setup is kept.
    assert.deepEqual(waha.updated[0].config.noweb, { store: { enabled: true } });

    // Done: nothing more to do, and no second restart.
    assert.equal(await ensurePetCallEvents(wahaEnv()), null);
    assert.equal(waha.updated.length, 1);
  } finally {
    restore();
  }
});

test('stores that do not take pets are left alone, and a session with the event already is not touched', async () => {
  for (const [seedData, sessions] of [
    [petSeed(false), sessionWith(['message.any', 'session.status'])],
    [petSeed(true), sessionWith(['message.any', 'session.status', 'call.received'])],
    [petSeed(true), {}],
  ]) {
    const waha = makeFakeWaha({ sessions });
    const restore = installFetch({ supabase: makeFakeSupabase(seedData), waha, tokens: TOKENS });
    try {
      assert.equal(await ensurePetCallEvents(wahaEnv()), null);
      assert.equal(waha.updated.length, 0);
    } finally {
      restore();
    }
  }
});

test('the every-minute job subscribes a pet store to calls on every fifth minute only', async () => {
  for (const [minute, expected] of [[3, 0], [5, 1], [10, 1], [11, 0]]) {
    const waha = makeFakeWaha({ sessions: sessionWith(['message.any', 'session.status']) });
    const restore = installFetch({ supabase: makeFakeSupabase(petSeed()), waha, tokens: TOKENS, petSite: makeFakePetSite() });
    const waits = [];
    try {
      await worker.scheduled({ cron: '* * * * *', scheduledTime: Date.UTC(2026, 9, 8, 10, minute) }, wahaEnv({ PET_LISTINGS_URL: PET_SITE, PET_LISTINGS_KEY: 'pet-key' }), { waitUntil: (p) => waits.push(p) });
      await Promise.all(waits);
      assert.equal(waha.updated.length, expected, `minute ${minute}`);
    } finally {
      restore();
    }
  }
});

// ── DECLINING THE CALL, ONLY FOR SOMEBODY IN A CHAT WITH THE BOT ─────────────

const chatting = (chat, state = 'pet_breed', extra = {}) => ({
  ...petSeed(),
  bot_conversations: [{ tenant_id: TENANT, chat_id: chat, state, draft: {}, updated_at: new Date().toISOString(), paused_until: null, ...extra }],
});

test('a caller who is in the middle of a conversation with the bot has the call declined, and is told', async () => {
  const { waha } = await ringStore([ring()], { seedData: chatting(CONSIGNOR_CHAT) });
  assert.equal(waha.rejected.length, 1);
  assert.deepEqual(waha.rejected[0], { session: STORE_SESSION, from: CONSIGNOR_CHAT, id: `call-${counter}` });
  assert.equal(waha.sent.length, 1);
  assert.match(waha.sent[0].text, /can't take calls/);
});

test('anybody else\'s call is left to ring: told, never declined', async () => {
  for (const [label, seedData] of [
    ['no conversation at all', petSeed()],
    ['a finished one', chatting(CONSIGNOR_CHAT, 'idle')],
    ['one left for hours', chatting(CONSIGNOR_CHAT, 'pet_breed', { updated_at: new Date(Date.now() - 7 * 3_600_000).toISOString() })],
    ['one the owner has stepped into', chatting(CONSIGNOR_CHAT, 'pet_breed', { paused_until: new Date(Date.now() + 3_600_000).toISOString() })],
    ['somebody else\'s conversation', chatting('2348000000001@c.us')],
  ]) {
    const { waha } = await ringStore([ring()], { seedData });
    assert.equal(waha.rejected.length, 0, label);
    assert.equal(waha.sent.length, 1, label);
  }
});

test('every call from somebody in a chat is declined, though they are only told once an hour', async () => {
  const { waha } = await ringStore([ring(), ring(), ring()], { seedData: chatting(CONSIGNOR_CHAT) });
  assert.equal(waha.rejected.length, 3);
  assert.equal(waha.sent.length, 1);
});

test('the chat and the call may name the same person differently, and are still matched', async () => {
  // The conversation is under their hidden WhatsApp id; the call arrives under their number.
  const hidden = '40218493227115@lid';
  const viaNumber = await ringStore([ring()], { seedData: chatting(hidden), waha: makeFakeWaha({ lids: { [hidden]: CONSIGNOR_CHAT } }) });
  assert.equal(viaNumber.waha.rejected.length, 1);
  assert.equal(viaNumber.waha.rejected[0].from, CONSIGNOR_CHAT);
  // And the other way: the call under the hidden id, the chat under the number.
  const viaId = await ringStore([ring({}, { from: hidden })], { seedData: chatting(CONSIGNOR_CHAT), waha: makeFakeWaha({ lids: { [hidden]: CONSIGNOR_CHAT } }) });
  assert.equal(viaId.waha.rejected.length, 1);
  // A hidden id nobody can resolve is not guessed at.
  const unknown = await ringStore([ring()], { seedData: chatting('999@lid'), waha: makeFakeWaha({ lids: {} }) });
  assert.equal(unknown.waha.rejected.length, 0);
  assert.equal(unknown.waha.sent.length, 1);
});

test('a call WhatsApp will not let us decline still gets its message', async () => {
  const { waha } = await ringStore([ring()], { seedData: chatting(CONSIGNOR_CHAT), waha: makeFakeWaha({ rejectStatus: 500 }) });
  assert.equal(waha.rejected.length, 1);
  assert.equal(waha.sent.length, 1);
  assert.match(waha.sent[0].text, /can't take calls/);
});

test('a store that takes its own calls never has one declined', async () => {
  const seed = { ...chatting(CONSIGNOR_CHAT), tenant_features: [{ tenant_id: TENANT, flag: 'pet_listings', enabled: false }] };
  const { waha } = await ringStore([ring()], { seedData: seed });
  assert.equal(waha.rejected.length, 0);
  assert.equal(waha.sent.length, 0);
});

// ── REMEMBERING THE SELLER'S NAME ────────────────────────────────────────────

const NAME_QUESTION = /What name should buyers see/;

test('a seller is asked their name once, and not again on their next listing', async () => {
  const supabase = makeFakeSupabase(petSeed());
  const waha = makeFakeWaha();
  const petSite = makeFakePetSite();
  const restore = installFetch({ supabase, waha, tokens: TOKENS, petSite });

  try {
    // First listing: asked, and told "my name" is not one.
    await toPetStore(petChatThrough([pic(1)], [fromConsignor('my name'), fromConsignor('Ade'), fromConsignor('yes'), fromConsignor('yes')]));
    let seller = textsTo(waha, CONSIGNOR_CHAT);
    assert.equal(seller.filter((t) => NAME_QUESTION.test(t)).length, 1);
    assert.equal(seller.filter((t) => /doesn't look like a real name/.test(t)).length, 1);
    assert.equal(petSite.received[0].body.seller_name, 'Ade');
    // Only the real name is kept.
    assert.deepEqual(supabase.tables.pet_sellers.map((r) => [r.chat_id, r.name]), [[CONSIGNOR_CHAT, 'Ade']]);

    // Second listing, same chat: no name question, the same name goes to the site.
    waha.sent.length = 0;
    await toPetStore(petChatThrough([pic(2)], [fromConsignor('yes'), fromConsignor('yes')]));
    seller = textsTo(waha, CONSIGNOR_CHAT);
    assert.ok(!seller.some((t) => NAME_QUESTION.test(t)));
    assert.ok(seller.some((t) => /I'll list this under \*Ade\*, as last time/.test(t)));
    assert.ok(seller.some((t) => /Seller: Ade \(as before\)/.test(t)));
    assert.equal(petSite.received.length, 2);
    assert.equal(petSite.received[1].body.seller_name, 'Ade');
  } finally {
    restore();
  }
});

test("another seller is not given somebody else's name, and a changed name is the one kept", async () => {
  const seed = petSeed();
  seed.pet_sellers.push({ tenant_id: TENANT, chat_id: '2348000000001@c.us', name: 'Someone Else', updated_at: new Date().toISOString() });
  const supabase = makeFakeSupabase(seed);
  const waha = makeFakeWaha();
  const petSite = makeFakePetSite();
  const restore = installFetch({ supabase, waha, tokens: TOKENS, petSite });

  try {
    // This chat has no name on record: asked.
    await toPetStore(petChatThrough([pic(1)], [fromConsignor('Ade'), fromConsignor('yes'), fromConsignor('yes')]));
    assert.equal(textsTo(waha, CONSIGNOR_CHAT).filter((t) => NAME_QUESTION.test(t)).length, 1);
    // Later they change it at the summary: NAME, then the new one.
    waha.sent.length = 0;
    await toPetStore(petChatThrough([pic(2)], [fromConsignor('yes'), fromConsignor('NAME'), fromConsignor('Royal Paws Kennel'), fromConsignor('yes')]));
    assert.equal(petSite.received.at(-1).body.seller_name, 'Royal Paws Kennel');
    assert.equal(supabase.tables.pet_sellers.find((r) => r.chat_id === CONSIGNOR_CHAT).name, 'Royal Paws Kennel');
    assert.equal(supabase.tables.pet_sellers.find((r) => r.chat_id === '2348000000001@c.us').name, 'Someone Else');
  } finally {
    restore();
  }
});

test('a name is only kept once the listing has reached the site', async () => {
  const supabase = makeFakeSupabase(petSeed());
  const waha = makeFakeWaha();
  const petSite = makeFakePetSite({ sequence: [{ status: 400, body: { error: 'Invalid listing', details: ['photo 1: larger than 5 MB'] } }] });
  const restore = installFetch({ supabase, waha, tokens: TOKENS, petSite });

  try {
    await toPetStore(petChatThrough([pic(1)], NAME_TO_YES));
    assert.equal(supabase.tables.pet_sellers.length, 0);
  } finally {
    restore();
  }
});
