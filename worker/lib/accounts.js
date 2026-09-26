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
// Creates the account if it does not exist and hands back the link, without
// sending anything. Shape read from @supabase/auth-js (GoTrueAdminApi.js):
// the body carries `type` and `email`, `redirectTo` goes on the query string
// as `redirect_to`, and the response has `properties.action_link` and `user`.
//
// type 'invite' creates a new account; 'recovery' is for one that exists, and
// signs its owner in to choose a new password.
export async function generateInvite(cfg, email, { redirectTo, data, type = 'invite' }) {
  const url = new URL(`${cfg.supabaseUrl}/auth/v1/admin/generate_link`);
  if (redirectTo) url.searchParams.set('redirect_to', redirectTo);

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

  return {
    userId: payload?.user?.id ?? payload?.id ?? null,
    link: payload?.properties?.action_link ?? payload?.action_link ?? null,
  };
}
