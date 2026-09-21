import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../index.js';
import { makeFakeSupabase, installFetch, env, requestUrl, SUPABASE_URL } from './fake-supabase.mjs';

// Adding a colleague. The interesting part is who is allowed to, because this
// route writes a row that grants somebody access to a store — and it is the
// only route in the system that can create an account.

const TENANT = 'aaaaaaaa-0000-0000-0000-00000000000a';
const OTHER = 'bbbbbbbb-0000-0000-0000-00000000000b';

const OWNER = { id: 'user-owner', email: 'owner@store.test' };
const MANAGER = { id: 'user-manager', email: 'manager@store.test' };
const STAFF = { id: 'user-staff', email: 'staff@store.test' };
const STRANGER = { id: 'user-stranger', email: 'nobody@example.test' };

const TOKENS = {
  'tok-owner': OWNER,
  'tok-manager': MANAGER,
  'tok-staff': STAFF,
  'tok-stranger': STRANGER,
};

// An account that exists but is not on this team.
const EXISTING = { id: 'user-ada', email: 'ada@example.com' };

function seed({ team = true } = {}) {
  return {
    tenants: [{ id: TENANT, slug: 'store', name: 'Thrift Store', tier: 'business', status: 'active' }],
    tenant_features: [{ tenant_id: TENANT, flag: 'team', enabled: team }],
    tenant_members: [
      { tenant_id: TENANT, user_id: OWNER.id, role: 'owner' },
      { tenant_id: TENANT, user_id: MANAGER.id, role: 'manager' },
      { tenant_id: TENANT, user_id: STAFF.id, role: 'staff' },
    ],
  };
}

// The two things this route reaches that the PostgREST fake does not cover:
// the email lookup, and GoTrue's admin link generator.
function installAuth({ supabase, accounts = {}, generateStatus = 200 }) {
  const generated = [];

  const restore = installFetch({ supabase, tokens: TOKENS });
  const routed = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = requestUrl(input);

    if (url.includes('/rest/v1/rpc/user_id_for_email')) {
      const { addr } = JSON.parse(init.body);
      return new Response(JSON.stringify(accounts[String(addr).toLowerCase()] ?? null), {
        status: 200,
      });
    }

    if (url.startsWith(`${SUPABASE_URL}/auth/v1/admin/generate_link`)) {
      if (generateStatus !== 200) {
        return new Response(JSON.stringify({ msg: 'nope' }), { status: generateStatus });
      }
      const body = JSON.parse(init.body);
      const id = `user-new-${generated.length + 1}`;
      generated.push({ ...body, url });
      return new Response(
        JSON.stringify({
          user: { id, email: body.email },
          properties: { action_link: `https://project.supabase.co/auth/v1/verify?token=abc-${id}` },
        }),
        { status: 200 }
      );
    }

    return routed(input, init);
  };

  return { generated, restore };
}

