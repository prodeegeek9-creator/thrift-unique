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
    publicOrigin: env.PUBLIC_ORIGIN || null,
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
