import { createClient } from '@supabase/supabase-js';

// A new, empty project of its own — not the Automate Naija one, and not the
// one the old single-store marketplace ran on. The schema in
// supabase/migrations builds it from nothing; no data is carried over.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
