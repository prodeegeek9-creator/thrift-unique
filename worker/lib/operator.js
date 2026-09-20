import { db } from './supabase.js';
import { json } from './http.js';

// The one check that grants cross-tenant access.
//
// Every RLS policy in the database is strictly tenant-scoped with no admin
// exception, so this function is the entire privilege boundary for the
// operator console. That is the point: one place to audit rather than an
// `or is_platform_admin()` bolted onto fifteen policies, where a single
// mistake would open every tenant's data to any seller.
//
// Two steps, and the order matters:
//
//   1. resolve the caller from their Supabase access token, by asking
//      Supabase — not by decoding the JWT here, which would mean trusting a
//      signature we have not verified
//   2. look them up in platform_admins under the service key, a table no
//      client role can read at all
//
// The browser is never asked whether it is an admin. It is told what it may
// see, and a client that lies about step 1 fails step 1.

export class NotOperator extends Error {}

export async function requireOperator(request, cfg, { level = 'support' } = {}) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) throw new NotOperator('No token');

  const token = auth.slice(7).trim();
  if (!token) throw new NotOperator('No token');

  // Ask Supabase who this is. An expired or forged token gets a non-200 here,
  // which is the whole verification — we never parse the token ourselves.
  const res = await fetch(`${cfg.supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: cfg.serviceKey },
  });
  if (!res.ok) throw new NotOperator('Token rejected');

  const user = await res.json().catch(() => null);
  if (!user?.id) throw new NotOperator('No user');

  const admin = await db(cfg).one(
    'platform_admins',
    `user_id=eq.${user.id}&select=user_id,level`
  );
  if (!admin) throw new NotOperator('Not an operator');

  // 'support' can look and can resolve disputes. 'owner' can also move money
  // and change what a tenant pays — because "can read every customer's orders"
  // and "can release forty thousand naira" should not be the same grant.
  if (level === 'owner' && admin.level !== 'owner') {
    throw new NotOperator('Needs owner level');
  }

  return { userId: user.id, level: admin.level, email: user.email ?? null };
}

// Deliberately vague to the caller, specific in the log.
//
// A console that answers "not an operator" differently from "bad token" tells
// an attacker which half of the problem to work on, and the console's own
// users only ever see this when something is genuinely wrong.
export function refuse(err) {
  console.warn('operator refused:', err?.message ?? err);
  return json({ error: 'Not authorised' }, 403);
}

// Every operator action leaves a row. The table rejects UPDATE and DELETE at
// the database, so this is a record rather than a note.
//
// Failures here are logged and swallowed: an audit write that fails must not
// roll back the action it was describing, because the alternative is an
// operator unable to resolve a dispute because logging is down. The log going
// quiet is visible; the console going down mid-incident is worse.
export async function audit(cfg, actor, action, { tenantId = null, subject = null, detail = {} } = {}) {
  try {
    await db(cfg).insert(
      'operator_audit',
      { actor, action, tenant_id: tenantId, subject, detail },
      { returning: false }
    );
  } catch (err) {
    console.error('audit write failed:', action, err?.message ?? err);
  }
}
