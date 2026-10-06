import { config } from '../lib/env.js';
import { db } from '../lib/supabase.js';
import { storeBytes, MediaError } from '../lib/media.js';
import { phoneFor } from '../lib/waha.js';
import { announceSubmission } from './waha.js';

// Items whose photos have all passed review, filed for their store.
//
// The photo-review worker (on its own server) labels each photo; the triggers
// in 0038 flip a draft to 'ready' the moment every required shot has passed.
// Nothing tells the Worker that happened, so this runs every minute and
// looks. A minute is the longest a seller waits between "all your photos look
// good" and "sent to the store".
//
// Each ready draft becomes a submissions row exactly as lib/intake.js would
// have filed it, so the review queue, approval, consignor bank details and
// payouts all carry on unchanged. The draft is marked 'published': handed to
// the store.

const PRIVATE_BUCKET = 'listing-photos';

// The review screen and the product page show these; past a handful, more
// angles are clutter.
const MAX_SUBMISSION_IMAGES = 8;

// What the AI noticed about the item (listing_drafts.ai_item, migration 0044),
// as the store's review queue shows it. A note for the owner to weigh, never
// a verdict: the item still reaches the queue.
const ISSUE_TEXT = {
  dirty: 'looks dirty',
  stained: 'has stains',
  damaged: 'looks damaged',
  worn: 'looks worn',
  missing_parts: 'may be missing parts',
};

export function aiReadFor(draft, { askedFlaws = false } = {}) {
  const ai = draft?.ai_item;
  if (!ai || typeof ai !== 'object') return { ai_issues: [], ai_note: null };

  const issues = [...new Set(Array.isArray(ai.issues) ? ai.issues : [])].filter((i) => ISSUE_TEXT[i]);
  const parts = [];
  if (issues.length) {
    const said = issues.map((i) => ISSUE_TEXT[i]);
    parts.push(`It ${said.length > 1 ? `${said.slice(0, -1).join(', ')} and ${said.at(-1)}` : said[0]}.`);
  }
  // Dirt washes off; the rest is what "any flaws?" was asking about.
  if (askedFlaws && !(draft.flags ?? []).includes('has_flaws') && issues.some((i) => i !== 'dirty')) {
    parts.push('The seller said it has no flaws.');
  }
  const looksLike = String(ai.description ?? '').trim().slice(0, 120);
  if (ai.fits_category === false && looksLike) {
    parts.push(`It may be in the wrong category: it looks like ${looksLike}.`);
  }

  const note = parts.join(' ').slice(0, 500);
  return { ai_issues: issues, ai_note: note || null };
}

export async function finalizeDrafts(env, { limit = 20 } = {}) {
  const cfg = config(env);
  if (!cfg.supabaseUrl || !cfg.serviceKey) return null;

  // Drafts still waiting on photos past their expiry. The function exists in
  // 0038; until now nothing called it.
  let expired = 0;
  try {
    expired = Number(await db(cfg).rpc('expire_stale_listing_drafts', {})) || 0;
  } catch (err) {
    console.warn('draft expiry failed:', err?.message ?? err);
  }

  // Only drafts the WhatsApp intake made (lib/photoIntake.js tags them).
  const ready = await db(cfg).select(
    'listing_drafts',
    'status=eq.ready&extracted->>source=eq.sell' +
      `&select=id,tenant_id,seller_chat_id,category,flags,extracted,ai_item&order=updated_at.asc&limit=${limit}`
  );

  let filed = 0;
  let failed = 0;

  for (const draft of ready ?? []) {
    // The claim. 'ready' → 'published' only matches once, so two runs that
    // overlap cannot both file the same item.
    const claimed = await db(cfg).update(
      'listing_drafts',
      `id=eq.${draft.id}&tenant_id=eq.${draft.tenant_id}&status=eq.ready`,
      { status: 'published', published_at: new Date().toISOString() }
    );
    if (!claimed.length) continue;

    let outcome;
    try {
      outcome = await file(cfg, draft);
    } catch (err) {
      console.error('filing draft failed:', draft.id, err?.message ?? err);
      outcome = 'retry';
      failed += 1;
    }

    if (outcome === 'filed') filed += 1;

    // Back in the queue for the next minute: a storage hiccup, or a store
    // that is paused or suspended right now.
    if (outcome === 'retry' || outcome === 'later') {
      await db(cfg)
        .update(
          'listing_drafts',
          `id=eq.${draft.id}&tenant_id=eq.${draft.tenant_id}&status=eq.published`,
          { status: 'ready', published_at: null },
          { returning: false }
        )
        .catch((err) => console.error('draft requeue failed:', draft.id, err?.message ?? err));
    }
  }

  return { expired, checked: ready?.length ?? 0, filed, failed };
}

