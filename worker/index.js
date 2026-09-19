// The one origin that holds secrets.
//
// Everything the browser cannot be trusted with lives behind /api/: the
// service key, Paystack, WAHA, the Meta and TikTok OAuth tokens, escrow
// release, tenant provisioning. The bundle in dist/ talks to this and to
// Supabase-through-RLS, and to nothing else.
//
// Routes land here in phase 3. Today this is the shell: static assets, the
// SPA fallback, and the two public paths that need an answer before the
// dashboard is worth deploying.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return json({ error: 'Not implemented' }, 501);
    }

    // A shared product link. The document is the same bundle everyone else
    // gets; what makes it worth rendering at the edge is the link preview —
    // a forwarded WhatsApp Status or a Facebook post has to show the photo
    // and the price, not the bare URL.
    //
    // Two things happen here once this is built: the og: tags are injected
    // from the product row, and the blanket noindex in index.html is replaced,
    // because that default exists to keep the *dashboard* out of search and
    // would otherwise take the public pages with it.
    if (url.pathname.startsWith('/p/')) {
      return env.ASSETS.fetch(request);
    }

    // Everything else: a real file if there is one, index.html if there is
    // not. not_found_handling in wrangler.jsonc does the second part.
    return env.ASSETS.fetch(request);
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
