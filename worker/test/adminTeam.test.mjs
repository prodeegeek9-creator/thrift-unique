import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../index.js';
import { makeFakeSupabase, installFetch, env, requestUrl, SUPABASE_URL } from './fake-supabase.mjs';

// The admin team: who can open the platform console. Reading needs any
// operator; every change needs an owner, and nobody can lock the platform out
// of its own console.

const OWNER = { id: '11111111-0000-0000-0000-000000000001', email: 'owner@platform.test' };
const OWNER2 = { id: '11111111-0000-0000-0000-000000000002', email: 'second@platform.test' };
const SUPPORT = { id: '11111111-0000-0000-0000-000000000003', email: 'support@platform.test' };
const SELLER = { id: '11111111-0000-0000-0000-000000000004', email: 'seller@store.test' };

const TOKENS = { 'tok-owner': OWNER, 'tok-owner2': OWNER2, 'tok-support': SUPPORT, 'tok-seller': SELLER };

function seed({ secondOwner = false } = {}) {
  return {
    platform_admins: [
      { user_id: OWNER.id, level: 'owner', email: OWNER.email, created_at: '2026-01-01T00:00:00Z' },
      { user_id: SUPPORT.id, level: 'support', email: SUPPORT.email, created_at: '2026-02-01T00:00:00Z' },
      ...(secondOwner
        ? [{ user_id: OWNER2.id, level: 'owner', email: OWNER2.email, created_at: '2026-03-01T00:00:00Z' }]
        : []),
    ],
    operator_audit: [],
  };
}

function setup(opts = {}) {
  const sb = makeFakeSupabase(seed(opts));
  const generated = [];
  const restoreBase = installFetch({ supabase: sb, tokens: TOKENS });
  const routed = globalThis.fetch;
  const accounts = { [SELLER.email]: SELLER.id };

  globalThis.fetch = async (input, init) => {
    const url = requestUrl(input);
    if (url.includes('/rest/v1/rpc/user_id_for_email')) {
      const { addr } = JSON.parse(init.body);
      return new Response(JSON.stringify(accounts[String(addr).toLowerCase()] ?? null), { status: 200 });
    }
    if (url.startsWith(`${SUPABASE_URL}/auth/v1/admin/generate_link`)) {
      const body = JSON.parse(init.body);
      const id = `22222222-0000-0000-0000-00000000000${generated.length + 1}`;
      generated.push({ ...body, url });
      return new Response(
        JSON.stringify({
          user: { id, email: body.email },
          properties: { action_link: `https://project.supabase.co/auth/v1/verify?type=${body.type}&t=${id}` },
        }),
        { status: 200 }
      );
    }
    return routed(input, init);
  };

  return { sb, generated, restore: restoreBase };
}

