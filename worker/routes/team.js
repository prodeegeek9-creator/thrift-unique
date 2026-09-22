import { require_, originOf } from '../lib/env.js';
import { db } from '../lib/supabase.js';
import { json } from '../lib/http.js';
import { requireMember, refuseMember, NotMember } from '../lib/member.js';

// Adding a colleague to a store.
//
// This is here rather than in the browser for one reason: a membership row
// needs a user_id, and turning "ada@example.com" into a user_id means reading
// auth.users. That table is not in the exposed schema and should not be — it
// holds the password hash and every recovery token. The Worker resolves the
// address through user_id_for_email(), a function only service_role may
// execute, and writes the membership itself.
//
// No email is sent. generate_link returns a link and does not deliver it,
// which suits a platform whose whole premise is that people talk on WhatsApp:
// the owner gets a link and sends it however they already talk to their staff.
// It also means invitations do not silently stop working when a project's SMTP
// is unconfigured or its hourly mail allowance runs out — a failure that shows
// up as "I invited them last week and they never got it".

const ROLES = ['owner', 'manager', 'staff'];

// Deliberately permissive. Email validation that tries to be clever rejects
// real addresses, and the address is proved by the fact that somebody has to
// open a link sent to it.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function handleTeam(request, env, path) {
  const rest = path.slice('/api/team'.length) || '/';

  if (rest === '/invite' && request.method === 'POST') {
    return invite(request, env);
  }

  return json({ error: 'Not found' }, 404);
}

async function invite(request, env) {
  const cfg = require_(env, 'supabaseUrl', 'serviceKey');

  // Where the invited colleague lands after setting a password. Without it
  // they finish on Supabase's own page instead of in the store, which looks
  // like the invitation went wrong.
  cfg.publicOrigin = originOf(request, cfg);

  const body = await request.json().catch(() => ({}));
  const tenantId = body?.tenant;
  const email = String(body?.email ?? '').trim().toLowerCase();
  const role = String(body?.role ?? '').trim();
  const name = String(body?.name ?? '').trim().slice(0, 80) || null;

  let member;
  try {
    // Owner only. A manager who could add staff could add an owner, which is
    // the same thing as promoting themselves.
    member = await requireMember(request, cfg, tenantId, { roles: ['owner'] });
  } catch (err) {
    if (err instanceof NotMember) return refuseMember(err);
    throw err;
  }

  if (!EMAIL.test(email)) return json({ error: "That doesn't look like an email address." }, 400);
  if (!ROLES.includes(role)) return json({ error: 'Pick a role.' }, 400);

  // The Team screen is a Business-tier feature. The UI hides it behind the
  // same flag, but the UI hiding something is not the same as the server
  // refusing it — see the note at the top of src/lib/features.js.
  const flag = await db(cfg).one(
    'tenant_features',
    `tenant_id=eq.${member.tenantId}&flag=eq.team&select=enabled`
  );
  if (!flag?.enabled) {
    return json({ error: 'Adding staff is part of the Business plan.' }, 403);
  }

  // Does this person already have an account? Two quite different outcomes,
  // and the seller should be told which one happened.
  const existingId = await db(cfg).rpc('user_id_for_email', { addr: email });
  const userId = typeof existingId === 'string' ? existingId : null;

  if (userId) {
    const already = await db(cfg).one(
      'tenant_members',
      `tenant_id=eq.${member.tenantId}&user_id=eq.${userId}&select=role`
    );
    if (already) {
      return json({ error: 'They are already on this team.', role: already.role }, 409);
    }

    await addMember(cfg, member, { userId, email, name, role, accepted: true });

    // No link: they already have a password and can simply sign in. Sending
    // an invite link to an existing account would be an extra step that
    // achieves nothing.
    return json({ status: 'added', email, role, link: null });
  }

  let created;
  try {
    created = await generateInvite(cfg, email, {
      redirectTo: cfg.publicOrigin ? `${cfg.publicOrigin}/dashboard` : null,
      data: { invited_to: member.tenantId, display_name: name },
    });
  } catch (err) {
    console.error('invite link failed:', err?.message ?? err);
    return json({ error: 'Could not create an invitation just now. Try again shortly.' }, 502);
  }

  if (!created?.userId) {
    return json({ error: 'Could not create an invitation just now. Try again shortly.' }, 502);
  }

  await addMember(cfg, member, {
    userId: created.userId,
    email,
    name,
    role,
    accepted: false,
  });

  return json({ status: 'invited', email, role, link: created.link });
}

async function addMember(cfg, actor, { userId, email, name, role, accepted }) {
  const now = new Date().toISOString();

  await db(cfg).insert(
    'tenant_members',
    {
      tenant_id: actor.tenantId,
      user_id: userId,
      role,
      display_name: name,
      email,
      invited_by: actor.userId,
      invited_at: now,
      // Somebody who already had an account is on the team the moment the row
      // exists. Somebody being invited is not on it until they open the link.
      accepted_at: accepted ? now : null,
    },
    { onConflict: 'tenant_id,user_id', returning: false }
  );
}

// POST /auth/v1/admin/generate_link
//
// Creates the account if it does not exist and hands back the link, without
// sending anything. Shape read from @supabase/auth-js (GoTrueAdminApi.js):
// the body carries `type` and `email`, `redirectTo` goes on the query string
// as `redirect_to`, and the response has `properties.action_link` and `user`.
async function generateInvite(cfg, email, { redirectTo, data }) {
  const url = new URL(`${cfg.supabaseUrl}/auth/v1/admin/generate_link`);
  if (redirectTo) url.searchParams.set('redirect_to', redirectTo);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: cfg.serviceKey,
      Authorization: `Bearer ${cfg.serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ type: 'invite', email, data }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`generate_link ${res.status}: ${text.slice(0, 200)}`);
  }

  const payload = await res.json().catch(() => null);

  return {
    userId: payload?.user?.id ?? payload?.id ?? null,
    link: payload?.properties?.action_link ?? payload?.action_link ?? null,
  };
}
