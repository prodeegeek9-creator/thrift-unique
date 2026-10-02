import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { BrandLockup } from '../../components/ui/BrandMark.jsx';
import SiteFooter from '../../components/layout/SiteFooter.jsx';
import { useAuth } from '../../lib/AuthContext.jsx';

// The frame the footer's pages share: the homepage's header, a readable
// column of text, and the full footer.
//
// The router keeps the scroll position across navigations, so following a
// footer link from the bottom of one page would open the next one at its
// bottom too. Each of these pages starts at the top instead.
export default function InfoPage({ title, intro, updated, children }) {
  const { user } = useAuth();
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  useEffect(() => {
    const before = document.title;
    document.title = `${title} · Vendwyze`;
    return () => {
      document.title = before;
    };
  }, [title]);

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-text">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-4">
        <Link to="/" aria-label="Vendwyze home">
          <BrandLockup />
        </Link>
        <Link
          to={user ? '/dashboard' : '/login'}
          className="rounded-pill border border-line bg-surface px-4 py-2 text-sm font-semibold text-ink hover:bg-surface-2"
        >
          {user ? 'Dashboard' : 'Sign in'}
        </Link>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-16 pt-6 sm:pt-10">
        <h1 className="font-display text-3xl font-semibold leading-tight text-ink sm:text-4xl">{title}</h1>
        {updated ? <p className="mt-2 text-xs text-muted">Last updated {updated}</p> : null}
        {intro ? <p className="mt-4 text-base leading-relaxed text-muted">{intro}</p> : null}
        <div className="mt-8 space-y-8">{children}</div>
      </main>

      <SiteFooter />
    </div>
  );
}

// One numbered or titled part of a page.
export function Section({ id, title, children }) {
  return (
    <section id={id} className="scroll-mt-6">
      <h2 className="font-display text-xl font-semibold text-ink">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-text sm:text-[15px]">{children}</div>
    </section>
  );
}

export function List({ children }) {
  return <ul className="list-disc space-y-1.5 pl-5 marker:text-muted">{children}</ul>;
}

// "Contact us" as the legal pages say it: WhatsApp first, email if set.
export function ContactLine({ contact }) {
  const { whatsapp, number, email } = contact;
  return (
    <p>
      {whatsapp ? (
        <>
          Message us on WhatsApp at{' '}
          <a href={whatsapp} className="font-medium text-green hover:underline">
            {number ?? 'our support number'}
          </a>
        </>
      ) : (
        <>
          Use the{' '}
          <Link to="/contact" className="font-medium text-green hover:underline">
            contact page
          </Link>
        </>
      )}
      {email ? (
        <>
          {' '}or email{' '}
          <a href={`mailto:${email}`} className="font-medium text-green hover:underline">
            {email}
          </a>
        </>
      ) : null}
      .
    </p>
  );
}
