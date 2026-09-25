import { useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { BrandLockup } from '../components/ui/BrandMark.jsx';
import LogoLoader from '../components/ui/LogoLoader.jsx';
import { setupDeepLink } from '../lib/whatsapp.js';

const setupLink = setupDeepLink();

export default function Login() {
  const { user, loading } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (loading) return <LogoLoader fullScreen label="Unique Thrift" />;
  if (user) return <Navigate to={location.state?.from ?? '/dashboard'} replace />;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const { error: err } = await supabase.auth.signInWithPassword({ email, password });

    setBusy(false);
    // Deliberately not distinguishing "no such account" from "wrong password".
    // The seller sees the same sentence either way, and so does anyone
    // checking whether a phone number's owner has a store here.
    if (err) setError('That email and password did not match.');
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <BrandLockup tone="dark" />
        </div>

        <form onSubmit={submit} className="card space-y-4 p-6">
          <div>
            <h1 className="font-display text-lg font-semibold">Sign in</h1>
            <p className="mt-1 text-sm text-muted">
              Your store runs on WhatsApp. This is where you check on it.
            </p>
          </div>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Email</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-green/40"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Password</span>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-green/40"
            />
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
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-muted">
          No store yet?{' '}
          {setupLink ? (
            <a href={setupLink} className="font-medium text-green underline-offset-2 hover:underline">
              Message us on WhatsApp
            </a>
          ) : (
            'Message us on WhatsApp'
          )}{' '}
          and we'll set one up.
        </p>
      </div>
    </div>
  );
}