function call({ token, body }) {
  return new Request('https://example.com/api/team/invite', {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function teamEnv() {
  return env({ PUBLIC_ORIGIN: 'https://uniquethrift.ng' });
}

// ── WHO MAY ADD SOMEBODY ─────────────────────────────────────────────────────

test('only an owner can add a colleague', async () => {
  const supabase = makeFakeSupabase(seed());
  const { generated, restore } = installAuth({ supabase });

  try {
    // A manager who could add staff could add an owner, which is the same
    // thing as promoting themselves.
    for (const token of [undefined, 'forged', 'tok-stranger', 'tok-staff', 'tok-manager']) {
      const res = await worker.fetch(
        call({ token, body: { tenant: TENANT, email: 'ada@example.com', role: 'staff' } }),
        teamEnv(),
        {}
      );
      assert.equal(res.status, 403, `token ${token} was allowed to add somebody`);
    }

    assert.equal(supabase.tables.tenant_members.length, 3);
    assert.equal(generated.length, 0, 'an account was created for a refused caller');
  } finally {
    restore();
  }
});

test('an owner of one store cannot add somebody to another', async () => {
  const supabase = makeFakeSupabase(seed());
  const { restore } = installAuth({ supabase });

  try {
    const res = await worker.fetch(
      call({ token: 'tok-owner', body: { tenant: OTHER, email: 'ada@example.com', role: 'staff' } }),
      teamEnv(),
      {}
    );

    assert.equal(res.status, 403);
    assert.equal(supabase.tables.tenant_members.length, 3);
  } finally {
    restore();
  }
});

test('the server refuses on plan, not just the UI', async () => {
  // The Team screen is behind the `team` flag, but the UI hiding something is
  // not the same as the server refusing it.
  const supabase = makeFakeSupabase(seed({ team: false }));
  const { generated, restore } = installAuth({ supabase });

  try {
    const res = await worker.fetch(
      call({ token: 'tok-owner', body: { tenant: TENANT, email: 'ada@example.com', role: 'staff' } }),
      teamEnv(),
      {}
    );

    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /Business plan/i);
    assert.equal(generated.length, 0);
  } finally {
    restore();
  }
});

// ── THE TWO OUTCOMES ─────────────────────────────────────────────────────────

test('somebody who already has an account is simply added', async () => {
  const supabase = makeFakeSupabase(seed());
  const { generated, restore } = installAuth({
    supabase,
    accounts: { 'ada@example.com': EXISTING.id },
  });

  try {
    const res = await worker.fetch(
      call({
        token: 'tok-owner',
        body: { tenant: TENANT, email: 'Ada@Example.com', role: 'manager', name: 'Ada Obi' },
      }),
      teamEnv(),
      {}
    );

    const payload = await res.json();
    assert.equal(res.status, 200);
    assert.equal(payload.status, 'added');
    // No link, because they already have a password. Sending an invitation to
    // an existing account is a step that achieves nothing.
    assert.equal(payload.link, null);
    assert.equal(generated.length, 0);

    const added = supabase.tables.tenant_members.find((m) => m.user_id === EXISTING.id);
    assert.equal(added.tenant_id, TENANT);
    assert.equal(added.role, 'manager');
    assert.equal(added.display_name, 'Ada Obi');
    // Normalised, so the same person invited as Ada@Example.com and
    // ada@example.com is one row rather than two.
    assert.equal(added.email, 'ada@example.com');
    assert.equal(added.invited_by, OWNER.id);
    assert.ok(added.accepted_at, 'an existing account is on the team immediately');
  } finally {
    restore();
  }
});

test('somebody without an account gets one, and the owner gets the link', async () => {
  const supabase = makeFakeSupabase(seed());
  const { generated, restore } = installAuth({ supabase });

  try {
    const res = await worker.fetch(
      call({
        token: 'tok-owner',
        body: { tenant: TENANT, email: 'new@example.com', role: 'staff', name: 'Chidi' },
      }),
      teamEnv(),
      {}
    );

    const payload = await res.json();
    assert.equal(res.status, 200);
    assert.equal(payload.status, 'invited');
    assert.match(payload.link, /^https:\/\/project\.supabase\.co\/auth\/v1\/verify/);

    assert.equal(generated.length, 1);
    assert.equal(generated[0].type, 'invite');
    assert.equal(generated[0].email, 'new@example.com');
    // Where they land after setting a password.
    assert.match(generated[0].url, /redirect_to=https%3A%2F%2Funiquethrift\.ng%2Fdashboard/);

    const added = supabase.tables.tenant_members.find((m) => m.email === 'new@example.com');
    assert.equal(added.role, 'staff');
    assert.equal(added.display_name, 'Chidi');
    // Not on the team until they open the link — which is what the screen
    // shows as "Invite not accepted".
    assert.equal(added.accepted_at, null);
    assert.ok(added.invited_at);
  } finally {
    restore();
  }
});

test('adding the same person twice says so instead of writing a second row', async () => {
  const supabase = makeFakeSupabase(seed());
  const { restore } = installAuth({
    supabase,
    accounts: { 'staff@store.test': STAFF.id },
  });

  try {
    const res = await worker.fetch(
      call({ token: 'tok-owner', body: { tenant: TENANT, email: 'staff@store.test', role: 'owner' } }),
      teamEnv(),
      {}
    );

    assert.equal(res.status, 409);
    assert.equal(supabase.tables.tenant_members.length, 3);
    // And critically, their existing role is untouched — an invite is not a
    // way to promote somebody who is already here.
    assert.equal(
      supabase.tables.tenant_members.find((m) => m.user_id === STAFF.id).role,
      'staff'
    );
  } finally {
    restore();
  }
});

// ── BAD INPUT ────────────────────────────────────────────────────────────────

test('a bad email or role is refused before any account is created', async () => {
  const supabase = makeFakeSupabase(seed());
  const { generated, restore } = installAuth({ supabase });

  try {
    const bad = [
      { email: '', role: 'staff' },
      { email: 'not-an-email', role: 'staff' },
      { email: 'ada@example', role: 'staff' },
      { email: 'ada@example.com', role: '' },
      { email: 'ada@example.com', role: 'admin' },
      // The one that matters most: a role the enum does not have would be
      // rejected by Postgres, but only after an account had been made.
      { email: 'ada@example.com', role: 'superuser' },
    ];

    for (const body of bad) {
      const res = await worker.fetch(
        call({ token: 'tok-owner', body: { tenant: TENANT, ...body } }),
        teamEnv(),
        {}
      );
      assert.equal(res.status, 400, `accepted ${JSON.stringify(body)}`);
    }

    assert.equal(generated.length, 0);
    assert.equal(supabase.tables.tenant_members.length, 3);
  } finally {
    restore();
  }
});

test('an auth service that will not answer does not leave a half-made member', async () => {
  const supabase = makeFakeSupabase(seed());
  const { restore } = installAuth({ supabase, generateStatus: 500 });

  try {
    const res = await worker.fetch(
      call({ token: 'tok-owner', body: { tenant: TENANT, email: 'new@example.com', role: 'staff' } }),
      teamEnv(),
      {}
    );

    assert.equal(res.status, 502);
    // No row pointing at a user_id that was never created.
    assert.equal(supabase.tables.tenant_members.length, 3);
  } finally {
    restore();
  }
});
