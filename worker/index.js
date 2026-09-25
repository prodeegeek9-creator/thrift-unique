// The one origin that holds secrets.
//
// Everything the browser cannot be trusted with lives behind /api/: the
// service key, Paystack, WAHA, the Meta and TikTok OAuth tokens, escrow
// release, tenant provisioning. The bundle in dist/ talks to this and to
// Supabase-through-RLS, and to nothing else.

import { ConfigError } from './lib/env.js';
import { json } from './lib/http.js';
import { handlePaystackWebhook } from './routes/paystack.js';
import { handleAdmin } from './routes/admin.js';
import { getConfirmable, confirmReceipt } from './routes/confirm.js';
import { renderProductPage, renderStorePage } from './routes/storefront.js';
import { releaseExpiredHolds } from './routes/escrow.js';
import { handleWaha } from './routes/waha.js';
import { handleTeam } from './routes/team.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path.startsWith('/api/')) {
        return await api(request, env, path);
      }

      // A shared product link. The document is the same bundle everyone else
      // gets; what makes it worth rendering here is the link preview.
      const shared = path.match(/^\/p\/([A-Za-z0-9]{4,10})\/?$/);
      if (shared) {
        return await renderProductPage(request, env, shared[1]);
      }

      // A store's own page, /s/<slug>, for the same reason.
      const store = path.match(/^\/s\/([a-z0-9-]{3,40})\/?$/i);
      if (store) {
        return await renderStorePage(request, env, store[1].toLowerCase());
      }

      // Everything else: a real file if there is one, index.html if not.
      // not_found_handling in wrangler.jsonc does the second part.
      return await env.ASSETS.fetch(request);
    } catch (err) {
      // A missing secret is a deployment problem, not a bad request, and
      // saying so plainly saves a long hunt through logs.
      if (err instanceof ConfigError) {
        console.error('config:', err.message);
        return json({ error: 'Server is not configured' }, 503);
      }
      console.error('unhandled:', err?.stack || err);
      return json({ error: 'Something went wrong' }, 500);
    }
  },

  // The escrow deadline sweep. Schedule it in wrangler.jsonc — without a
  // trigger, held funds never release on their own and every order waits on a
  // buyer who may never come back.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      releaseExpiredHolds(env).then((r) =>
        console.log(`escrow sweep: checked ${r.checked}, released ${r.released}`)
      )
    );
  },
};

async function api(request, env, path) {
  const method = request.method;

  if (method === 'OPTIONS') return new Response(null, { status: 204 });

  if (path === '/api/paystack/webhook' && method === 'POST') {
    return handlePaystackWebhook(request, env);
  }

  // The operator console. Every route under here reads across tenants, which
  // nothing else in the system may do — the privilege comes from one check in
  // lib/operator.js and nowhere else.
  if (path.startsWith('/api/admin')) {
    return handleAdmin(request, env, path);
  }

  const confirm = path.match(/^\/api\/confirm\/(.+)$/);
  if (confirm) {
    const token = confirm[1];
    if (method === 'GET') return getConfirmable(token, env);
    if (method === 'POST') return confirmReceipt(token, env);
    return json({ error: 'Method not allowed' }, 405);
  }

  // WhatsApp: the listing bot's webhook, and the session a seller links by
  // scanning a QR code.
  if (path.startsWith('/api/waha')) {
    return handleWaha(request, env, path);
  }

  // Adding a colleague. Here rather than in the browser because a membership
  // needs a user_id, and resolving an email to one means reading auth.users.
  if (path.startsWith('/api/team')) {
    return handleTeam(request, env, path);
  }

  // Not built yet, and saying so is better than a 404 that reads like a typo.
  //
  // The Meta and TikTok OAuth flows need an app review and an audit before
  // they can be tested against anything real, so they are deliberately absent
  // rather than written blind — see the README.
  if (
    path.startsWith('/api/oauth/') ||
    path.startsWith('/api/publish/') ||
    path.startsWith('/api/tenants/')
  ) {
    return json({ error: 'Not implemented yet' }, 501);
  }

  return json({ error: 'Not found' }, 404);
}
