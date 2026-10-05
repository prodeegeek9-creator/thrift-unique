// Dashboard accounts, created by the Worker rather than by a sign-up form: a
// colleague an owner invites (routes/team.js), and a seller whose store the
// operator approves (lib/provision.js).
//
// No email is sent. generate_link returns a link and does not deliver it,
// which suits a platform whose whole premise is that people talk on WhatsApp:
// the link goes out over WhatsApp. It also means accounts do not silently stop
// arriving when a project's SMTP is unconfigured or its hourly mail allowance
// runs out.

// Deliberately permissive. Email validation that tries to be clever rejects
// real addresses, and the address is proved by the fact that somebody has to
// open a link sent to it.
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// POST /auth/v1/admin/generate_link
//
// Creates the account if it does not exist and hands back a link, without
// sending anything. Shape read from @supabase/auth-js (GoTrueAdminApi.js):
// the body carries `type` and `email`, and the response has `user` and
// `properties` (action_link, hashed_token, verification_type).
//
// type 'invite' creates a new account; 'recovery' is for one that exists, and
// lets its owner choose a new password.
//
// The link handed back is NOT Supabase's action_link. That one is spent the
// first time anything opens it, and things open links nobody tapped: WAHA
// fetches every URL it sends to build a preview card, and so do WhatsApp and
// email scanners. That is how invitations were arriving already used. Ours
// goes to our own page (`landing`, e.g. /welcome), carrying the hashed token
// in the fragment, and that page only redeems it when the person presses a
// button (src/pages/Welcome.jsx). A preview fetch changes nothing.
//
// Falls back to action_link only if there is no origin to build ours on.
export async function generateInvite(cfg, email, { origin = null, landing = '/welcome', data, type = 'invite' } = {}) {
  const url = new URL(`${cfg.supabaseUrl}/auth/v1/admin/generate_link`);
  if (origin) url.searchParams.set('redirect_to', `${origin}${landing}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: cfg.serviceKey,
      Authorization: `Bearer ${cfg.serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ type, email, ...(data ? { data } : {}) }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`generate_link ${res.status}: ${text.slice(0, 200)}`);
  }

  const payload = await res.json().catch(() => null);
  const props = payload?.properties ?? payload ?? {};

  return {
    userId: payload?.user?.id ?? payload?.id ?? null,
    link: landingLink(origin, landing, props.hashed_token, props.verification_type ?? type) ?? props.action_link ?? null,
  };
}

// /welcome#token_hash=…&type=invite. The fragment never reaches a server, so
// the token stays out of request logs and Referer headers too.
export function landingLink(origin, landing, hashedToken, type) {
  if (!origin || !hashedToken) return null;
  const params = new URLSearchParams({ token_hash: hashedToken, type });
  return `${origin}${landing}#${params}`;
}
