import { supabase } from './supabase.js';

// Linking a store's WhatsApp, from the browser's side.
//
// Like lib/admin.js, this goes through the Worker rather than Supabase — not
// because of tenancy this time, but because the calls behind it hold the
// platform's WAHA credentials, which the bundle must never see. The browser
// sends its access token and the Worker decides what it is allowed to do with
// it.

async function call(path, { method = 'GET', body } = {}) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Not signed in');

  const res = await fetch(`/api/waha${path}`, {
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

// What WAHA calls each state, in words a seller would use.
//
// STOPPED and FAILED are deliberately not collapsed into one "not working".
// A stopped session was switched off; a failed one logged itself out, usually
// because the phone was unlinked from WhatsApp's own Linked Devices screen,
// and the fix is different.
export const SESSION_COPY = {
  STARTING: { label: 'Starting…', tone: 'pending', body: 'Getting your session ready.' },
  SCAN_QR_CODE: {
    label: 'Scan to link',
    tone: 'pending',
    body: 'Open WhatsApp → Settings → Linked devices → Link a device, and scan this code.',
  },
  WORKING: { label: 'Linked', tone: 'good', body: 'Your listings post to your Status automatically.' },
  FAILED: {
    label: 'Disconnected',
    tone: 'bad',
    body: 'WhatsApp logged this device out. Link it again to keep posting to your Status.',
  },
  STOPPED: { label: 'Stopped', tone: 'bad', body: 'This session is not running.' },
};

export async function fetchWhatsappSession(tenantId) {
  if (!tenantId) return null;
  return call(`/session?tenant=${encodeURIComponent(tenantId)}`);
}

export async function linkWhatsapp(tenantId) {
  return call('/session', { method: 'POST', body: { tenant: tenantId } });
}

export async function unlinkWhatsapp(tenantId) {
  return call(`/session?tenant=${encodeURIComponent(tenantId)}`, { method: 'DELETE' });
}

// How often to re-ask while a QR is on screen.
//
// WAHA rotates the code roughly every twenty seconds, and a stale QR simply
// fails to scan with no explanation — which reads as "this is broken" rather
// than "wait a moment". Five seconds keeps it fresh without turning the screen
// into a poller.
export const QR_POLL_MS = 5_000;
