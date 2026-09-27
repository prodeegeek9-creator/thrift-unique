import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext.jsx';
import { signUpWithEmail } from '../lib/signup.js';
import { BrandLockup } from '../components/ui/BrandMark.jsx';
import LogoLoader from '../components/ui/LogoLoader.jsx';
import GoogleButton from '../components/GoogleButton.jsx';

// Making an account on the web. It's a login, not a store: the store is
// opened on WhatsApp next, from the number it will run on (Onboarding.jsx),
// and the account is where its dashboard shows up once it's approved.
export default function Signup() {
  const { user, loading } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState(null);

  if (loading) return <LogoLoader fullScreen label="Vendwyze" />;
  if (user) return <Navigate to="/dashboard" replace />;

  async function submit(e) {
    e.preventDefault();
    if (password.length < 8) {
      setError('Choose a password of at least 8 characters.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { confirm } = await signUpWithEmail(email.trim().toLowerCase(), password);
      // Signed in straight away when confirmation is off; the guard on
      // /dashboard then takes it to onboarding.
      if (confirm) setSentTo(email.trim());
    } catch (err) {
      setError(/registered|exists/i.test(err?.message ?? '') ? 'That email already has an account. Sign in instead.' : "Couldn't create the account. Try again in a minute.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <BrandLockup tone="dark" />
        </div>

        {sentTo ? (
          <div className="card space-y-2 p-6 text-center">
            <h1 className="font-display text-lg font-semibold">Check your email</h1>
            <p className="text-sm text-muted">
              We've sent a link to <span className="font-medium text-ink">{sentTo}</span>. Open it to confirm your
              account, then set up your store on WhatsApp.
            </p>
          </div>
        ) : (
          <form onSubmit={submit} className="card space-y-4 p-6">
            <div>
              <h1 className="font-display text-lg font-semibold">Create your account</h1>
              <p className="mt-1 text-sm text-muted">
                Next you'll open your store on WhatsApp, from the number it will run on.
              </p>
            </div>

            <GoogleButton />

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Email</span>
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={INPUT}
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Password</span>
              <input
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={INPUT}
              />
              <span className="mt-1 block text-[11px] text-muted">At least 8 characters.</span>
            </label>

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
              {busy ? 'Creating account…' : 'Create account'}
            </button>
          </form>
        )}

        <p className="mt-4 text-center text-xs text-muted">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-green underline-offset-2 hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

const INPUT =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-green/40';
