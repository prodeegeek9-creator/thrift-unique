// The pet site sending a WhatsApp message through its store's number:
// a seller's log-in code, "your changes are approved", or a note to the owner
// that a change is waiting. POST /api/pet-store/send with the same shared key
// as the listings (PET_LISTINGS_KEY, the site's SELLER_API_KEY):
//
//   { phone: "2348031234567", text }   to somebody
//   { to: "owner", text }              to the store's own number
//
// Only stores with pet_listings on can be sent from. A recipient gets at most
// a handful an hour, so a leaked key cannot be used to flood anybody.

import { config } from '../lib/env.js';
import { db } from '../lib/supabase.js';
import { json } from '../lib/http.js';
import { timingSafeEqual } from '../lib/paystack.js';
import { chatId } from '../lib/waha.js';
import { say } from './waha.js';

const MAX_TEXT = 1000;
const PER_HOUR = 8;
const OWNER_PER_HOUR = 60;

export async function handlePetStoreSend(request, env) {
  const cfg = config(env);
  if (!cfg.petListingsKey || !cfg.supabaseUrl) return json({ error: 'Not configured' }, 503);
  const auth = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!timingSafeEqual(auth, cfg.petListingsKey)) return json({ error: 'Unauthorized' }, 401);

  const b = await request.json().catch(() => null);
  const text = typeof b?.text === 'string' ? b.text.trim() : '';
  if (!text || text.length > MAX_TEXT) return json({ error: `text is 1 to ${MAX_TEXT} characters` }, 400);

  const flags = await db(cfg).select('tenant_features', 'flag=eq.pet_listings&enabled=eq.true&select=tenant_id&limit=20');
  const ids = (flags ?? []).map((f) => f.tenant_id);
  if (!ids.length) return json({ error: 'No pet store' }, 404);
  const stores = await db(cfg).select(
    'tenants',
    `id=in.(${ids.join(',')})&select=id,slug,name,status,billing_status,waha_session,waha_status,whatsapp_number`
  );
  const store = typeof b?.store === 'string' ? stores.find((t) => t.slug === b.store) : stores.length === 1 ? stores[0] : null;
  if (!store) return json({ error: 'Name the store' }, 400);
  if (store.status === 'suspended' || store.billing_status === 'paused' || !store.waha_session) {
    return json({ error: 'The store cannot send messages right now' }, 503);
  }

  const owner = b?.to === 'owner';
  const digits = owner ? String(store.whatsapp_number ?? '').replace(/\D/g, '') : String(b?.phone ?? '').replace(/\D/g, '');
  if (!/^\d{10,15}$/.test(digits)) return json({ error: 'A phone number is required' }, 400);
  const to = chatId(digits);

  const since = new Date(Date.now() - 3_600_000).toISOString();
  const recent = await db(cfg).select(
    'bot_messages',
    `tenant_id=eq.${store.id}&chat_id=eq.${encodeURIComponent(to)}&direction=eq.out&created_at=gte.${since}&select=id&limit=${OWNER_PER_HOUR + 1}`
  );
  if (recent.length >= (owner ? OWNER_PER_HOUR : PER_HOUR)) return json({ error: 'Too many messages to this number' }, 429);

  const sent = await say(cfg, store, to, text, { session: store.waha_session });
  return sent ? json({ ok: true }) : json({ error: 'WhatsApp did not take the message' }, 502);
}
