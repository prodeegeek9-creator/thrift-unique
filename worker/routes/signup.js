import { require_ } from '../lib/env.js';
import { db } from '../lib/supabase.js';
import { json } from '../lib/http.js';
import { resolveUser, NotMember } from '../lib/member.js';

// A web account with no store yet (migration 0036).
//
//   GET /api/signup/me   the account's WhatsApp code, and how far its store
//                        has got: nothing yet, a sign-up in progress on
//                        WhatsApp, or waiting for the operator's approval
//
// The store itself is opened on WhatsApp, from the number it will run on; the
// code is what ties that chat to this account (signupStep in lib/bot.js).

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export async function handleSignup(request, env, path) {
  const cfg = require_(env, 'supabaseUrl', 'serviceKey');
  if (path === '/api/signup/me' && request.method === 'GET') return me(request, cfg);
  return json({ error: 'Not found' }, 404);
}

async function me(request, cfg) {
  let user;
  try {
    user = await resolveUser(request, cfg);
  } catch (err) {
    if (err instanceof NotMember) return json({ error: 'Sign in first.' }, 401);
    throw err;
  }
  const email = String(user.email ?? '').toLowerCase();
  if (!email) return json({ error: 'This account has no email address.' }, 409);

  const store = await db(cfg).one('tenant_members', `user_id=eq.${user.userId}&select=tenant_id`);

  // One code per account, made the first time it's asked for.
  let row = await db(cfg).one('web_signup_codes', `user_id=eq.${user.userId}&select=code,used_at`);
  for (let i = 0; i < 4 && !row; i += 1) {
    row = await db(cfg).insert(
      'web_signup_codes',
      { user_id: user.userId, code: randomCode(), email },
      { onConflict: 'code' }
    );
    // Lost a race with this account's other tab: take the row it made.
    if (!row) row = await db(cfg).one('web_signup_codes', `user_id=eq.${user.userId}&select=code,used_at`);
  }
  if (!row) throw new Error('could not allocate a sign-up code');

  const signup = await db(cfg).one(
    'signups',
    `email=eq.${encodeURIComponent(email)}&select=state,business_name,updated_at&order=updated_at.desc`
  );

  return json({
    code: `VW-${row.code}`,
    hasStore: Boolean(store),
    // 'pending' is a store opened and waiting for approval; anything else
    // is a conversation still going on WhatsApp.
    signup: signup
      ? { state: signup.state === 'pending' ? 'waiting_approval' : 'in_progress', business_name: signup.business_name ?? null }
      : null,
  });
}

// The account a WhatsApp sign-up's code belongs to: its email, or null for a
// code nobody has, or one another number has already used.
export async function accountForCode(cfg, code, phone) {
  if (!code) return null;
  const row = await db(cfg).one('web_signup_codes', `code=eq.${code}&select=user_id,email,used_phone`);
  if (!row) return null;
  if (row.used_phone && row.used_phone !== phone) return null;
  if (!row.used_phone) {
    await db(cfg)
      .update(
        'web_signup_codes',
        `user_id=eq.${row.user_id}&used_phone=is.null`,
        { used_phone: phone, used_at: new Date().toISOString() },
        { returning: false }
      )
      .catch(() => {});
  }
  return row.email;
}
