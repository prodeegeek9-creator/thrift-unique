import { db } from './supabase.js';
import { json } from './http.js';

// Who the caller is, and whether they belong to the store they are asking
// about.
//
// Nearly everything a seller does goes through Supabase directly and is
// checked by RLS. This exists for the handful of actions that cannot: linking
// WhatsApp writes a webhook secret and talks to WAHA under the platform's own
// credentials, so the check has to happen here instead.
//
// lib/operator.js resolves a token the same way and deliberately keeps its own
// copy. It is the one place that grants cross-tenant access, and its tests are
// written against its own failure type — sharing a helper with the ordinary
// membership path would make a change here able to loosen it.

export class NotMember extends Error {}

export async function resolveUser(request, cfg) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) throw new NotMember('No token');

  const token = auth.slice(7).trim();
  if (!token) throw new NotMember('No token');

  // Supabase verifies the token, not us. Decoding a JWT locally and believing
  // its claims is the same as not checking at all.
  const res = await fetch(`${cfg.supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: cfg.serviceKey },
  });
  if (!res.ok) throw new NotMember('Token rejected');

  const user = await res.json().catch(() => null);
  if (!user?.id) throw new NotMember('No user');

  return { userId: user.id, email: user.email ?? null };
}

export async function requireMember(request, cfg, tenantId, { roles = null } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(String(tenantId ?? ''))) throw new NotMember('Bad tenant');

  const user = await resolveUser(request, cfg);

  const row = await db(cfg).one(
    'tenant_members',
    `tenant_id=eq.${tenantId}&user_id=eq.${user.userId}&select=role`
  );
  if (!row) throw new NotMember('Not a member of that store');

  if (roles && !roles.includes(row.role)) {
    throw new NotMember(`Needs ${roles.join(' or ')}`);
  }

  return { ...user, tenantId, role: row.role };
}

// Same reasoning as the operator console's refusal: specific in the log,
// uniform to the caller. "Not a member" and "wrong role" answering differently
// tells somebody probing which half to work on.
export function refuseMember(err) {
  console.warn('member refused:', err?.message ?? err);
  return json({ error: 'Not authorised' }, 403);
}
