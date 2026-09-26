import { NavLink } from 'react-router-dom';
import Icon from '../ui/Icon.jsx';
import TierBadge from '../ui/TierBadge.jsx';
import { BrandLockup } from '../ui/BrandMark.jsx';
import TenantSwitcher from './TenantSwitcher.jsx';
import { useTenant } from '../../lib/TenantContext.jsx';
import { mainNavFor, CHANNEL_NAV, FOOTER_NAV, OPERATOR_NAV } from './navItems.js';
import { useOperator } from '../../lib/useOperator.js';

function NavRow({ item }) {
  const { can } = useTenant();
  const unlocked = !item.flag || can(item.flag);

  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) =>
        [
          'flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] transition-colors',
          isActive
            ? 'bg-gold font-semibold text-sidebar'
            : 'text-sidebar-text hover:bg-sidebar-2',
          // A locked row is dimmed but still reachable. The point of showing
          // it is that it can be clicked — the page behind it sells the tier.
          unlocked ? '' : 'opacity-70',
        ].join(' ')
      }
    >
      <Icon name={item.icon} className="h-[18px] w-[18px] shrink-0" />
      <span className="flex-1 truncate">{item.label}</span>
      <TierBadge flag={item.flag} unlocked={unlocked} />
    </NavLink>
  );
}

export default function Sidebar() {
  const { tenant } = useTenant();
  const operator = useOperator();
  return (
    <aside className="hidden w-[232px] shrink-0 flex-col bg-sidebar lg:flex">
      <div className="px-5 py-5">
        <BrandLockup />
      </div>

      <nav className="scroll-thin flex-1 space-y-1 overflow-y-auto px-3 pb-4">
        {mainNavFor(tenant).map((item) => (
          <NavRow key={item.to} item={item} />
        ))}

        <p className="px-3 pb-1 pt-5 text-[10px] font-semibold uppercase tracking-wider text-white/35">
          Channels
        </p>
        {CHANNEL_NAV.map((item) => (
          <NavRow key={item.to} item={item} />
        ))}

        <div className="my-4 border-t border-white/10" />
        {FOOTER_NAV.map((item) => (
          <NavRow key={item.to} item={item} />
        ))}
        {operator ? <NavRow item={OPERATOR_NAV} /> : null}
      </nav>

      {/* The tenant switcher sits in the sidebar footer, which is where the
          mockups put it — and where it belongs, since it changes the meaning
          of every item above it. */}
      <TenantSwitcher />
    </aside>
  );
}
