// A PostgREST stand-in, just wide enough for the queries the Worker makes.
//
// Not a general Postgres: it understands `col=eq.value` filters, `select=`,
// `limit=` and `order=`, because that is the whole surface worker/lib/supabase.js
// uses. Anything broader would be a second database to keep correct.
//
// The point is to exercise the real handlers — signature checks, idempotency,
// the payout write — against something that behaves like the live one for the
// cases that matter, without a network.

export const SUPABASE_URL = 'https://test.supabase.co';
export const SERVICE_KEY = 'service-key-for-tests';

// `rpcs` answers named functions: { public_store: (args, tables) => value }.
// Any other function answers [], as a set-returning function with no rows.
export function makeFakeSupabase(seed = {}, { rpcs = {} } = {}) {
  const tables = {
    tenants: [],
    tenant_features: [],
    products: [],
    buyers: [],
    orders: [],
    payouts: [],
    payout_items: [],
    bot_conversations: [],
    bot_messages: [],
    whatsapp_secrets: [],
    signups: [],
    tenant_members: [],
    submissions: [],
    listing_channel_posts: [],
    webhook_activity: [],
    payout_accounts: [],
    plan_invoices: [],
    billing_cards: [],
    refunds: [],
    nudge_events: [],
    disputes: [],
    operator_audit: [],
    ...structuredClone(seed),
  };

  // Unique constraints the schema actually declares, so a test can prove a
  // replay collides rather than silently inserting twice.
  const unique = {
    orders: 'payment_ref',
    payouts: 'reference',
    // What makes a retried WAHA webhook a no-op instead of a second listing.
    bot_messages: 'external_id',
    signups: 'phone',
    webhook_activity: 'session',
    // Composite: one row per store and flag.
    tenant_features: ['tenant_id', 'flag'],
    buyers: ['tenant_id', 'phone'],
    payout_accounts: 'tenant_id',
    billing_cards: 'tenant_id',
    plan_invoices: ['tenant_id', 'period_start'],
    refunds: 'order_id',
  };

  // Unique columns an UPDATE can collide on, answered with PostgREST's 409.
  const uniqueOnUpdate = { tenants: 'whatsapp_number' };

  const keyOf = (row, key) =>
    Array.isArray(key) ? key.map((k) => String(row[k])).join('|') : row[key];
  const hasKey = (row, key) =>
    Array.isArray(key) ? key.every((k) => row[k] != null) : row[key] != null;

  let nextId = 1;
  const calls = [];

  function parse(qs) {
    const p = new URLSearchParams(qs);
    const filters = [];
    let select = null;
    let limit = null;

    for (const [k, v] of p) {
      if (k === 'select') select = v;
      else if (k === 'limit') limit = Number(v);
      else if (k === 'order' || k === 'on_conflict') continue;
      else {
        const m = /^(eq|neq|lt|gt|lte|gte|in|not\.is|is)\.(.*)$/s.exec(v);
        if (m) filters.push({ col: k, op: m[1], val: m[2] });
      }
    }
    return { filters, select, limit };
  }

  function matches(row, filters) {
    return filters.every((f) => {
      const cell = row[f.col];
      if (f.op === 'eq') return String(cell) === f.val;
      if (f.op === 'neq') return String(cell) !== f.val;
      if (f.op === 'lt') return new Date(cell) < new Date(f.val);
      if (f.op === 'gt') return new Date(cell) > new Date(f.val);
      if (f.op === 'lte') return new Date(cell) <= new Date(f.val);
      if (f.op === 'gte') return new Date(cell) >= new Date(f.val);
      if (f.op === 'is') return f.val === 'null' ? cell == null : String(cell) === f.val;
      if (f.op === 'not.is') return f.val === 'null' ? cell != null : String(cell) !== f.val;
      if (f.op === 'in') return f.val.replace(/[()]/g, '').split(',').includes(String(cell));
      return false;
    });
  }

  async function handler(url, init = {}) {
    const u = new URL(url);
    const [, , , table] = u.pathname.split('/'); // /rest/v1/<table>
    const method = init.method ?? 'GET';
    const { filters, limit } = parse(u.search.slice(1));

    calls.push({
      table,
      method,
      search: u.search,
      ...(table === 'rpc' ? { rpc: u.pathname.split('/')[4], args: JSON.parse(init.body ?? '{}') } : {}),
    });

    if (!(table in tables) && !u.pathname.includes('/rpc/')) {
      return new Response(`no such table ${table}`, { status: 404 });
    }

    if (u.pathname.includes('/rpc/')) {
      const fn = rpcs[u.pathname.split('/')[4]];
      const out = fn ? fn(JSON.parse(init.body ?? '{}'), tables) : [];
      return new Response(JSON.stringify(out ?? null), { status: 200 });
    }

    if (method === 'GET') {
      let rows = tables[table].filter((r) => matches(r, filters));
      if (limit) rows = rows.slice(0, limit);
      return new Response(JSON.stringify(rows), { status: 200 });
    }

    // Answered the way PostgREST answers, including what it leaves out: with
    // Prefer: return=minimal an INSERT is 201 with an empty body and a PATCH
    // is 204. A fake that always sent JSON let a parser that choked on the
    // empty 201 through every test.
    const minimal = /return=minimal/.test(init.headers?.Prefer ?? '');

    if (method === 'POST') {
      const body = JSON.parse(init.body);
      const key = unique[table];

      // resolution=merge-duplicates: the clashing row takes the new values.
      if (key && hasKey(body, key) && /merge-duplicates/.test(init.headers?.Prefer ?? '')) {
        const existing = tables[table].find((r) => keyOf(r, key) === keyOf(body, key));
        if (existing) {
          Object.assign(existing, body);
          return new Response(minimal ? null : JSON.stringify([existing]), { status: 201 });
        }
      }

      if (key && hasKey(body, key) && tables[table].some((r) => keyOf(r, key) === keyOf(body, key))) {
        // resolution=ignore-duplicates inserts nothing: [] with
        // return=representation, which worker/lib/supabase.js turns into
        // null — what the payout path treats as "already done".
        return new Response(minimal ? null : JSON.stringify([]), { status: 201 });
      }

      // created_at defaults to now() on the real tables; queries filter on it.
      const row = { id: `row-${nextId++}`, created_at: new Date().toISOString(), ...body };
      // products.public_code has a column default in the real schema; the
      // storefront link and the bot's confirmation both read it back.
      if (table === 'products' && !row.public_code) row.public_code = `PC${nextId}`;
      tables[table].push(row);
      return new Response(minimal ? null : JSON.stringify([row]), { status: 201 });
    }

    if (method === 'PATCH') {
      const patch = JSON.parse(init.body);
      const hit = tables[table].filter((r) => matches(r, filters));
      const col = uniqueOnUpdate[table];
      if (col && patch[col] != null && tables[table].some((r) => !hit.includes(r) && r[col] === patch[col])) {
        return new Response(JSON.stringify({ code: '23505' }), { status: 409 });
      }
      for (const r of hit) Object.assign(r, patch);
      return minimal
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify(hit), { status: 200 });
    }

    if (method === 'DELETE') {
      tables[table] = tables[table].filter((r) => !matches(r, filters));
      return new Response(null, { status: 204 });
    }

    return new Response('unsupported', { status: 405 });
  }

  return { tables, calls, uploads: [], handler };
}

