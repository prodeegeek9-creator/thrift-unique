// Cloudflare Worker — Admin API proxy
// Secrets (never stored in code) — set with wrangler:
//   wrangler secret put SUPABASE_URL
//   wrangler secret put SUPABASE_SERVICE_KEY
//   wrangler secret put OWNER_EMAIL
//   wrangler secret put OWNER_PASSWORD
//   wrangler secret put TOKEN_SECRET   ← any long random string

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/admin/')) {
      return handleAdmin(request, env, pathname.slice('/api/admin/'.length));
    }
    return env.ASSETS.fetch(request);
  }
};

// ── TOKEN ─────────────────────────────────────────────────────────────────────

async function generateToken(env) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(env.TOKEN_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode('admin:' + env.OWNER_EMAIL));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function isAuthenticated(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  return auth.slice(7) === await generateToken(env);
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ── ADMIN HANDLER ─────────────────────────────────────────────────────────────

async function handleAdmin(request, env, path) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // Login — no token required
  if (path === 'login') {
    const { email, password } = await request.json();
    if (email === env.OWNER_EMAIL && password === env.OWNER_PASSWORD) {
      return json({ token: await generateToken(env) });
    }
    return json({ error: 'Invalid credentials' }, 401);
  }

  // Every other route requires a valid token
  if (!await isAuthenticated(request, env)) return json({ error: 'Unauthorized' }, 401);

  const sbUrl = env.SUPABASE_URL + '/rest/v1';
  const sbHeaders = {
    'apikey': env.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal'
  };

  const body = await request.json();

  switch (path) {

    case 'update-product-status': {
      const { id, status } = body;
      if (!id || !['approved', 'rejected'].includes(status))
        return json({ error: 'Invalid input' }, 400);
      const r = await fetch(`${sbUrl}/products?id=eq.${id}`, {
        method: 'PATCH', headers: sbHeaders,
        body: JSON.stringify({ status, reviewed_at: new Date().toISOString() })
      });
      return json(r.ok ? {} : await r.json(), r.ok ? 200 : r.status);
    }

    case 'resolve-offer': {
      const { id, status } = body;
      if (!id || !['accepted', 'declined'].includes(status))
        return json({ error: 'Invalid input' }, 400);
      const r = await fetch(`${sbUrl}/offers?id=eq.${id}`, {
        method: 'PATCH', headers: sbHeaders,
        body: JSON.stringify({ status, resolved_at: new Date().toISOString() })
      });
      return json(r.ok ? {} : await r.json(), r.ok ? 200 : r.status);
    }

    case 'counter-offer': {
      const { id, counter_amount, counter_note } = body;
      if (!id || !counter_amount) return json({ error: 'Missing fields' }, 400);
      const r = await fetch(`${sbUrl}/offers?id=eq.${id}`, {
        method: 'PATCH', headers: sbHeaders,
        body: JSON.stringify({
          status: 'countered',
          counter_amount,
          counter_note: counter_note || null,
          countered_at: new Date().toISOString()
        })
      });
      return json(r.ok ? {} : await r.json(), r.ok ? 200 : r.status);
    }

    case 'send-message': {
      const { session_id, message } = body;
      if (!session_id || !message) return json({ error: 'Missing fields' }, 400);
      const r = await fetch(`${sbUrl}/chat_messages`, {
        method: 'POST', headers: sbHeaders,
        body: JSON.stringify({
          session_id,
          sender: 'owner',
          sender_name: 'Unique Thrift',
          message
        })
      });
      return json(r.ok ? {} : await r.json(), r.ok ? 200 : r.status);
    }

    case 'owner-status': {
      const patch = { last_seen: new Date().toISOString() };
      if (body.is_online !== undefined) patch.is_online = body.is_online;
      const r = await fetch(`${sbUrl}/owner_status?id=eq.1`, {
        method: 'PATCH', headers: sbHeaders,
        body: JSON.stringify(patch)
      });
      return json(r.ok ? {} : await r.json(), r.ok ? 200 : r.status);
    }

    default:
      return json({ error: 'Not found' }, 404);
  }
}
