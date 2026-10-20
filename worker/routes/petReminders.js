// Reminding sellers who stopped at the photos (lib/petIntake.js, petReminderDue).
// Every fifth minute this looks for pet conversations waiting on photos, and
// sends each due one its reminder from the store's own number, once.
//
// Once, because it is a message to somebody who has not just written: the
// conversation is marked as reminded before anything is sent, and only if the
// seller has not written in the meantime (its updated_at is unchanged). A
// reminder that then fails to send is not tried again.

import { require_ } from '../lib/env.js';
import { db } from '../lib/supabase.js';
import { petReminderDue, petReminderMessage, REMIND_AFTER_HOURS, PHOTOS_WAIT_HOURS } from '../lib/petIntake.js';
import { say } from './waha.js';

const TENANT_COLUMNS = 'id,slug,name,status,waha_session,waha_status,billing_status,whatsapp_number';

export async function remindPetSellers(env, { now = new Date(), limit = 50 } = {}) {
  const cfg = require_(env, 'supabaseUrl', 'serviceKey');
  const t = now.getTime();
  const quietSince = new Date(t - REMIND_AFTER_HOURS * 3_600_000).toISOString();
  const keptSince = new Date(t - PHOTOS_WAIT_HOURS * 3_600_000).toISOString();

  const rows = await db(cfg).select(
    'bot_conversations',
    `state=eq.pet_photos&updated_at=lte.${encodeURIComponent(quietSince)}&updated_at=gte.${encodeURIComponent(keptSince)}` +
      `&select=tenant_id,chat_id,state,draft,updated_at,paused_until&order=updated_at.asc&limit=${limit}`
  );
  const due = rows.filter((r) => petReminderDue(r, t));
  if (!due.length) return null;

  const tenants = new Map();
  const out = { sent: 0, failed: 0, skipped: 0 };
  for (const row of due) {
    if (!tenants.has(row.tenant_id)) {
      const tenant = await db(cfg).one('tenants', `id=eq.${row.tenant_id}&select=${TENANT_COLUMNS}`);
      const on = tenant && (await db(cfg).one('tenant_features', `tenant_id=eq.${tenant.id}&flag=eq.pet_listings&select=enabled`));
      const ok = tenant && on?.enabled && tenant.waha_session && tenant.status !== 'suspended' && tenant.billing_status !== 'paused';
      tenants.set(row.tenant_id, ok ? tenant : null);
    }
    const tenant = tenants.get(row.tenant_id);
    if (!tenant) {
      out.skipped += 1;
      continue;
    }

    // Claimed first, and only if the seller has not written since it was read.
    const claimed = await db(cfg).update(
      'bot_conversations',
      `tenant_id=eq.${row.tenant_id}&chat_id=eq.${encodeURIComponent(row.chat_id)}&state=eq.pet_photos&updated_at=eq.${encodeURIComponent(row.updated_at)}`,
      { draft: { ...(row.draft ?? {}), remindedAt: now.toISOString() } }
    );
    if (!claimed?.length) {
      out.skipped += 1;
      continue;
    }

    try {
      const sent = await say(cfg, tenant, row.chat_id, petReminderMessage({ store: tenant.name, draft: row.draft ?? {} }), { session: tenant.waha_session });
      out[sent ? 'sent' : 'failed'] += 1;
    } catch (err) {
      console.error('pet reminder failed:', err?.message ?? err);
      out.failed += 1;
    }
  }
  return out;
}
