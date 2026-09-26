import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import Icon from '../../components/ui/Icon.jsx';
import { BrandLockup } from '../../components/ui/BrandMark.jsx';
import { ConsoleAuthProvider, useConsoleAuth, useConsoleSignOut } from '../../lib/adminAuth.jsx';
import { consoleSupabase } from '../../lib/supabase.js';
import { WelcomeScreen } from '../Welcome.jsx';

import RequireOperator from './RequireOperator.jsx';
import AdminLogin, { ConsoleBadge } from './AdminLogin.jsx';
import AdminOverview from './AdminOverview.jsx';
import AdminTenants from './AdminTenants.jsx';
import AdminTenantDetail from './AdminTenantDetail.jsx';
import AdminEscrow from './AdminEscrow.jsx';
import AdminDisputes from './AdminDisputes.jsx';
import AdminAudit from './AdminAudit.jsx';
import AdminTeam from './AdminTeam.jsx';
import AdminRefunds from './AdminRefunds.jsx';

// The platform side. A different room from the seller dashboard, reached by a
// different door: its own login, its own session, and no way across to a
// store's dashboard. Same tokens, but no tenant switcher, no upgrade nudges,
// and a banner that makes it obvious you are looking at everybody's data.

const NAV = [
  { to: '/admin', icon: 'overview', label: 'Overview', end: true },
  { to: '/admin/tenants', icon: 'team', label: 'Stores' },
  { to: '/admin/escrow', icon: 'payouts', label: 'Release queue' },
  { to: '/admin/disputes', icon: 'disputes', label: 'Disputes' },
  { to: '/admin/refunds', icon: 'billing', label: 'Refunds' },
  { to: '/admin/audit', icon: 'listings', label: 'Audit log' },
  { to: '/admin/team', icon: 'contacts', label: 'Admin team' },
];

export default function AdminRoutes() {
  return (
    <ConsoleAuthProvider>
      <Routes>
        <Route path="login" element={<AdminLogin />} />
        <Route path="welcome" element={<ConsoleWelcome />} />
        <Route
          path="*"
          element={<RequireOperator>{(operator) => <Console operator={operator} />}</RequireOperator>}
        />
      </Routes>
    </ConsoleAuthProvider>
  );
}

// An admin team invitation or new sign-in link, redeemed into the console's
// own session when they press Continue.
function ConsoleWelcome() {
  const { setRecovering } = useConsoleAuth();
  const navigate = useNavigate();
  return (
    <WelcomeScreen
      client={consoleSupabase}
      dark
      badge={<ConsoleBadge />}
      help="Ask a platform owner for a new sign-in link."
      onVerified={() => {
        setRecovering(true);
        navigate('/admin/login', { replace: true });
      }}
    />
  );
}

function Console({ operator }) {
  const signOut = useConsoleSignOut();

  return (
    <div className="flex min-h-dvh bg-bg">
      <aside className="hidden w-[220px] shrink-0 flex-col bg-sidebar lg:flex">
        <div className="px-5 py-5">
          <BrandLockup />
          <p className="mt-2 rounded-pill bg-gold/20 px-2 py-0.5 text-center text-[10px] font-semibold uppercase tracking-wider text-gold">
            Platform console
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
                  isActive ? 'bg-gold font-semibold text-sidebar' : 'text-sidebar-text hover:bg-sidebar-2'
                }`
              }
            >
              <Icon name={item.icon} className="h-[18px] w-[18px] shrink-0" />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-white/10 p-4">
          <p className="truncate text-[11px] text-white/50">{operator.email}</p>
          <p className="text-[11px] font-medium capitalize text-white/80">{operator.level}</p>
          <button
            type="button"
            onClick={signOut}
            className="mt-2 block text-[11px] text-white/50 hover:text-white"
          >
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Phones: the same sections as a scrolling row, and sign-out in reach. */}
        <header className="bg-sidebar lg:hidden">
          <div className="flex items-center justify-between px-4 pb-2 pt-3">
            <div className="flex items-center gap-2">
              <BrandLockup />
              <span className="rounded-pill bg-gold/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-gold">
                Console
              </span>
            </div>
            <button type="button" onClick={signOut} className="text-xs text-white/60 hover:text-white">
              Sign out
            </button>
          </div>
          <nav className="scroll-thin flex gap-1 overflow-x-auto px-3 pb-3">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `shrink-0 rounded-pill px-3 py-1.5 text-xs ${
                    isActive ? 'bg-gold font-semibold text-sidebar' : 'text-sidebar-text'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </header>

        {/* Said once, plainly, at the top of every screen. Everything below
            spans every tenant on the platform, and forgetting that is how
            somebody quotes one store's numbers as the whole business. */}
        <div className="border-b border-line bg-amber-lt px-4 py-2 text-center text-xs text-amber md:px-6">
          Platform console — this shows every store on the platform.
        </div>

        <main className="flex-1 px-4 py-5 md:px-6">
          <Routes>
            <Route index element={<AdminOverview />} />
            <Route path="tenants" element={<AdminTenants />} />
            <Route path="tenants/:tenantId" element={<AdminTenantDetail operator={operator} />} />
            <Route path="escrow" element={<AdminEscrow operator={operator} />} />
            <Route path="disputes" element={<AdminDisputes operator={operator} />} />
            <Route path="refunds" element={<AdminRefunds operator={operator} />} />
            <Route path="audit" element={<AdminAudit />} />
            <Route path="team" element={<AdminTeam operator={operator} />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
