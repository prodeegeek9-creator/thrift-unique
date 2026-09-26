import { useQuery } from '@tanstack/react-query';
import { useAuth } from './AuthContext.jsx';
import { whoAmI } from './admin.js';

// Whether the signed-in person runs the platform, for drawing the way into the
// operator console. The same query, key and caching as RequireOperator, so
// asking here costs nothing extra there. null for everybody else.
//
// Only decides what to draw. The console's routes check again, server side.
export function useOperator() {
  const { user } = useAuth();
  const { data } = useQuery({
    queryKey: ['operator', user?.id],
    queryFn: whoAmI,
    enabled: Boolean(user),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  return data ?? null;
}
