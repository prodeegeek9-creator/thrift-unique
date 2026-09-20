// PostgREST, under the service key.
//
// The service key bypasses RLS entirely, which is the whole reason these
// routes exist — escrow release and commission have to write rows no client
// is allowed to write. It also means Postgres has stopped checking tenant
// scope, so every call here passes it explicitly and the caller is responsible
// for having established it -- see how worker/lib/orders.js names tenant_id in
// every filter, including the ones where the id alone would already be unique.

export class SupabaseError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function headers(cfg, extra = {}) {
  return {
    apikey: cfg.serviceKey,
    Authorization: `Bearer ${cfg.serviceKey}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function call(cfg, path, init) {
  const res = await fetch(`${cfg.supabaseUrl}/rest/v1/${path}`, init);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new SupabaseError(`PostgREST ${res.status} on ${path}`, res.status, body);
  }

  // Prefer: return=minimal and DELETE both answer 204.
  if (res.status === 204) return null;
  return res.json();
}

export function db(cfg) {
  return {
    async select(table, query) {
      return call(cfg, `${table}?${query}`, { headers: headers(cfg) });
    },

    // maybeSingle semantics: one row or null, never a throw for "no match".
    async one(table, query) {
      const rows = await call(cfg, `${table}?${query}&limit=1`, { headers: headers(cfg) });
      return rows?.[0] ?? null;
    },

    async insert(table, row, { returning = true, onConflict } = {}) {
      const prefer = returning ? 'return=representation' : 'return=minimal';
      const q = onConflict ? `?on_conflict=${onConflict}` : '';
      const rows = await call(cfg, `${table}${q}`, {
        method: 'POST',
        headers: headers(cfg, {
          Prefer: onConflict ? `resolution=ignore-duplicates,${prefer}` : prefer,
        }),
        body: JSON.stringify(row),
      });
      return Array.isArray(rows) ? rows[0] ?? null : rows;
    },

    async update(table, query, patch, { returning = true } = {}) {
      const rows = await call(cfg, `${table}?${query}`, {
        method: 'PATCH',
        headers: headers(cfg, {
          Prefer: returning ? 'return=representation' : 'return=minimal',
        }),
        body: JSON.stringify(patch),
      });
      return Array.isArray(rows) ? rows : [];
    },

    async rpc(fn, args) {
      return call(cfg, `rpc/${fn}`, {
        method: 'POST',
        headers: headers(cfg),
        body: JSON.stringify(args ?? {}),
      });
    },
  };
}
