import { Link } from 'react-router-dom';
import { BrandLockup } from '../ui/BrandMark.jsx';
import Icon from '../ui/Icon.jsx';
import { COMPACT_LINKS, FOOTER_LINKS, supportContact } from '../../lib/legal.js';
import { setupDeepLink } from '../../lib/whatsapp.js';

// The public pages' footer. Two shapes:
//
//   full      the homepage and the platform's own pages: what Vendwyze is,
//             where to reach it, and every page it publishes
//   compact   a store or product page, which is the store's and not ours, so
//             it gets one quiet row: who takes the payment, and the documents
//             a buyer paying there may want
//
// Links to sections of the homepage are plain anchors, not router Links: on
// the homepage the browser scrolls to them, and anywhere else it loads / and
// then scrolls, which a router Link would not do.
export default function SiteFooter({ compact = false }) {
  const year = new Date().getFullYear();

  if (compact) {
    return (
      <footer className="px-4 pb-8 pt-6 text-center text-xs text-muted">
        <p>Secure payment through Vendwyze</p>
        <nav aria-label="Legal" className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1">
          {COMPACT_LINKS.map((l) => (
            <Link key={l.to} to={l.to} className="hover:text-ink hover:underline">
              {l.label}
            </Link>
          ))}
        </nav>
        <p className="mt-2">© {year} Vendwyze</p>
      </footer>
    );
  }

  const { whatsapp, number, email } = supportContact();
  const open = setupDeepLink();

  return (
    <footer className="border-t border-line bg-surface">
      <div className="mx-auto grid max-w-5xl gap-8 px-4 py-10 sm:grid-cols-2 lg:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div className="sm:col-span-2 lg:col-span-1">
          <Link to="/" aria-label="Vendwyze home" className="inline-block">
            <BrandLockup />
          </Link>
          <p className="mt-3 max-w-xs text-sm leading-relaxed text-muted">
            Run your thrift store or brand from WhatsApp. Listings, your own store page and protected payments, in
            the chat you already use.
          </p>
          {open ? (
            <a
              href={open}
              className="mt-4 inline-flex items-center gap-2 rounded-pill bg-green px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
            >
              <Icon name="whatsapp" className="h-4 w-4" />
              Open your store
            </a>
          ) : null}
        </div>

        {FOOTER_LINKS.map((group) => (
          <nav key={group.title} aria-label={group.title}>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-ink">{group.title}</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {group.links.map((l) => (
                <li key={l.label}>
                  {l.to ? (
                    <Link to={l.to} className="text-muted hover:text-ink">
                      {l.label}
                    </Link>
                  ) : (
                    <a href={l.href} className="text-muted hover:text-ink">
                      {l.label}
                    </a>
                  )}
                </li>
              ))}
            </ul>
            {group.title === 'Company' && (whatsapp || email) ? (
              <ul className="mt-4 space-y-2 text-sm">
                {whatsapp ? (
                  <li>
                    <a href={whatsapp} className="inline-flex items-center gap-1.5 text-muted hover:text-ink">
                      <Icon name="whatsapp" className="h-4 w-4 text-green" />
                      {number ?? 'WhatsApp'}
                    </a>
                  </li>
                ) : null}
                {email ? (
                  <li>
                    <a href={`mailto:${email}`} className="break-all text-muted hover:text-ink">
                      {email}
                    </a>
                  </li>
                ) : null}
              </ul>
            ) : null}
          </nav>
        ))}
      </div>

      <div className="border-t border-line">
        <div className="mx-auto flex max-w-5xl flex-col gap-1 px-4 py-5 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
          <p>© {year} Vendwyze. All rights reserved.</p>
          <p>Payments processed securely by Paystack</p>
        </div>
      </div>
    </footer>
  );
}
