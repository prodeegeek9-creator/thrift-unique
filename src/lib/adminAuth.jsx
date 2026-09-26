import { createContext, useContext, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { consoleSupabase, onConsole, linkType } from './supabase.js';

// The platform console's own sign-in.
//
// The console is not a room inside a store: it is where the platform itself is
// run, by the admin team. So it keeps its own session, in its own storage key,
// with its own login screen at /admin/login. Being signed in to a store says
// nothing here, and signing out of the console leaves the store signed in.
//
// This decides what to draw, as before. The boundary is still requireOperator
// in the Worker, which every /api/admin route checks for itself.

const ConsoleAuthContext = createContext({ user: null, loading: true, recovering: false });

export function ConsoleAuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  // An invitation or new sign-in link from the Admin team page signs the
  // person in before they have a password; they choose one first.
  const [recovering, setRecovering] = useState(
    onConsole && (linkType === 'invite' || linkType === 'recovery')
  );

  useEffect(() => {
    let active = true;

    consoleSupabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setUser(data.session?.user ?? null);
      setLoading(false);
    });

    const { data: sub } = consoleSupabase.auth.onAuthStateChange((event, session) => {
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
    <ConsoleAuthContext.Provider value={{ user, loading, recovering, setRecovering }}>
      {children}
    </ConsoleAuthContext.Provider>
  );
}

export function useConsoleAuth() {
  return useContext(ConsoleAuthContext);
}

// Signs out of the console only, and forgets everything it loaded.
export function useConsoleSignOut() {
  const qc = useQueryClient();
  return async () => {
    await consoleSupabase.auth.signOut();
    qc.removeQueries({ queryKey: ['admin'] });
  };
}
