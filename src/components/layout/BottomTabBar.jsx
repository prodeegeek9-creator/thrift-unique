import { NavLink } from 'react-router-dom';
import Icon from '../ui/Icon.jsx';
import { TAB_NAV } from './navItems.js';

// Five slots, phone only. Every tab here is unlocked at every tier on purpose
// — a thumb-reach bar is not where an upsell belongs, and the locked features
// are all things a seller opens from More or from the desktop sidebar.
export default function BottomTabBar() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden">
      {TAB_NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            `flex flex-1 flex-col items-center gap-1 py-2.5 text-[10px] ${
              isActive ? 'text-green' : 'text-muted'
            }`
          }
        >
          <Icon name={item.icon} className="h-5 w-5" />
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
