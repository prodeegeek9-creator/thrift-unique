import { NavLink, Route, Routes } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import Icon from '../../components/ui/Icon.jsx';
import { BrandLockup } from '../../components/ui/BrandMark.jsx';
import { whoAmI } from '../../lib/admin.js';
import { useAuth, signOut } from '../../lib/AuthContext.jsx';

import AdminOverview from './AdminOverview.jsx';
import AdminTenants from './AdminTenants.jsx';
import AdminTenantDetail from './AdminTenantDetail.jsx';
import AdminEscrow from './AdminEscrow.jsx';
import AdminDisputes from './AdminDisputes.jsx';
import AdminAudit from './AdminAudit.jsx';

// The platform side. A deliberately different room from the seller dashboard —
// same tokens, but no tenant switcher, no upgrade nudges, and a banner that
// makes it obvious you are looking at everybody's data rather than one store's.

const NAV = [
  { to: '/admin', icon: 'overview', label: 'Overview', end: true },
  { to: '/admin/tenants', icon: 'team', label: 'Stores' },
  { to: '/admin/escrow', icon: 'payouts', label: 'Release queue' },
  { to: '/admin/disputes', icon: 'disputes', label: 'Disputes' },
  { to: '/admin/audit', icon: 'listings', label: 'Audit log' },
];

export default function AdminRoutes() {
  const { user } = useAuth();
  const { data: operator } = useQuery({
    queryKey: ['operator', user?.id],
    queryFn: whoAmI,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  return (
    <div className="flex min-h-dvh bg-bg">
      <aside className="hidden w-[220px] shrink-0 flex-col bg-sidebar lg:flex">
        <div className="px-5 py-5">
          <BrandLockup />
          <p className="mt-2 rounded-pill bg-gold/20 px-2 py-0.5 text-center text-[10px] font-semibold uppercase tracking-wider text-gold">
            Platform
          </p>
        </div>

        <nav className="flex-1 space-y-1 px-3">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] ${
                  isActive
                    ? 'bg-gold font-semibold text-sidebar'
                    : 'text-sidebar-text hover:bg-sidebar-2'
                }`
              }
            >
              <Icon name={item.icon} className="h-[18px] w-[18px] shrink-0" />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-white/10 p-4">
          <p className="truncate text-[11px] text-white/50">{operator?.email}</p>
          <p className="text-[11px] font-medium capitalize text-white/80">
            {operator?.level ?? '—'}
          </p>
          <NavLink to="/dashboard" className="mt-2 block text-[11px] text-white/50 hover:text-white">
            ← My store
          </NavLink>
          <button
            type="button"
            onClick={signOut}
            className="mt-1 block text-[11px] text-white/50 hover:text-white"
          >
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Said once, plainly, at the top of every screen. Everything below
            spans every tenant on the platform, and forgetting that is how
            somebody quotes one store's numbers as the whole business. */}
        <div className="border-b border-line bg-amber-lt px-4 py-2 text-center text-xs text-amber md:px-6">
          Platform console — this shows every store, not just yours.
        </div>

        <main className="flex-1 px-4 py-5 md:px-6">
          <Routes>
            <Route index element={<AdminOverview />} />
            <Route path="tenants" element={<AdminTenants />} />
            <Route path="tenants/:tenantId" element={<AdminTenantDetail operator={operator} />} />
            <Route path="escrow" element={<AdminEscrow operator={operator} />} />
            <Route path="disputes" element={<AdminDisputes operator={operator} />} />
            <Route path="audit" element={<AdminAudit />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
