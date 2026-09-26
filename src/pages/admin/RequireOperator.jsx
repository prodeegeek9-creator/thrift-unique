import { useQuery } from '@tanstack/react-query';
import { Navigate, useLocation } from 'react-router-dom';
import { useConsoleAuth } from '../../lib/adminAuth.jsx';
import { whoAmI } from '../../lib/admin.js';
import LogoLoader from '../../components/ui/LogoLoader.jsx';

// The console's gate.
//
// Note what this is not: it is not the security boundary. That lives in the
// Worker, in requireOperator(), and every /api/admin route enforces it
// independently — editing this component in a browser gets you a console shell
// whose every request returns 403.
//
// What it does is send anybody not signed in to the console, or not on the
// admin team, to /admin/login, and avoid a dozen screens each discovering that
// for themselves. The session is the console's own (src/lib/adminAuth.jsx), so
// a store's sign-in never gets anybody past here.

// Who the console's session belongs to, per the Worker: { level, email,
// user_id } for the admin team, null for everybody else.
export function useOperatorCheck() {
  const { user } = useConsoleAuth();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin', 'me', user?.id],
    queryFn: whoAmI,
    enabled: Boolean(user),
    // Granting or removing somebody is rare and never mid-session in a way
    // that matters; asking on every navigation would be a request per click.
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  return {
    operator: user ? data ?? null : null,
    checking: Boolean(user) && isLoading,
    // whoAmI answers null for "not on the team"; an error is the Worker or the
    // network failing, which is not the same thing and should not read as it.
    failed: Boolean(user && error),
    retry: refetch,
  };
}

export default function RequireOperator({ children }) {
  const { user, loading, recovering } = useConsoleAuth();
  const { operator, checking } = useOperatorCheck();
  const location = useLocation();

  if (loading || checking) return <LogoLoader fullScreen label="Checking access" />;

  if (!user || recovering || !operator) {
    return <Navigate to="/admin/login" replace state={{ from: location.pathname }} />;
  }

  return typeof children === 'function' ? children(operator) : children;
}
