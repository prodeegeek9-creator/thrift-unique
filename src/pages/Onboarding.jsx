import { BrandLockup } from '../components/ui/BrandMark.jsx';
import Icon from '../components/ui/Icon.jsx';
import { setupDeepLink } from '../lib/whatsapp.js';

// Where somebody lands with an account but no store.
//
// Most sellers never see this: the WhatsApp bot provisions the tenant, then
// sends them a link that already resolves to a dashboard. This is the web
// half — confirming business details and tier for a seller who signed up here,
// or whose bot session did not finish. Phase 4, with the WAHA layer.
export default function Onboarding() {
  const link = setupDeepLink();

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4">
      <div className="card w-full max-w-sm p-6 text-center">
        <div className="mb-4 flex justify-center">
          <BrandLockup tone="dark" />
        </div>
        <h1 className="font-display text-lg font-semibold">Let's set up your store</h1>
        <p className="mt-2 text-sm text-muted">
          You're signed in, but there's no store attached to this account yet.
          Message us on WhatsApp and we'll walk you through it.
        </p>
        {link ? (
          <a
            href={link}
            className="mt-5 inline-flex items-center gap-2 rounded-pill bg-green px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            <Icon name="whatsapp" className="h-4 w-4" />
            Open WhatsApp
          </a>
        ) : null}
      </div>
    </div>
  );
}
