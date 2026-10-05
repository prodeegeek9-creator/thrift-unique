import { createClient } from '@supabase/supabase-js';

// A new, empty project of its own — not the Automate Naija one, and not the
// one the old single-store marketplace ran on. The schema in
// supabase/migrations builds it from nothing; no data is carried over.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Fail loudly, at load, with the actual remedy.
//
// Vite inlines these at build time, so a deploy whose build environment is
// missing them produces a bundle where every request goes to `undefined` —
// and createClient does not complain. The symptom is a dashboard that loads,
// looks fine and never shows a single row, which is a genuinely hard thing to
// trace back to a missing variable on a CI project.
if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. These are read at ' +
      'BUILD time, so set them as build environment variables on the ' +
      'Cloudflare project (not as Worker secrets), or in .env for local work.'
  );
}

// The platform console keeps a session of its own (src/lib/adminAuth.jsx), so
// signing in to a store never opens the console and signing in to the console
// never opens a store. A sign-in link that lands under /admin belongs to the
// console's client, and this one leaves it alone.
export const onConsole =
  typeof window !== 'undefined' && /^\/admin(\/|$)/.test(window.location.pathname);

// How this page load signed somebody in, when it came from an emailed-style
// link: 'invite' or 'recovery'. Both sign the person in without their having a
// password (yet), so the router holds them on a set-password screen — see
// RequireAuth. Read here because createClient consumes and clears the hash.
export const linkType = (() => {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.hash.slice(1));
  return params.get('access_token') ? params.get('type') : null;
})();

export const arrivedVia = onConsole ? null : linkType;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { detectSessionInUrl: !onConsole },
});

// The console's client: same project, its own storage key, and the only one
// that reads a sign-in link under /admin.
export const consoleSupabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { storageKey: 'ut-console-auth', detectSessionInUrl: onConsole },
});
