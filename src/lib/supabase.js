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

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
