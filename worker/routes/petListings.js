// Telling a seller their pet is live.
//
// Every listing a store sends to its own site is remembered in pet_listings
// (migration 0051). Once a minute this asks the site which of those it has
// published, and each seller whose listing is live gets their link, the
// store's social pages, a push to share it, and the link again in a message
// made to be forwarded. Before that the pet is posted to the store's Facebook
// page and Instagram (PET_SOCIAL_URL, an n8n workflow), and those posts are
// the links the seller gets for those two.
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
// Posting to Facebook and Instagram takes n8n a few seconds, Instagram longer.
const SOCIAL_TIMEOUT_MS = 60_000;

const httpsUrl = (v) => (typeof v === 'string' && /^https:\/\/\S+$/.test(v.trim()) ? v.trim() : null);

// The store's pages as the site lists them ({ socials: [{ name, url }] }).
function socialPages(list) {
  return (Array.isArray(list) ? list : [])
    .map((s) => ({ name: typeof s?.name === 'string' ? s.name.trim().slice(0, 40) : '', url: httpsUrl(s?.url) }))
    .filter((s) => s.name && s.url);
}

// Has the pet posted to the store's Facebook and Instagram, and answers with
// the posts' links by network ({ Facebook, Instagram }), or {} when it is not
// set up or did not answer: the seller then gets the pages instead. n8n posts
// each pet once, so asking again after a WhatsApp retry gets the same posts.
async function postToSocials(cfg, slug) {
  if (!cfg.petSocialUrl) return {};
  try {
    const res = await fetch(cfg.petSocialUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug }),
      signal: AbortSignal.timeout(SOCIAL_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error('pet social post refused:', res.status, (await res.text().catch(() => '')).slice(0, 200));
      return {};
    }
    const b = await res.json();
    return { Facebook: httpsUrl(b?.facebook_url), Instagram: httpsUrl(b?.instagram_url) };
  } catch (err) {
    console.error('pet social post failed:', err?.message ?? err);
    return {};
  }
}

// Each page, with the pet's own post on it in its place when there is one.
function withPosts(pages, posts) {
  const out = pages.map((s) => (posts[s.name] ? { name: s.name, url: posts[s.name], posted: true } : s));
  for (const [name, url] of Object.entries(posts)) {
    if (url && !out.some((s) => s.name === name)) out.push({ name, url, posted: true });
  }
  return out;
}

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
  const pages = socialPages(answer?.socials);

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
      const socials = withPosts(pages, await postToSocials(cfg, row.slug));
      const sent = await say(cfg, tenant, row.chat_id, petLiveMessage({ store: tenant.name, breed: row.breed ?? 'pet', listing_type: row.listing_type, url, socials }), own);
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
