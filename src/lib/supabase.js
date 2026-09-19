import { createClient } from '@supabase/supabase-js';

// A different project from the Automate Naija one, and deliberately the same
// project the live marketplace already uses — the existing store becomes
// tenant #1 rather than being migrated into a fresh database.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
