import { useTenant } from '../lib/TenantContext.jsx';
import FeatureUpsell from '../pages/FeatureUpsell.jsx';

// The guard that does NOT redirect.
//
// Automate Naija's RequireTrack and RequireAdmin send you somewhere else, which
// is right when a route is none of your business. This one is the opposite
// case: a locked feature is something the seller could buy, and the mockups
// treat every lock as a place to explain that. So the route resolves, the URL
// stays, and the page renders an upsell describing the tier that unlocks it.
//
// Nothing here is security. It decides what to draw. The rows behind an
// Analytics page a Starter tenant is not entitled to are refused by RLS, and
// the publish a locked channel would attempt is refused by the Worker — both
// of which keep working whether or not this component is in the tree.
export default function RequireFeature({ flag, children }) {
  const { can, loading } = useTenant();

  if (loading) return null;
  if (!can(flag)) return <FeatureUpsell flag={flag} />;

  return children;
}
