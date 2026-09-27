import { supabase } from './supabase.js';
import { callWorker } from './api.js';

// Accounts made on the web: email and password, or Google. An account is a
// login, not a store; the store is opened on WhatsApp (Onboarding.jsx).

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Whether Google sign-in is switched on for this project. Asked of Supabase
// itself, so the button appears the day the provider is set up in its
// dashboard, and never as a button that fails.
let googleCheck = null;
export function googleEnabled() {
  googleCheck ??= fetch(`${SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: ANON_KEY } })
    .then((res) => (res.ok ? res.json() : null))
    .then((settings) => settings?.external?.google === true)
    .catch(() => false);
  return googleCheck;
}

// Off to Google and back. The session arrives in the URL on return, and the
// dashboard's own guard sends an account with no store to onboarding.
export async function signInWithGoogle() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: `${window.location.origin}/dashboard` },
  });
  if (error) throw error;
}

// → { confirm: true } when Supabase has sent a confirmation email, or
//   { confirm: false } when the account is signed in straight away.
export async function signUpWithEmail(email, password) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: `${window.location.origin}/dashboard` },
  });
  if (error) throw error;
  return { confirm: !data.session };
}

// The account's WhatsApp code, and how far its store has got.
export const fetchSignupStatus = () => callWorker('/api/signup/me', { method: 'GET' });
