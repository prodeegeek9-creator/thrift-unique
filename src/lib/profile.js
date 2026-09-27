import { useQuery } from '@tanstack/react-query';
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

// The signed-in person's own details, shared by everything that asks for or
// shows them (Onboarding, the dashboard prompt, Settings).
export const profileKey = (userId) => ['profile', 'me', userId];

export function useMyProfile(user, { enabled = true } = {}) {
  return useQuery({
    queryKey: profileKey(user?.id),
    queryFn: () => fetchMyProfile(user.id),
    enabled: Boolean(user?.id) && enabled,
    staleTime: 5 * 60_000,
  });
}

// "Later" on the dashboard's prompt: a per-viewer convenience, in
// localStorage like the Overview's nudge (lib/dashboard.js). Losing it just
// means being asked again, which is the right failure.
const DETAILS_SNOOZE_DAYS = 7;

export function snoozeDetails(userId) {
  try {
    localStorage.setItem(`vw-details-later-${userId}`, String(Date.now()));
  } catch {
    // Private windows and blocked site data both throw.
  }
}

export function detailsSnoozed(userId) {
  try {
    const at = Number(localStorage.getItem(`vw-details-later-${userId}`));
    return Boolean(at) && Date.now() - at < DETAILS_SNOOZE_DAYS * 86_400_000;
  } catch {
    return false;
  }
}
