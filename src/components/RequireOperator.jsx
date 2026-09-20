import { useQuery } from '@tanstack/react-query';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext.jsx';
import { whoAmI } from '../lib/admin.js';
import LogoLoader from './ui/LogoLoader.jsx';

// The console's gate.
//
// Note what this is not: it is not the security boundary. That lives in the
// Worker, in requireOperator(), and every /api/admin route enforces it
// independently — editing this component in a browser gets you a console shell
// whose every request returns 403.
//
// What it does is avoid rendering a console to somebody who cannot use it, and
// avoid a dozen screens each discovering that for themselves.
//
// It redirects rather than showing an upsell, unlike RequireFeature: a locked
// tier is something a seller could buy, but being a platform operator is not
// for sale and there is nothing to explain.
export default function RequireOperator({ children }) {
  const { user, loading: authLoading } = useAuth();

  const { data: operator, isLoading } = useQuery({
    queryKey: ['operator', user?.id],
    queryFn: whoAmI,
    enabled: Boolean(user),
    // The answer changes when somebody is granted or revoked, which is rare
    // and never mid-session in a way that matters. Re-asking on every mount
    // would be a request per navigation for a value that does not move.
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  if (authLoading || (user && isLoading)) {
    return <LogoLoader fullScreen label="Checking access" />;
  }

  if (!user) return <Navigate to="/login" replace />;
  if (!operator) return <Navigate to="/dashboard" replace />;

  return children;
}
