import { db } from '../lib/supabase.js';
import { json } from '../lib/http.js';

// The console's two logs: what the photo-review AI was asked and answered,
// with its token counts (ai_usage, 0042/0048), and the bot's WhatsApp chats
// (bot_messages, 0010/0048). Read-only, operator-only — handleAdmin() checks
// that before routing here.
//
// Both are kept out of every signed-in user's reach at the database; a chat
// log is about as private as anything stored. The console reads them for
// support: "what did the bot say to this seller", "why was this photo turned
// down".

const UUID = /^[0-9a-f-]{36}$/i;
const MAX_CHAT_ID = 120;

function params(url) {
  const tenant = url.searchParams.get('tenant');
  const before = url.searchParams.get('before');
  return {
    tenant: tenant && UUID.test(tenant) ? tenant : null,
    before: before && !Number.isNaN(Date.parse(before)) ? new Date(before).toISOString() : null,
  };
}

const where = (...parts) => parts.filter(Boolean).join('&');

// ── AI ───────────────────────────────────────────────────────────────────────

const AI_PAGE = 30;

export async function aiLog(cfg, url) {
  const { tenant, before } = params(url);

  const [totals, calls, tenants] = await Promise.all([
    db(cfg).rpc('ai_usage_totals', { p_tenant_id: tenant }),
    db(cfg).select(
      'ai_usage',
      where(
        tenant && `tenant_id=eq.${tenant}`,
        before && `created_at=lt.${encodeURIComponent(before)}`,
        'select=id,tenant_id,draft_id,purpose,model,images,input_tokens,cached_tokens,output_tokens,cost_usd,prompt,response,created_at',
        `order=created_at.desc&limit=${AI_PAGE}`
      )
    ),
    db(cfg).select('tenants', 'select=id,name&order=name.asc'),
  ]);

  const draftIds = [...new Set((calls ?? []).map((c) => c.draft_id).filter(Boolean))];
  const drafts = draftIds.length
    ? await db(cfg).select('listing_drafts', `id=in.(${draftIds.join(',')})&select=id,category,status,extracted`)
    : [];
  const draftById = new Map((drafts ?? []).map((d) => [d.id, d]));
  const nameById = new Map((tenants ?? []).map((t) => [t.id, t.name]));

  return json({
    totals: totals ?? [],
    tenants: tenants ?? [],
    calls: (calls ?? []).map((c) => {
      const d = c.draft_id ? draftById.get(c.draft_id) : null;
      return {
        ...c,
        store: nameById.get(c.tenant_id) ?? null,
        item: d ? { title: d.extracted?.title ?? null, category: d.category, status: d.status } : null,
      };
    }),
    next: calls?.length === AI_PAGE ? calls.at(-1).created_at : null,
  });
}

// ── BOT ──────────────────────────────────────────────────────────────────────

// Recent chats are worked out from the latest messages rather than a query
// per chat: a page of the newest few hundred, grouped. A chat quiet for longer
// than that page reaches back is found by picking its store.
const CHAT_SCAN = 500;
const CHATS_SHOWN = 60;
const THREAD_PAGE = 100;

export async function botLog(cfg, url) {
  const { tenant, before } = params(url);
  const chat = url.searchParams.get('chat');

  const tenants = await db(cfg).select('tenants', 'select=id,name,whatsapp_number&order=name.asc');
  const tenantById = new Map((tenants ?? []).map((t) => [t.id, t]));
  const storeList = (tenants ?? []).map(({ id, name }) => ({ id, name }));

  if (chat) {
    if (!tenant || chat.length > MAX_CHAT_ID) return json({ error: 'Pick a store and a chat' }, 400);
    const rows = await db(cfg).select(
      'bot_messages',
      where(
        `tenant_id=eq.${tenant}&chat_id=eq.${encodeURIComponent(chat)}`,
        before && `created_at=lt.${encodeURIComponent(before)}`,
        'select=id,direction,body,has_media,source,created_at',
        `order=created_at.desc&limit=${THREAD_PAGE}`
      )
    );
    const names = await sellerNames(cfg, tenant, [chat]);
    return json({
      tenants: storeList,
      chat: {
        tenant_id: tenant,
        store: tenantById.get(tenant)?.name ?? null,
        chat_id: chat,
        who: whoIs(tenantById.get(tenant), chat, names),
      },
      // Oldest first, as a chat reads.
      messages: [...(rows ?? [])].reverse(),
      next: rows?.length === THREAD_PAGE ? rows.at(-1).created_at : null,
    });
  }

  const rows = await db(cfg).select(
    'bot_messages',
    where(
      tenant && `tenant_id=eq.${tenant}`,
      'select=tenant_id,chat_id,direction,body,has_media,source,created_at',
      `order=created_at.desc&limit=${CHAT_SCAN}`
    )
  );

  const chats = new Map();
  for (const m of rows ?? []) {
    const key = `${m.tenant_id}|${m.chat_id}`;
    const c = chats.get(key);
    if (c) {
      c.messages += 1;
      continue;
    }
    chats.set(key, {
      tenant_id: m.tenant_id,
      chat_id: m.chat_id,
      store: tenantById.get(m.tenant_id)?.name ?? null,
      last: { direction: m.direction, body: m.body, has_media: m.has_media, source: m.source },
      last_at: m.created_at,
      messages: 1,
    });
  }

  const shown = [...chats.values()].slice(0, CHATS_SHOWN);
  const byTenant = new Map();
  for (const c of shown) byTenant.set(c.tenant_id, [...(byTenant.get(c.tenant_id) ?? []), c.chat_id]);
  const named = new Map();
  for (const [t, ids] of byTenant) named.set(t, await sellerNames(cfg, t, ids));

  return json({
    tenants: storeList,
    chats: shown.map((c) => ({ ...c, who: whoIs(tenantById.get(c.tenant_id), c.chat_id, named.get(c.tenant_id)) })),
  });
}

// A name for a chat id, which on its own names nobody (WhatsApp's @lid ids
// are opaque): the store's owner, or the name a seller gave with an item.
async function sellerNames(cfg, tenantId, chatIds) {
  if (!chatIds.length) return new Map();
  const list = chatIds.map((c) => `"${c.replace(/"/g, '')}"`).join(',');
  const rows = await db(cfg).select(
    'submissions',
    `tenant_id=eq.${tenantId}&seller_chat_id=in.(${encodeURIComponent(list)})` +
      '&seller_name=not.is.null&select=seller_chat_id,seller_name&order=created_at.desc'
  );
  const names = new Map();
  for (const r of rows ?? []) if (!names.has(r.seller_chat_id)) names.set(r.seller_chat_id, r.seller_name);
  return names;
}

function whoIs(tenant, chatId, names) {
  const digits = String(chatId).split('@')[0];
  if (tenant?.whatsapp_number && digits === String(tenant.whatsapp_number)) return 'Store owner';
  return names?.get(chatId) ?? null;
}
