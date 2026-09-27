import { supabase } from './supabase.js';

// Who is behind an account: name, phone and address (migration 0037). Asked
// for when the account is made (Signup.jsx), and on the onboarding page for
// anybody who came in without them, like a Google sign-in, which brings a
// name and nothing else.

export { NIGERIAN_STATES, EMPTY_PROFILE, checkedProfile, missingDetails, nameFromAccount } from './profileRules.js';

const PROFILE_COLUMNS = 'user_id,full_name,phone,address,city,state';

export async function fetchMyProfile(userId) {
  const { data, error } = await supabase.from('account_profiles').select(PROFILE_COLUMNS).eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data;
}

// A row is made for every account when it's created, but one made before the
// table existed, or whose insert failed, may not have it: then it's added.
// Not an upsert: that would also write user_id, which isn't writable.
export async function saveMyProfile(userId, profile) {
  const updated = await supabase
    .from('account_profiles')
    .update(profile)
    .eq('user_id', userId)
    .select(PROFILE_COLUMNS)
    .maybeSingle();
  if (updated.error) throw updated.error;
  if (updated.data) return updated.data;

  const inserted = await supabase
    .from('account_profiles')
    .insert({ user_id: userId, ...profile })
    .select(PROFILE_COLUMNS)
    .single();
  if (inserted.error) throw inserted.error;
  return inserted.data;
}
