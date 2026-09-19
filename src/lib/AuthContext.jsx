import { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from './supabase.js';

const AuthContext = createContext({ user: null, loading: true, recovering: false });

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // A password-reset link creates a real session, so nothing downstream can
  // tell it apart from an ordinary sign-in — which is how a reset link ends up
  // silently logging someone in and dropping them on the dashboard with the
  // old password still live. This flag lets the router hold them on the reset
  // screen until they have actually set a new one.
  const [recovering, setRecovering] = useState(false);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setUser(data.session?.user ?? null);
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (event === 'PASSWORD_RECOVERY') setRecovering(true);
      if (event === 'SIGNED_OUT') setRecovering(false);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, recovering, setRecovering }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

export async function signOut() {
  await supabase.auth.signOut();
}
