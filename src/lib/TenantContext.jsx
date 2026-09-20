import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase.js';
import { useAuth } from './AuthContext.jsx';
import { hasFeature } from './features.js';

// Which business the signed-in person is currently acting as.
//
// Resolved once from tenant_members, never from a URL parameter. That is the
// whole rule: a tenant id the client chooses is not tenancy, it is a request,
// and a request is exactly what an attacker also gets to make. The database
// decides independently through current_tenant_ids() in its RLS policies, and
// the Worker decides a third time, in worker/lib/orders.js, for the writes that
// run under the service key. Three layers, because the two that live in this
// bundle are both editable by whoever is holding the laptop.
//
// The selection below only picks which of *your own* memberships is in front
// of you. Choosing one you do not hold gets you a tenant whose every query
// returns nothing.

const TenantContext = createContext(null);

const STORAGE_KEY = 'ut-tenant';

export function TenantProvider({ children }) {
  const { user, loading: authLoading } = useAuth();
  const [memberships, setMemberships] = useState([]);
  const [activeId, setActiveId] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || null;
    } catch {
      // Private windows and blocked site data both throw here. A remembered
      // tenant is a convenience; losing it just means defaulting to the first.
      return null;
    }
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setMemberships([]);
      setLoading(false);
      return;
    }

    let active = true;
    (async () => {
      // Deliberately not select('*') on tenants. The row also carries the WAHA
      // session name, the Paystack subaccount and the commission rate the
      // platform negotiated — none of which belong in a bundle, and two of
      // which are credentials by any useful definition.
      const { data, error } = await supabase
        .from('tenant_members')
        .select(
          'role, tenant:tenants!inner(' +
            'id, slug, name, tier, status, logo_url, brand_color, ' +
            'whatsapp_number, commission_pct, created_at' +
          ')'
        )
        .eq('user_id', user.id);

      if (!active) return;
      if (error) {
        setMemberships([]);
        setLoading(false);
        return;
      }

      // Flags are rows, not a derived property of the tier — the platform
      // console can switch one on for a single tenant without moving them up a
      // plan. Fetched alongside so hasFeature() has both to work with.
      const ids = (data ?? []).map((m) => m.tenant.id);
      const { data: flags } = ids.length
        ? await supabase
            .from('tenant_features')
            .select('tenant_id, flag, enabled')
            .in('tenant_id', ids)
        : { data: [] };

      if (!active) return;

      const byTenant = {};
      for (const row of flags ?? []) {
        (byTenant[row.tenant_id] ||= {})[row.flag] = row.enabled;
      }

      setMemberships(
        (data ?? []).map((m) => ({
          ...m.tenant,
          role: m.role,
          features: byTenant[m.tenant.id] ?? {},
        }))
      );
      setLoading(false);
    })();

    return () => {
      active = false;
    };
  }, [user, authLoading]);

  const tenant = useMemo(() => {
    if (!memberships.length) return null;
    return memberships.find((t) => t.id === activeId) ?? memberships[0];
  }, [memberships, activeId]);

  const selectTenant = useCallback((id) => {
    setActiveId(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // See above — not remembering is a fine outcome.
    }
  }, []);

  const value = useMemo(
    () => ({
      tenant,
      memberships,
      loading: authLoading || loading,
      selectTenant,
      role: tenant?.role ?? null,
      can: (flag) => hasFeature(tenant, flag),
    }),
    [tenant, memberships, authLoading, loading, selectTenant]
  );

  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}

export function useTenant() {
  const ctx = useContext(TenantContext);
  if (!ctx) throw new Error('useTenant must be used inside <TenantProvider>');
  return ctx;
}

// Sugar for the common case, so a component that only wants to know whether to
// render a lock does not have to destructure the whole context.
export function useFeature(flag) {
  return useTenant().can(flag);
}