// Installs a global fetch that routes Supabase and Paystack to fakes and
// refuses anything else, so a test cannot silently reach the network.
//
// `tokens` maps a bearer token to the user Supabase would resolve it to.
// Anything not in the map gets a 401, which is how requireOperator learns a
// token is forged — it never parses one itself.
export function installFetch({
  supabase,
  paystackAmountKobo = null,
  paystackStatus = 'success',
  paystackFeesKobo = 0,
  tokens = {},
  waha = null,
  // Any other Paystack call (initialize, transfers): (url, init) => Response.
  paystack = null,
}) {
  const real = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    // fetch() takes a string, a URL or a Request, and real code uses all
    // three. Reading `.url` alone silently yields undefined for a URL object,
    // which makes every route below fall through to "tried to reach the
    // network" — a confusing way to find out you built a URL properly.
    const url = requestUrl(input);

    // Supabase Storage, which is a different origin path from PostgREST and
    // takes raw bytes rather than JSON.
    if (url.startsWith(`${SUPABASE_URL}/storage/v1/object/`)) {
      const path = url.slice(`${SUPABASE_URL}/storage/v1/object/`.length);
      supabase.uploads.push({ path, contentType: init?.headers?.['Content-Type'] ?? null });
      return new Response(JSON.stringify({ Key: path }), { status: 200 });
    }

    if (waha && url.startsWith(waha.url)) return waha.handler(url, init);

    if (url === `${SUPABASE_URL}/auth/v1/user`) {
      const auth = init?.headers?.Authorization ?? '';
      const user = tokens[auth.replace(/^Bearer /, '')];
      return user
        ? new Response(JSON.stringify(user), { status: 200 })
        : new Response(JSON.stringify({ msg: 'invalid token' }), { status: 401 });
    }

    if (url.startsWith(SUPABASE_URL)) return supabase.handler(url, init);

    if (url.startsWith('https://api.paystack.co/transaction/verify/')) {
      if (paystackAmountKobo == null) return new Response('nope', { status: 404 });
      return new Response(
        JSON.stringify({ status: true, data: { amount: paystackAmountKobo, fees: paystackFeesKobo, status: paystackStatus } }),
        { status: 200 }
      );
    }

    if (paystack && url.startsWith('https://api.paystack.co/')) return paystack(url, init);

    throw new Error(`test tried to reach the network: ${url}`);
  };

  return () => {
    globalThis.fetch = real;
  };
}

export function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input?.url ?? String(input);
}

export function env(extra = {}) {
  return {
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY: SERVICE_KEY,
    TOKEN_SECRET: 'token-secret-for-tests',
    PAYSTACK_SECRET_KEY: 'sk_test_secret',
    // Behaves like Cloudflare's asset layer where it matters: /index.html is
    // redirected to / with no body (html_handling), and a request carrying
    // If-None-Match gets a bodiless 304. Serving either as the page is blank.
    ASSETS: {
      fetch: async (req) => {
        const r = req instanceof Request ? req : new Request(req);
        if (new URL(r.url).pathname === '/index.html') {
          return new Response(null, { status: 307, headers: { location: '/' } });
        }
        if (r.headers.get('if-none-match')) return new Response(null, { status: 304 });
        return new Response(
          '<!DOCTYPE html><html><head><meta name="robots" content="noindex"><title>Vendwyze</title></head><body><div id="root"></div><script type="module" src="/assets/index.js"></script></body></html>',
          { status: 200, headers: { 'content-type': 'text/html' } }
        );
      },
    },
    ...extra,
  };
}
