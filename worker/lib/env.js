// Configuration, read and checked in one place.
//
// A Worker route that discovers halfway through a payment webhook that a
// secret is missing has already told Paystack "200 OK" or left an order in a
// half-written state. Everything that needs config asks for it up front and
// fails before touching anything.

export function config(env) {
  // Accepts both spellings. The Pages/Workers build already sets the VITE_
  // names so the bundle can be built; reading them here means a deployment
  // does not need a second copy of the same URL under a different name.
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL;

  return {
    supabaseUrl: url ? url.replace(/\/+$/, '') : null,
    serviceKey: env.SUPABASE_SERVICE_KEY || null,
    tokenSecret: env.TOKEN_SECRET || null,
    // Paystack signs webhooks with the secret key itself — there is no
    // separate webhook secret, whatever the dashboard's wording suggests.
    paystackKey: env.PAYSTACK_SECRET_KEY || null,

    // The canonical origin this app is served on, without a trailing slash.
    //
    // It is what a shared product link points at, where WAHA is told to
    // deliver webhooks, and where a newly invited colleague lands. Not a
    // secret — it is in every link the product sends — so it belongs in
    // wrangler.jsonc under `vars`, versioned and deployed with the code,
    // rather than in a dashboard where nobody can see it.
    //
    // Optional, because a Worker already knows what origin it was reached on:
    // see originOf(). Setting it explicitly pins the canonical domain, which
    // matters once the app answers on more than one (a workers.dev URL and a
    // real domain), so that links always name the one people should see.
    publicOrigin: env.PUBLIC_ORIGIN ? env.PUBLIC_ORIGIN.replace(/\/+$/, '') : null,

    // WAHA — the self-hosted WhatsApp HTTP API. Base URL of the server, and
    // the key it checks on every call.
    wahaUrl: env.WAHA_URL ? env.WAHA_URL.replace(/\/+$/, '') : null,
    wahaKey: env.WAHA_API_KEY || null,

    // The platform's own WhatsApp session: the number sellers message to add
    // an item. Distinct from a tenant's session, which is the seller's own
    // WhatsApp and exists to post to their Status — see routes/waha.js.
    wahaSession: env.WAHA_SESSION || 'ut-platform',

    // What the platform session's webhook carries. Tenant sessions each get
    // their own secret in tenants.waha_secret; this one has no tenant to hang
    // off, so it is configuration.
    wahaWebhookSecret: env.WAHA_WEBHOOK_SECRET || null,

    // How long the bot shows "typing…" before a reply, in ms. Unset means a
    // beat scaled to the reply's length; 0 switches it off.
    wahaTypingMs:
      env.WAHA_TYPING_MS != null && env.WAHA_TYPING_MS !== '' ? Number(env.WAHA_TYPING_MS) : null,
  };
}

// Throws with the names that are missing, rather than letting a route fail
// later with a null dereference three frames deep.
export function require_(env, ...names) {
  const c = config(env);
  const missing = names.filter((n) => !c[n]);
  if (missing.length) {
    throw new ConfigError(`Missing configuration: ${missing.join(', ')}`);
  }
  return c;
}

export class ConfigError extends Error {}

// The origin to put in a link, for a handler that has a request in hand.
//
// A Worker is told what host it was reached on, so an unset PUBLIC_ORIGIN does
// not have to mean no link. Before this, a deployment that had not set it sent
// sellers a confirmation with the listing link quietly missing and dropped the
// redirect off an invitation, which reads as the app being broken rather than
// as a variable nobody set.
//
// The configured value still wins where there is one. A Host header is
// attacker-controlled in general; here it is bounded by the fact that
// Cloudflare only routes hosts you own to your Worker, but a canonical origin
// is still the thing to put in a link somebody else will open.
//
// The cron handler has no request and therefore no fallback — anything it
// needs an origin for has to be configured.
export function originOf(request, cfg) {
  if (cfg.publicOrigin) return cfg.publicOrigin;
  try {
    return new URL(request.url).origin;
  } catch {
    return null;
  }
}
