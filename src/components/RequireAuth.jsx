import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext.jsx';
import { useTenant } from '../lib/TenantContext.jsx';
import LogoLoader from './ui/LogoLoader.jsx';

// Signed in, and belonging to at least one business.
//
// The second half matters as much as the first: a seller finishes the
// WhatsApp onboarding flow before a dashboard login exists, and somebody who
// signs up on the web without a tenant has an account but no store. They go to
// onboarding rather than to an empty dashboard that looks broken.
export default function RequireAuth({ children }) {
  const { user, loading: authLoading } = useAuth();
  const { memberships, loading: tenantLoading } = useTenant();
  const location = useLocation();

  if (authLoading || tenantLoading) {
    return <LogoLoader fullScreen label="Opening your store" />;
  }

  if (!user) {
    // Remember where they were headed, so a bookmarked order link survives a
    // sign-in instead of dumping them on the overview.
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (!memberships.length) {
    return <Navigate to="/onboarding" replace />;
  }

  return children;
}
