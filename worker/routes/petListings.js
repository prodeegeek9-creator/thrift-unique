// Telling a seller their pet is live.
//
// Every listing a store sends to its own site is remembered in pet_listings
// (migration 0051). Once a minute this asks the site which of those it has
// published, and each seller whose listing is live gets their link, a push to
// share it, and the link again in a message made to be forwarded.
//
// It asks rather than waiting to be told, so it does not matter how the store
// approved the listing (a tick in the admin, the edit form, the database), and
// nothing depends on the site being able to reach this Worker.

import { require_ } from '../lib/env.js';
import { db } from '../lib/supabase.js';
import { petLiveMessage, petShareMessage } from '../lib/petIntake.js';
import { say } from './waha.js';

const MAX_ATTEMPTS = 5;
// A listing nobody approved or deleted in this long is no longer waited on.
const STALE_DAYS = 60;
const TENANT_COLUMNS = 'id,slug,name,status,waha_session,waha_status,billing_status,whatsapp_number';

export async function notifyLivePets(env, { limit = 25 } = {}) {
  const cfg = require_(env, 'supabaseUrl', 'serviceKey');
  if (!cfg.petListingsUrl || !cfg.petListingsKey) return null;

  const stale = new Date(Date.now() - STALE_DAYS * 86_400_000).toISOString();
  await db(cfg).update('pet_listings', `status=eq.pending&created_at=lt.${stale}`, { status: 'expired' }, { returning: false });

  const rows = await db(cfg).select(
    'pet_listings',
    `status=eq.pending&select=id,tenant_id,slug,breed,listing_type,chat_id,attempts&order=created_at.asc&limit=${limit}`
  );
  if (!rows.length) return null;

  // Which of them are live? The site answers { live: [slug…], missing: [slug…] }.
  let answer;
  try {
    const res = await fetch(`${cfg.petListingsUrl}/status?slugs=${rows.map((r) => encodeURIComponent(r.slug)).join(',')}`, {
      headers: { Authorization: `Bearer ${cfg.petListingsKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error('pet listing status refused:', res.status, (await res.text().catch(() => '')).slice(0, 200));
      return null;
    }
    answer = await res.json();
  } catch (err) {
    console.error('pet listing status failed:', err?.message ?? err);
    return null;
  }
  const live = new Set(Array.isArray(answer?.live) ? answer.live : []);
  const missing = new Set(Array.isArray(answer?.missing) ? answer.missing : []);

  const origin = new URL(cfg.petListingsUrl).origin;
  const tenants = new Map();
  const out = { notified: 0, expired: 0, failed: 0 };

  for (const row of rows) {
    // Deleted on the site: nothing to tell anybody.
    if (missing.has(row.slug)) {
      await db(cfg).update('pet_listings', `id=eq.${row.id}&status=eq.pending`, { status: 'expired' }, { returning: false });
      out.expired += 1;
      continue;
    }
    if (!live.has(row.slug)) continue;

    // Claimed first, so a second sweep starting while this one is slow finds nothing to take.
    const claimed = await db(cfg).update('pet_listings', `id=eq.${row.id}&status=eq.pending`, { status: 'notifying' });
    if (!claimed?.length) continue;

    const retry = async (error) => {
      const attempts = row.attempts + 1;
      await db(cfg).update(
        'pet_listings',
        `id=eq.${row.id}`,
        { status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', attempts, error },
        { returning: false }
      );
      out.failed += 1;
    };

    try {
      if (!tenants.has(row.tenant_id)) {
        tenants.set(row.tenant_id, await db(cfg).one('tenants', `id=eq.${row.tenant_id}&select=${TENANT_COLUMNS}`));
      }
      const tenant = tenants.get(row.tenant_id);
      if (!tenant?.waha_session || tenant.status === 'suspended' || tenant.billing_status === 'paused') {
        await retry('The store cannot send WhatsApp messages right now');
        continue;
      }

      const url = `${origin}/pets/${encodeURIComponent(row.slug)}`;
      const own = { session: tenant.waha_session };
      const sent = await say(cfg, tenant, row.chat_id, petLiveMessage({ store: tenant.name, breed: row.breed ?? 'pet', listing_type: row.listing_type, url }), own);
      if (!sent) {
        // Nothing went, so trying again cannot send it twice.
        await retry('WhatsApp did not take the message');
        continue;
      }
      // The link again on its own, to forward as it is. The seller has been told; this is a bonus.
      await say(cfg, tenant, row.chat_id, petShareMessage({ breed: row.breed ?? 'Pet', listing_type: row.listing_type, url }), own).catch(() => {});

      await db(cfg).update(
        'pet_listings',
        `id=eq.${row.id}`,
        { status: 'notified', attempts: row.attempts + 1, notified_at: new Date().toISOString(), error: null },
        { returning: false }
      );
      out.notified += 1;
    } catch (err) {
      // Left in 'notifying': we cannot know whether it went, and telling a seller twice is worse than missing one.
      console.error('pet listing notice failed:', err?.message ?? err);
      out.failed += 1;
    }
  }
  return out;
}
