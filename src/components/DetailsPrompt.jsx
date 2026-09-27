import { useState } from 'react';
import DetailsForm from './DetailsForm.jsx';
import { useAuth } from '../lib/AuthContext.jsx';
import { useTenant } from '../lib/TenantContext.jsx';
import { detailsSnoozed, missingDetails, snoozeDetails, useMyProfile } from '../lib/profile.js';

// Asks a store owner for their name, phone and address, at the top of every
// dashboard page, until they're given. For owners who never saw the sign-up
// form: a store opened on WhatsApp gets its login when it's approved, and
// accounts older than the form (migration 0037). "Later" puts it away for a
// week on this device.
export default function DetailsPrompt() {
  const { user } = useAuth();
  const { role } = useTenant();
  const [later, setLater] = useState(() => detailsSnoozed(user?.id));
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const { data: profile, isSuccess } = useMyProfile(user, { enabled: role === 'owner' && !later });

  if (role !== 'owner' || later) return null;
  if (done) {
    return (
      <p role="status" className="mb-4 rounded-card bg-green-lt px-4 py-3 text-sm text-green">
        Thanks, your details are saved. You can change them in Settings.
      </p>
    );
  }
  // A failed read shows nothing: it's asked again on the next visit.
  if (!isSuccess || !missingDetails(profile).length) return null;

  return (
    <section className="card mb-4 max-w-2xl p-4">
      <h2 className="text-sm font-semibold text-ink">Add your details</h2>
      <p className="mt-0.5 text-sm text-muted">
        Your name, phone number and address, so we know who runs the store and how to reach you.
      </p>

      {open ? (
        <div className="mt-4">
          <DetailsForm user={user} profile={profile} onSaved={() => setDone(true)}>
            <button type="button" onClick={() => setOpen(false)} className="px-3 py-2 text-sm text-muted hover:text-ink">
              Cancel
            </button>
          </DetailsForm>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-pill bg-green px-4 py-2 text-sm font-semibold text-white"
          >
            Add details
          </button>
          <button
            type="button"
            onClick={() => {
              snoozeDetails(user.id);
              setLater(true);
            }}
            className="rounded-pill px-3 py-2 text-sm text-muted hover:text-ink"
          >
            Later
          </button>
        </div>
      )}
    </section>
  );
}
