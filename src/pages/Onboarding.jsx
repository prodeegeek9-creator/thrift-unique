import { BrandLockup } from '../components/ui/BrandMark.jsx';

// Where somebody lands with an account but no store.
//
// Most sellers never see this: the WhatsApp bot provisions the tenant, then
// sends them a link that already resolves to a dashboard. This is the web
// half — confirming business details and tier for a seller who signed up here,
// or whose bot session did not finish. Phase 4, with the WAHA layer.
export default function Onboarding() {
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
      </div>
    </div>
  );
}
