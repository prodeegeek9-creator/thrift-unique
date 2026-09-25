import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../index.js';
import { makeFakeSupabase, installFetch, env, SUPABASE_URL } from './fake-supabase.mjs';

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
function makeFakeWaha({ sessions = {}, mediaStatus = 200, lids = {} } = {}) {
  const sent = [];
  const statuses = [];
  const started = [];
  const created = [];
  const deleted = [];

  async function handler(url, init = {}) {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : null;

    if (path.startsWith('/files/')) {
      if (mediaStatus !== 200) return new Response('gone', { status: mediaStatus });
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    }

    if (path === '/api/sendText') {
      sent.push(body);
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
      const key = decodeURIComponent(lid[2]);
      return lids[key]
        ? new Response(JSON.stringify({ lid: key, pn: lids[key] }), { status: 200 })
        : new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    }

    return new Response('unexpected waha call', { status: 500 });
  }

  return { url: WAHA_URL, handler, sent, statuses, started, created, deleted, sessions };
}

function wahaEnv(extra = {}) {
  return env({
    WAHA_URL,
    WAHA_API_KEY: 'waha-key',
    WAHA_SESSION: PLATFORM,
    WAHA_WEBHOOK_SECRET: SECRET,
    PUBLIC_ORIGIN: 'https://uniquethrift.ng',
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

test('a number belonging to no store is answered once and stored nowhere', async () => {
  const supabase = makeFakeSupabase(seed());
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    const res = await worker.fetch(
      hook(incoming('list', { from: '2349999999999@c.us' })),
      wahaEnv(),
      {}
    );

    assert.equal(res.status, 200);
    assert.equal(supabase.tables.bot_messages.length, 0);
    assert.equal(supabase.tables.bot_conversations.length, 0);
    assert.equal(waha.sent.length, 1);
    assert.match(waha.sent[0].text, /isn't linked to a store/i);
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

test('a suspended store cannot list anything', async () => {
  const supabase = makeFakeSupabase(seed({ tenant: { status: 'suspended' } }));
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    await converse([incoming('list'), incoming('', { media: `${WAHA_URL}/files/a.jpg` })], wahaEnv());

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

test('a seller lists an item over WhatsApp, photo and all', async () => {
  const supabase = makeFakeSupabase(seed());
  const waha = makeFakeWaha();
  const restore = installFetch({ supabase, waha, tokens: TOKENS });

  try {
    await converse(
      [
        incoming('', { media: `${WAHA_URL}/files/jacket.jpg` }),
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
        incoming('', { media: `${WAHA_URL}/files/jacket.jpg` }),
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
        incoming('', { media: `${WAHA_URL}/files/a.jpg` }),
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
        incoming('', { media: `${WAHA_URL}/files/a.jpg` }),
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
        incoming('', { media: `${WAHA_URL}/files/gone.jpg` }),
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
        incoming('', { media: `${WAHA_URL}/files/a.jpg` }),
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
