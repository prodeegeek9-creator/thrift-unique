import { supabase } from './supabase.js';

// A call to this app's own Worker, as the signed-in person.
//
// For the actions that need credentials the browser must never hold (the
// WAHA key, the service key): the Worker checks the token, checks membership,
// and does the rest. Throws with the Worker's own message, which is written to
// be shown to the seller as it is.
export async function callWorker(path, { method = 'POST', body } = {}) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Not signed in');

  const res = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(payload.error ?? `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return payload;
}
