// Sending again the pet listings that never reached the store's site.
//
// Rows in pet_resends (migration 0053) are put there by the platform: a listing
// the seller confirmed, whose photos are already in our bucket, that failed for
// a reason that was not theirs (the site's storage refusing photos). This sweep,
// once a minute, sends each through forwardPetListing, the path a listing takes
// live: to the site for approval, recorded in pet_listings so the seller is told
// when it goes live, and the seller and the store owner told now.
//
// Once, because these are messages to sellers: a row is claimed before anything
// is sent, a failure is left 'failed' for somebody to look at (the owner has
// been told why by forwardPetListing), and a claim that never finishes is left
// alone rather than sent again.

import { require_ } from '../lib/env.js';
import { db } from '../lib/supabase.js';
import { petResendNotice } from '../lib/petIntake.js';
import { forwardPetListing } from './waha.js';

const TENANT_COLUMNS = 'id,slug,name,status,waha_session,waha_status,billing_status,whatsapp_number';

export async function sendPetResends(env, { limit = 3 } = {}) {
  const cfg = require_(env, 'supabaseUrl', 'serviceKey');
  if (!cfg.petListingsUrl || !cfg.petListingsKey) return null;

  const pending = await db(cfg).select(
    'pet_resends',
    `status=eq.pending&select=id,tenant_id,chat_id,listing,photo_paths&order=created_at.asc&limit=${limit}`
  );
  if (!pending.length) return null;

  const out = { sent: 0, failed: 0, waiting: 0 };
  for (const row of pending) {
    // Claimed first: a second sweep starting while this one is slow finds nothing to take.
    const claimed = await db(cfg).update('pet_resends', `id=eq.${row.id}&status=eq.pending`, { status: 'sending' });
    if (!claimed?.length) continue;

    try {
      const tenant = await db(cfg).one('tenants', `id=eq.${row.tenant_id}&select=${TENANT_COLUMNS}`);
      if (!tenant?.waha_session || tenant.waha_status !== 'WORKING' || tenant.status === 'suspended' || tenant.billing_status === 'paused') {
        // Not the row's fault: back in the queue for when the store's WhatsApp is linked again.
        await db(cfg).update('pet_resends', `id=eq.${row.id}`, { status: 'pending' }, { returning: false });
        out.waiting += 1;
        continue;
      }

      const sent = await forwardPetListing(
        cfg,
        tenant,
        { session: tenant.waha_session, from: row.chat_id },
        {
          listing: row.listing,
          images: row.photo_paths.map((stored) => ({ stored })),
          draft: null,
          verified: false,
          checkNote: 'sent again after the site refused photos, so look at them',
          sentPrefix: petResendNotice(row.listing.breed),
        }
      );
      await db(cfg).update(
        'pet_resends',
        `id=eq.${row.id}`,
        sent ? { status: 'sent', sent_at: new Date().toISOString(), error: null } : { status: 'failed', error: 'The site did not take it; the store owner was told why' },
        { returning: false }
      );
      out[sent ? 'sent' : 'failed'] += 1;
    } catch (err) {
      console.error('pet resend failed:', err?.message ?? err);
      // Left in 'sending': we cannot know whether the seller was told.
      out.failed += 1;
    }
  }
  return out;
}
