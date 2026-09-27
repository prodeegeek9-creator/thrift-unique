import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import ProfileFields from './ProfileFields.jsx';
import { EMPTY_PROFILE, checkedProfile, nameFromAccount, profileKey, saveMyProfile } from '../lib/profile.js';

// Name, phone and address, filled with whatever the account already has, and
// saved to its own row (lib/profile.js). On the onboarding page, the
// dashboard's prompt and Settings.
export default function DetailsForm({ user, profile, submitLabel = 'Save', onSaved, children }) {
  const queryClient = useQueryClient();
  const [details, setDetails] = useState(() => ({
    ...EMPTY_PROFILE,
    ...Object.fromEntries(Object.entries(profile ?? {}).filter(([k, v]) => k in EMPTY_PROFILE && v)),
    full_name: profile?.full_name || nameFromAccount(user),
  }));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    const { profile: checked, error: detailsError } = checkedProfile(details);
    if (detailsError) {
      setError(detailsError);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await saveMyProfile(user.id, checked);
      queryClient.setQueryData(profileKey(user.id), saved);
      onSaved?.(saved);
    } catch {
      setError("Couldn't save your details. Try again in a minute.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <ProfileFields value={details} onChange={setDetails} />

      {error ? (
        <p role="alert" className="rounded-lg bg-red-lt px-3 py-2 text-xs text-red">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-pill bg-green px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
        >
          {busy ? 'Saving…' : submitLabel}
        </button>
        {children}
      </div>
    </form>
  );
}
