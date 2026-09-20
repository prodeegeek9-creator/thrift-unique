import { config } from '../lib/env.js';
import { db } from '../lib/supabase.js';
import { escapeHtml, summarise } from '../lib/http.js';
import { publicUrl } from '../lib/media.js';

// GET /p/:code — the shared product link, rendered at the edge.
//
// The page itself is the same React bundle everyone else gets. What has to
// happen here is the link preview: a scraper does not run JavaScript, so
// without this a listing forwarded on WhatsApp or posted to Facebook arrives
// as a bare URL instead of a photo and a price. That difference is most of
// whether anyone taps it.
//
// Every failure path ends in "serve the page we would have served anyway".
// These tags are an enhancement; the listing still has to render if Supabase
// is slow or the code is wrong.
export async function renderProductPage(request, env, code) {
  const asset = await env.ASSETS.fetch(new Request(new URL('/index.html', request.url), request));

  const product = await lookup(env, code).catch(() => null);
  if (!product) return asset;

  const html = await asset.text();
  const origin = new URL(request.url).origin;

  const title = `${product.title} — ${product.tenant_name}`;
  const description = summarise(
    product.description || `${formatNaira(product.price)} · ${condition(product.condition)}`
  );

  // A storage path, not a URL — see the note on products.images in the catalog
  // migration. Resolving it against this origin, which is what happened
  // before anything ever wrote an image, produces a 404 that a scraper
  // silently drops and nobody sees.
  const image = publicUrl(config(env), product.images?.[0]);

  const tags = [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<meta property="og:type" content="product">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:url" content="${escapeHtml(`${origin}/p/${product.public_code}`)}">`,
    `<meta property="og:site_name" content="${escapeHtml(product.tenant_name)}">`,
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
    // A price in the card is the single most useful thing a scraper can show.
    `<meta property="product:price:amount" content="${escapeHtml(String(product.price))}">`,
    `<meta property="product:price:currency" content="NGN">`,
  ];

  if (image) {
    tags.push(
      `<meta property="og:image" content="${escapeHtml(image)}">`,
      `<meta name="twitter:image" content="${escapeHtml(image)}">`,
      `<meta property="og:image:alt" content="${escapeHtml(product.title)}">`
    );
  }

  // The document ships `noindex` by default to keep the dashboard out of
  // search. A shared product link is the one page that wants the opposite, so
  // the default is replaced rather than added to.
  const body = html
    .replace(/<meta\s+name="robots"[^>]*>/i, '<meta name="robots" content="index, follow">')
    .replace(/<title>[^<]*<\/title>/i, '')
    .replace('</head>', `${tags.join('\n    ')}\n  </head>`);

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Short, because a listing sells and the card should stop showing it
      // soon after. Long enough that a link going round a group chat is not
      // one database read per tap.
      'cache-control': 'public, max-age=60, s-maxage=300',
    },
  });
}

async function lookup(env, code) {
  const cfg = config(env);
  if (!cfg.supabaseUrl || !cfg.serviceKey) return null;

  // The same function the browser calls: one row, by code, with the columns
  // that are safe to show a stranger. Going through it rather than reading
  // `products` directly means the column list is defined in one place.
  const rows = await db(cfg).rpc('public_product', { code });
  return rows?.[0] ?? null;
}

function condition(value) {
  return (
    { brand_new: 'Brand new', excellent: 'Excellent condition', good: 'Good condition', fair: 'Fair condition' }[
      value
    ] ?? value
  );
}

function formatNaira(amount) {
  const n = Math.round(Number(amount) || 0);
  return `₦${n.toLocaleString('en-NG')}`;
}
