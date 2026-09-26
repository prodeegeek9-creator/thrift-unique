import { Link } from 'react-router-dom';
import PageHeader from '../../components/ui/PageHeader.jsx';
import Icon from '../../components/ui/Icon.jsx';
import TierBadge from '../../components/ui/TierBadge.jsx';
import { useTenant } from '../../lib/TenantContext.jsx';
import { signOut } from '../../lib/AuthContext.jsx';
import { mainNavFor, CHANNEL_NAV, FOOTER_NAV, TAB_NAV } from '../../components/layout/navItems.js';

// Everything the five-slot tab bar cannot hold.
//
// The locked items appear here too, with their tier badge, for the same reason
// they appear in the desktop sidebar: a locked feature is the only place most
// Starter sellers will ever learn the higher tiers exist. Hiding them on
// mobile would hide them from most of the people using this.
export default function More() {
  const { can, tenant } = useTenant();
  const inTabBar = new Set(TAB_NAV.map((t) => t.to));

  const sections = [
    { title: 'Your store', items: mainNavFor(tenant).filter((i) => !inTabBar.has(i.to)) },
    { title: 'Channels', items: CHANNEL_NAV },
    { title: 'Account', items: FOOTER_NAV },
  ];

  return (
    <>
      <PageHeader title="More" subtitle={tenant?.name} />

      <div className="space-y-4">
        {sections.map((section) => (
          <section key={section.title} className="card divide-y divide-line overflow-hidden">
            <h2 className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
              {section.title}
            </h2>
            {section.items.map((item) => {
              const unlocked = !item.flag || can(item.flag);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={`flex items-center gap-3 px-4 py-3 ${unlocked ? '' : 'opacity-70'}`}
                >
                  <Icon name={item.icon} className="h-[18px] w-[18px] shrink-0 text-muted" />
                  <span className="flex-1 text-sm text-ink">{item.label}</span>
                  <TierBadge flag={item.flag} unlocked={unlocked} />
                  <Icon name="chevron" className="h-4 w-4 -rotate-90 text-muted" />
                </Link>
              );
            })}
          </section>
        ))}

        <button
          type="button"
          onClick={signOut}
          className="card w-full p-4 text-sm font-medium text-red"
        >
          Sign out
        </button>
      </div>
    </>
  );
}
