import { useState } from 'react';
import { supabase } from '../lib/supabase.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { BrandLockup } from '../components/ui/BrandMark.jsx';

// Where an invitation or a password-reset link lands. The link has already
// signed them in; what it has not done is give them a password, and without
// one the next sign-in is impossible.
export default function SetPassword() {
  const { user, setRecovering } = useAuth();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (password.length < 8) return setError('Use at least 8 characters.');
    if (password !== again) return setError('Those two passwords are different.');

    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.updateUser({ password });
    setBusy(false);

    if (err) return setError(err.message || 'Could not save that password. Try again.');
    setRecovering(false);
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <BrandLockup tone="dark" />
        </div>

        <form onSubmit={submit} className="card space-y-4 p-6">
          <div>
            <h1 className="font-display text-lg font-semibold">Set your password</h1>
            <p className="mt-1 text-sm text-muted">
              {user?.email ? `You'll sign in with ${user.email} and this password.` : 'Choose a password for your dashboard.'}
            </p>
          </div>

          <PasswordField label="New password" value={password} onChange={setPassword} />
          <PasswordField label="Type it again" value={again} onChange={setAgain} />

          {error ? (
            <p role="alert" className="rounded-lg bg-red-lt px-3 py-2 text-xs text-red">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-pill bg-green py-2.5 text-sm font-semibold text-white disabled:opacity-60"
          >
            {busy ? 'Saving…' : 'Save and continue'}
          </button>
        </form>
      </div>
    </div>
  );
}

function PasswordField({ label, value, onChange }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      <input
        type="password"
        required
        minLength={8}
        autoComplete="new-password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-green/40"
      />
    </label>
  );
}