// 'filed', 'done' (an earlier run already filed it), or 'later'. Throws for
// anything worth retrying.
async function file(cfg, draft) {
  const tenant = await db(cfg).one(
    'tenants',
    `id=eq.${draft.tenant_id}&select=id,name,status,store_type,whatsapp_number,waha_session,billing_status`
  );
  // Not taking items right now; the draft waits rather than vanishing.
  if (!tenant || tenant.status === 'suspended' || tenant.billing_status === 'paused') return 'later';

  const item = draft.extracted ?? {};

  const [photos, rules] = await Promise.all([
    db(cfg).select(
      'listing_photos',
      `draft_id=eq.${draft.id}&tenant_id=eq.${draft.tenant_id}&status=eq.passed` +
        '&select=id,storage_path,shot_type,created_at&order=created_at.asc'
    ),
    db(cfg).select(
      'photo_shot_rules',
      `category=eq.${encodeURIComponent(draft.category)}&select=shot_type,sort_order,condition_flag`
    ),
  ]);

  // The main shot first, then the rest in the order the rules list them, so
  // the product's first image is the one a buyer should see first.
  const rank = Object.fromEntries((rules ?? []).map((r) => [r.shot_type, r.sort_order ?? 0]));
  const ordered = [...(photos ?? [])]
    .sort((a, b) => (rank[a.shot_type] ?? 999) - (rank[b.shot_type] ?? 999))
    .slice(0, MAX_SUBMISSION_IMAGES);
  if (!ordered.length) throw new Error('ready draft has no passed photos');

  const images = [];
  for (const photo of ordered) images.push(await copyToPublic(cfg, draft.tenant_id, photo.storage_path));

  // The number behind the chat, when WhatsApp will say; only for the store to
  // call back on.
  const phone = await phoneFor(cfg, tenant.waha_session, draft.seller_chat_id).catch(() => null);

  // draft_id is unique on submissions: a second run collides and inserts
  // nothing, rather than filing the item twice.
  const submission = await db(cfg).insert(
    'submissions',
    {
      tenant_id: tenant.id,
      seller_chat_id: draft.seller_chat_id,
      seller_phone: phone,
      seller_name: item.seller_name ?? null,
      title: item.title,
      asking_price: item.asking_price,
      condition: item.condition,
      images,
      draft_id: draft.id,
      ...aiReadFor(draft, { askedFlaws: (rules ?? []).some((r) => r.condition_flag === 'has_flaws') }),
    },
    { onConflict: 'draft_id' }
  );
  if (!submission) return 'done';

  const asked = await announceSubmission(cfg, tenant, draft.seller_chat_id, submission);

  // The chat was waiting on these photos and isn't any more — unless the bank
  // question has just taken it over.
  if (!asked) {
    await db(cfg).update(
      'bot_conversations',
      `tenant_id=eq.${tenant.id}&chat_id=eq.${encodeURIComponent(draft.seller_chat_id)}&state=eq.pi_photos`,
      { state: 'idle', draft: {} },
      { returning: false }
    );
  }

  return 'filed';
}

// From the private bucket, where photos wait while they are checked, to the
// public one every listing image lives in.
async function copyToPublic(cfg, tenantId, path) {
  const res = await fetch(`${cfg.supabaseUrl}/storage/v1/object/${PRIVATE_BUCKET}/${path}`, {
    headers: { apikey: cfg.serviceKey, Authorization: `Bearer ${cfg.serviceKey}` },
  });
  if (!res.ok) throw new MediaError(`Could not read ${path}: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const type = res.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
  return storeBytes(cfg, tenantId, bytes, type);
}