function call(path, { token, method = 'GET', body } = {}) {
  return new Request(`https://uniquethrift.test${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test('any operator can read the team; a seller cannot', async () => {
  const { restore } = setup();
  try {
    const seller = await worker.fetch(call('/api/admin/team', { token: 'tok-seller' }), env(), {});
    assert.equal(seller.status, 403);

    const res = await worker.fetch(call('/api/admin/team', { token: 'tok-support' }), env(), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.team.length, 2);
    assert.deepEqual(body.team.map((m) => m.email), [OWNER.email, SUPPORT.email]);
    assert.equal(body.team.find((m) => m.you).user_id, SUPPORT.id);
  } finally {
    restore();
  }
});

test('support cannot add anybody', async () => {
  const { sb, restore } = setup();
  try {
    const res = await worker.fetch(
      call('/api/admin/team', { token: 'tok-support', method: 'POST', body: { email: 'new@x.test', level: 'owner' } }),
      env(),
      {}
    );
    assert.equal(res.status, 403);
    assert.equal(sb.tables.platform_admins.length, 2);
  } finally {
    restore();
  }
});

test('adding a new person creates their account and hands back a link to the console', async () => {
  const { sb, generated, restore } = setup();
  try {
    const res = await worker.fetch(
      call('/api/admin/team', { token: 'tok-owner', method: 'POST', body: { email: ' New@X.test ', level: 'support' } }),
      env(),
      {}
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'invited');
    assert.match(body.link, /type=invite/);

    assert.equal(generated.length, 1);
    assert.equal(generated[0].type, 'invite');
    assert.equal(generated[0].email, 'new@x.test');
    assert.equal(new URL(generated[0].url).searchParams.get('redirect_to'), 'https://uniquethrift.test/admin/login');

    const row = sb.tables.platform_admins.find((r) => r.email === 'new@x.test');
    assert.equal(row.level, 'support');
    assert.equal(row.added_by, OWNER.id);
    assert.equal(sb.tables.operator_audit.at(-1).action, 'team.add');
  } finally {
    restore();
  }
});

test('adding somebody who already has an account adds them without a link, once', async () => {
  const { sb, generated, restore } = setup();
  try {
    const add = () =>
      worker.fetch(
        call('/api/admin/team', { token: 'tok-owner', method: 'POST', body: { email: SELLER.email, level: 'support' } }),
        env(),
        {}
      );
    const first = await add();
    const body = await first.json();
    assert.equal(body.status, 'added');
    assert.equal(body.link, null);
    assert.equal(generated.length, 0);
    assert.ok(sb.tables.platform_admins.some((r) => r.user_id === SELLER.id));

    const again = await add();
    assert.equal(again.status, 409);
  } finally {
    restore();
  }
});

test('bad email and bad level are refused', async () => {
  const { restore } = setup();
  try {
    for (const body of [{ email: 'nope', level: 'support' }, { email: 'a@b.test', level: 'god' }]) {
      const res = await worker.fetch(call('/api/admin/team', { token: 'tok-owner', method: 'POST', body }), env(), {});
      assert.equal(res.status, 400);
    }
  } finally {
    restore();
  }
});

test('an owner can promote, demote and remove others, and each is audited', async () => {
  const { sb, restore } = setup();
  try {
    let res = await worker.fetch(
      call(`/api/admin/team/${SUPPORT.id}`, { token: 'tok-owner', method: 'POST', body: { level: 'owner' } }),
      env(),
      {}
    );
    assert.equal(res.status, 200);
    assert.equal(sb.tables.platform_admins.find((r) => r.user_id === SUPPORT.id).level, 'owner');

    res = await worker.fetch(
      call(`/api/admin/team/${SUPPORT.id}`, { token: 'tok-owner', method: 'POST', body: { remove: true } }),
      env(),
      {}
    );
    assert.equal(res.status, 200);
    assert.equal(sb.tables.platform_admins.some((r) => r.user_id === SUPPORT.id), false);

    assert.deepEqual(
      sb.tables.operator_audit.map((a) => a.action),
      ['team.level', 'team.remove']
    );
  } finally {
    restore();
  }
});

test('nobody changes their own access, so an owner can never lock the platform out', async () => {
  const { sb, restore } = setup({ secondOwner: true });
  try {
    for (const body of [{ remove: true }, { level: 'support' }]) {
      const self = await worker.fetch(
        call(`/api/admin/team/${OWNER.id}`, { token: 'tok-owner', method: 'POST', body }),
        env(),
        {}
      );
      assert.equal(self.status, 409);
    }
    assert.equal(sb.tables.platform_admins.find((r) => r.user_id === OWNER.id).level, 'owner');

    // With two owners, one may demote the other...
    const demote = await worker.fetch(
      call(`/api/admin/team/${OWNER2.id}`, { token: 'tok-owner', method: 'POST', body: { level: 'support' } }),
      env(),
      {}
    );
    assert.equal(demote.status, 200);

    // ...who, now support, can change nothing.
    const back = await worker.fetch(
      call(`/api/admin/team/${OWNER.id}`, { token: 'tok-owner2', method: 'POST', body: { remove: true } }),
      env(),
      {}
    );
    assert.equal(back.status, 403);
    assert.ok(sb.tables.platform_admins.some((r) => r.user_id === OWNER.id && r.level === 'owner'));
  } finally {
    restore();
  }
});

test('a fresh sign-in link is a recovery link to the console', async () => {
  const { sb, generated, restore } = setup();
  try {
    const support = await worker.fetch(
      call(`/api/admin/team/${OWNER.id}/link`, { token: 'tok-support', method: 'POST' }),
      env(),
      {}
    );
    assert.equal(support.status, 403);

    const res = await worker.fetch(
      call(`/api/admin/team/${SUPPORT.id}/link`, { token: 'tok-owner', method: 'POST' }),
      env(),
      {}
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.link, /type=recovery/);
    assert.equal(generated[0].type, 'recovery');
    assert.equal(generated[0].email, SUPPORT.email);
    assert.equal(sb.tables.operator_audit.at(-1).action, 'team.link');
  } finally {
    restore();
  }
});

test('/me tells the console who is signed in', async () => {
  const { restore } = setup();
  try {
    const res = await worker.fetch(call('/api/admin/me', { token: 'tok-owner' }), env(), {});
    const body = await res.json();
    assert.deepEqual(body, { level: 'owner', email: OWNER.email, user_id: OWNER.id });
  } finally {
    restore();
  }
});
