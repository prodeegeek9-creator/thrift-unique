// Keeping a pet store's WhatsApp session subscribed to calls.
//
// WAHA only sends the events a session was set up with, and the PuppyPlace
// session was linked before calls were answered. This looks at each store with
// pet_listings on and, if its hook lacks call.received, adds it (lib/waha.js
// ensureCallEvents). Cheap when there is nothing to do: one WAHA read per store.

import { require_ } from '../lib/env.js';
import { db } from '../lib/supabase.js';
import { ensureCallEvents } from '../lib/waha.js';

export async function ensurePetCallEvents(env) {
  const cfg = require_(env, 'supabaseUrl', 'serviceKey', 'wahaUrl');

  const on = await db(cfg).select('tenant_features', 'flag=eq.pet_listings&enabled=eq.true&select=tenant_id');
  if (!on.length) return null;
  const tenants = await db(cfg).select(
    'tenants',
    `id=in.(${on.map((r) => r.tenant_id).join(',')})&waha_session=not.is.null&select=id,slug,waha_session`
  );

  const out = { updated: 0, failed: 0 };
  for (const tenant of tenants) {
    try {
      if (await ensureCallEvents(cfg, tenant.waha_session)) out.updated += 1;
    } catch (err) {
      console.error('call events not added for', tenant.slug, err?.message ?? err);
      out.failed += 1;
    }
  }
  return out.updated || out.failed ? out : null;
}
