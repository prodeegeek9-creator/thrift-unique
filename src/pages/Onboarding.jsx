import { useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BrandLockup } from '../components/ui/BrandMark.jsx';
import Icon from '../components/ui/Icon.jsx';
import LogoLoader from '../components/ui/LogoLoader.jsx';
import { setupDeepLink, botNumberDisplay } from '../lib/whatsapp.js';
import { useAuth, signOut } from '../lib/AuthContext.jsx';
import { useTenant } from '../lib/TenantContext.jsx';
import { fetchSignupStatus } from '../lib/signup.js';
import DetailsForm from '../components/DetailsForm.jsx';
import { missingDetails, useMyProfile } from '../lib/profile.js';

// Where somebody lands with an account but no store: made on the web
// (Signup.jsx), or a store that hasn't been approved yet.
//
// A store is opened on WhatsApp, from the number it will run on, because
// that's what proves the seller has that number. The button types the
// account's code (VW-…) into the chat, so the bot opens the store for this
// account without asking for an email (worker/routes/signup.js). The page
// checks back while it's open, and goes to the dashboard once the store is
// approved.
//
// First, though, who the account belongs to: anybody without a name, phone
// and address on file is asked for them here. That's everybody who signed up
// with Google, which only brings a name (lib/profile.js).
export default function Onboarding() {
  const { user, loading: authLoading } = useAuth();
  const { memberships, loading } = useTenant();

  const signedInWithoutStore = !authLoading && !loading && user && !memberships.length;
  const { data: status, isError } = useQuery({
    queryKey: ['signup', 'me', user?.id],
    queryFn: fetchSignupStatus,
    enabled: Boolean(signedInWithoutStore),
    refetchInterval: 20_000,
  });
  const { data: profile, isError: profileError } = useMyProfile(user, { enabled: Boolean(signedInWithoutStore) });

  // Approved while the page was open: a full load, so the dashboard reads
  // the new membership.
  useEffect(() => {
    if (status?.hasStore) window.location.assign('/dashboard');
  }, [status?.hasStore]);

  // Only for somebody signed in with no store. Anybody who does have one, or
  // whose stores are still loading, is somewhere else: a sign-in that raced
  // here must not leave a store owner told they have no store.
  if (authLoading || loading) return <LogoLoader fullScreen label="Opening your store" />;
  if (!user) return <Navigate to="/login" replace />;
  if (memberships.length) return <Navigate to="/dashboard" replace />;
  if (!status && !isError) return <LogoLoader fullScreen label="Opening your store" />;
  if (profile === undefined && !profileError) return <LogoLoader fullScreen label="Opening your store" />;

  // A failed read isn't a reason to hold anybody up: the details are asked
  // for again next time.
  if (!profileError && missingDetails(profile).length) {
    return <DetailsStep user={user} profile={profile} />;
  }

  const code = status?.code ?? null;
  const link = setupDeepLink(code);
  const number = botNumberDisplay();
  const waiting = status?.signup?.state === 'waiting_approval';
  const started = status?.signup?.state === 'in_progress';

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4 py-8">
      <div className="card w-full max-w-sm p-6">
        <div className="mb-4 flex justify-center">
          <BrandLockup tone="dark" />
        </div>

        {waiting ? (
          <div className="text-center">
            <h1 className="font-display text-lg font-semibold">Your store is being reviewed</h1>
            <p className="mt-2 text-sm text-muted">
              <span className="font-medium text-ink">{status.signup.business_name ?? 'Your store'}</span> is waiting for
              approval. We'll message you on WhatsApp when it's live, and this page opens your dashboard by itself.
            </p>
          </div>
        ) : (
          <>
            <h1 className="text-center font-display text-lg font-semibold">
              {started ? 'Carry on in WhatsApp' : 'Set up your store on WhatsApp'}
            </h1>
            <p className="mt-2 text-center text-sm text-muted">
              {started
                ? "You've started setting up your store. Answer the rest of the questions in the chat."
                : 'Your store runs on WhatsApp, so it starts there, from the number your store will use.'}
            </p>

            {!started ? (
              <ol className="mt-4 space-y-2 text-sm text-text">
                {[
                  'Tap the button below. WhatsApp opens with a message ready: send it.',
                  'Answer a few questions: your business name, what you sell, your plan.',
                  "We review your store and message you when it's live. It shows up here.",
                ].map((step, i) => (
                  <li key={step} className="flex gap-2.5">
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-green-lt text-[11px] font-semibold text-green">
                      {i + 1}
                    </span>
                    {step}
                  </li>
                ))}
              </ol>
            ) : null}

            {link ? (
              <a
                href={link}
                className="mt-5 flex items-center justify-center gap-2 rounded-pill bg-green px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90"
              >
                <Icon name="whatsapp" className="h-4 w-4" />
                {started ? 'Back to WhatsApp' : 'Open WhatsApp'}
              </a>
            ) : null}

            {/* For somebody reading this on a computer: the message to send
                from the phone the store will use. */}
            {code && number ? (
              <p className="mt-3 text-center text-xs text-muted">
                On a computer? From your store's phone, send{' '}
                <span className="whitespace-nowrap font-mono font-semibold text-ink">{code}</span> to{' '}
                <span className="whitespace-nowrap font-medium text-ink">{number}</span> on WhatsApp.
              </p>
            ) : null}
          </>
        )}

        <p className="mt-6 text-center text-[11px] text-muted">
          Signed in as {user.email}.{' '}
          <button type="button" onClick={signOut} className="font-medium text-green hover:underline">
            Sign out
          </button>
        </p>
      </div>
    </div>
  );
}

// Name, phone and address, for an account that doesn't have them yet. Saving
// updates the profile the page reads, which moves it on to the WhatsApp step.
function DetailsStep({ user, profile }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4 py-8">
      <div className="card w-full max-w-sm space-y-4 p-6">
        <div className="flex justify-center">
          <BrandLockup tone="dark" />
        </div>
        <div>
          <h1 className="font-display text-lg font-semibold">A little about you</h1>
          <p className="mt-1 text-sm text-muted">
            Before your store: who we're opening it for, and how to reach you.
          </p>
        </div>

        <DetailsForm user={user} profile={profile} submitLabel="Continue" />

        <p className="text-center text-[11px] text-muted">
          Signed in as {user.email}.{' '}
          <button type="button" onClick={signOut} className="font-medium text-green hover:underline">
            Sign out
          </button>
        </p>
      </div>
    </div>
  );
}
