import { useTenant } from '../lib/TenantContext.jsx';
import FeatureUpsell from '../pages/FeatureUpsell.jsx';

// Three roles, fixed, from the Team screen: owner has full access, manager has
// listings/orders/customers, staff has listings only. A fixed enum rather than
// a permission matrix because that is what the design shows, and because a
// matrix nobody asked for is a schema you have to keep honest forever.
//
// Server side the same three roles appear in the RLS policies via
// has_tenant_role(). This component only decides whether to draw the screen.
const RANK = { staff: 0, manager: 1, owner: 2 };

export default function RequireStaffRole({ min = 'manager', children }) {
  const { role, loading } = useTenant();

  if (loading) return null;

  if ((RANK[role] ?? -1) < (RANK[min] ?? 0)) {
    // Not an upsell — no plan fixes this, only the store owner can. Reusing
    // the page for its layout, with a message that says so.
    return (
      <FeatureUpsell
        title="You don't have access to this"
        body={`This section is open to ${min === 'owner' ? 'the store owner' : 'managers and the store owner'}. Ask whoever runs the store to change your role under Team.`}
      />
    );
  }

  return children;
}
