// Inviting people who asked a pet store about selling a pet before its bot was
// answering. Rows in pet_invites (migration 0050) are put there by the
// platform; this sweep, once a minute, sends each the bot's opening message
// from the store's own number, once.
//
// Once, because these are messages to somebody who has not just written: a
// row is claimed before anything is sent, and a claim that never finishes is
// left alone rather than sent again.

import { require_ } from '../lib/env.js';
import { db } from '../lib/supabase.js';
import { chatId } from '../lib/waha.js';
import { petInviteMessage } from '../lib/petIntake.js';
import { say } from './waha.js';

const MAX_ATTEMPTS = 3;
const TENANT_COLUMNS = 'id,slug,name,status,waha_session,waha_status,billing_status,whatsapp_number';

export async function sendPetInvites(env, { limit = 10 } = {}) {
  const cfg = require_(env, 'supabaseUrl', 'serviceKey');

  const pending = await db(cfg).select(
    'pet_invites',
    `status=eq.pending&attempts=lt.${MAX_ATTEMPTS}&select=id,tenant_id,phone,attempts&order=created_at.asc&limit=${limit}`
  );
  if (!pending.length) return null;

  const out = { sent: 0, failed: 0, skipped: 0 };
  for (const invite of pending) {
    // Claimed first: a second sweep starting while this one is slow finds nothing to take.
    const claimed = await db(cfg).update('pet_invites', `id=eq.${invite.id}&status=eq.pending`, { status: 'sending' });
    if (!claimed?.length) {
      out.skipped += 1;
      continue;
    }

    const fail = async (error, final = true) => {
      const attempts = invite.attempts + 1;
      await db(cfg).update(
        'pet_invites',
        `id=eq.${invite.id}`,
        { status: final || attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', attempts, error },
        { returning: false }
      );
      out.failed += 1;
    };

    try {
      const tenant = await db(cfg).one('tenants', `id=eq.${invite.tenant_id}&select=${TENANT_COLUMNS}`);
      const on = tenant && (await db(cfg).one('tenant_features', `tenant_id=eq.${tenant.id}&flag=eq.pet_listings&select=enabled`));
      if (!tenant || !on?.enabled || !tenant.waha_session || tenant.status === 'suspended' || tenant.billing_status === 'paused') {
        await fail('The store is not set up to take pet listings over WhatsApp');
        continue;
      }

      const browseUrl = cfg.petListingsUrl ? `${new URL(cfg.petListingsUrl).origin}/pets.html` : null;
      const sent = await say(cfg, tenant, chatId(invite.phone), petInviteMessage({ store: tenant.name, browseUrl }), {
        session: tenant.waha_session,
      });
      if (!sent) {
        // WhatsApp refused it; say() has not sent anything, so trying again cannot double-send.
        await fail('WhatsApp did not take the message', false);
        continue;
      }

      await db(cfg).update(
        'pet_invites',
        `id=eq.${invite.id}`,
        { status: 'sent', attempts: invite.attempts + 1, sent_at: new Date().toISOString(), error: null },
        { returning: false }
      );
      out.sent += 1;
    } catch (err) {
      console.error('pet invite failed:', err?.message ?? err);
      // Left in 'sending': we cannot know whether it went, and a second message to somebody who never asked is worse than a missed one.
      out.failed += 1;
    }
  }
  return out;
}
