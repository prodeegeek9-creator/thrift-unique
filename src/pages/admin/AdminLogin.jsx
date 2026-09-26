import { useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { consoleSupabase } from '../../lib/supabase.js';
import { useConsoleAuth, useConsoleSignOut } from '../../lib/adminAuth.jsx';
import { useOperatorCheck } from './RequireOperator.jsx';
import { BrandLockup } from '../../components/ui/BrandMark.jsx';
import LogoLoader from '../../components/ui/LogoLoader.jsx';
import { SetPasswordScreen } from '../SetPassword.jsx';

// The admin team's way in. Not the store sign-in with a different heading:
// its own address, its own session (src/lib/adminAuth.jsx), and nothing here
// links to or from a store's dashboard.

export function ConsoleBadge() {
  return (
    <p className="mx-auto mb-4 w-fit rounded-pill bg-gold/20 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-gold">
      Platform console
    </p>
  );
}

export default function AdminLogin() {
  const { user, loading, recovering, setRecovering } = useConsoleAuth();
  const signOut = useConsoleSignOut();
  const location = useLocation();
  const { operator, checking, failed, retry } = useOperatorCheck();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (loading || (user && checking)) return <LogoLoader fullScreen label="Platform console" />;

  if (user && recovering) {
    return (
      <SetPasswordScreen
        client={consoleSupabase}
        email={user.email}
        fallback="Choose a password for the platform console."
        onDone={() => setRecovering(false)}
        badge={<ConsoleBadge />}
      />
    );
  }

  if (user && operator) return <Navigate to={location.state?.from ?? '/admin'} replace />;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await consoleSupabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (err) setError('That email and password did not match.');
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-sidebar px-4">
      <div className="w-full max-w-sm">
        <div className="mb-4 flex justify-center">
          <BrandLockup />
        </div>
        <ConsoleBadge />

        {user && failed ? (
          <div className="card space-y-4 p-6">
            <div>
              <h1 className="font-display text-lg font-semibold">Couldn't check your access</h1>
              <p className="mt-1 text-sm text-muted">Something went wrong reaching the platform. Try again.</p>
            </div>
            <button
              type="button"
              onClick={() => retry()}
              className="w-full rounded-pill bg-ink py-2.5 text-sm font-semibold text-white"
            >
              Try again
            </button>
          </div>
        ) : user ? (
          // Signed in, but the Worker says they are not on the admin team.
          <div className="card space-y-4 p-6">
            <div>
              <h1 className="font-display text-lg font-semibold">Not an admin account</h1>
              <p className="mt-1 text-sm text-muted">
                {user.email} isn't on the admin team. Ask a platform owner to add you, or sign in with
                another account.
              </p>
            </div>
            <button
              type="button"
              onClick={signOut}
              className="w-full rounded-pill bg-ink py-2.5 text-sm font-semibold text-white"
            >
              Use another account
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="card space-y-4 p-6">
            <div>
              <h1 className="font-display text-lg font-semibold">Admin sign in</h1>
              <p className="mt-1 text-sm text-muted">For the Unique Thrift admin team only.</p>
            </div>

            <Field label="Email" type="email" autoComplete="email" value={email} onChange={setEmail} />
            <Field
              label="Password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={setPassword}
            />

            {error ? (
              <p role="alert" className="rounded-lg bg-red-lt px-3 py-2 text-xs text-red">
                {error}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-pill bg-ink py-2.5 text-sm font-semibold text-white disabled:opacity-60"
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}

        <p className="mt-4 text-center text-xs text-white/50">
          Forgotten your password? Ask a platform owner for a new sign-in link.
        </p>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, ...props }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      <input
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-green/40"
        {...props}
      />
    </label>
  );
}
