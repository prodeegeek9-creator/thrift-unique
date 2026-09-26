import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { BrandLockup } from '../components/ui/BrandMark.jsx';

// Where an invitation or new sign-in link lands: /welcome for stores,
// /admin/welcome for the console (see worker/lib/accounts.js).
//
// The link's one-time token sits in the fragment and is only redeemed when
// the person presses Continue. Opening the page does nothing, which is the
// point: WhatsApp and WAHA open every link they send to build a preview, and
// when the link itself was Supabase's, that preview spent the token before
// anybody tapped it.

export default function Welcome() {
  const { setRecovering } = useAuth();
  const navigate = useNavigate();
  return (
    <WelcomeScreen
      client={supabase}
      help="Reply PASSWORD to the Vendwyze WhatsApp number for a new link, or ask whoever invited you."
      onVerified={() => {
        setRecovering(true);
        navigate('/dashboard', { replace: true });
      }}
    />
  );
}

// The same screen for either session: the store's, or the console's own.
export function WelcomeScreen({ client, onVerified, help, badge = null, dark = false }) {
  const [token] = useState(readToken);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Out of the address bar once read, so it isn't bookmarked, shared or left
  // in the history.
  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }, []);

  async function go() {
    setBusy(true);
    setError(null);
    const { error: err } = await client.auth.verifyOtp({ token_hash: token.hash, type: token.type });
    setBusy(false);
    if (err) {
      setError('This link has expired or has already been used.');
      return;
    }
    onVerified();
  }

  return (
    <div className={`flex min-h-dvh items-center justify-center px-4 ${dark ? 'bg-sidebar' : 'bg-bg'}`}>
      <div className="w-full max-w-sm">
        <div className="mb-4 flex justify-center">
          <BrandLockup tone={dark ? 'light' : 'dark'} />
        </div>
        {badge}

        <div className="card space-y-4 p-6">
          {!token ? (
            <>
              <h1 className="font-display text-lg font-semibold">This link is incomplete</h1>
              <p className="text-sm text-muted">Open the whole link from your message. {help}</p>
            </>
          ) : (
            <>
              <div>
                <h1 className="font-display text-lg font-semibold">
                  {token.type === 'recovery' ? 'Set a new password' : 'Welcome to Vendwyze'}
                </h1>
                <p className="mt-1 text-sm text-muted">
                  {token.type === 'recovery'
                    ? 'Continue to choose a new password.'
                    : 'Continue to choose the password you will sign in with.'}
                </p>
              </div>

              {error ? (
                <p role="alert" className="rounded-lg bg-red-lt px-3 py-2 text-xs text-red">
                  {error} {help}
                </p>
              ) : null}

              <button
                type="button"
                disabled={busy}
                onClick={go}
                className="w-full rounded-pill bg-green py-2.5 text-sm font-semibold text-white disabled:opacity-60"
              >
                {busy ? 'Checking…' : 'Continue'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function readToken() {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const hash = params.get('token_hash');
  const type = params.get('type');
  if (!hash || !['invite', 'recovery', 'magiclink', 'signup', 'email'].includes(type)) return null;
  return { hash, type };
}
