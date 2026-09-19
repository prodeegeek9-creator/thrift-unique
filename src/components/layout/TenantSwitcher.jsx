import { useState } from 'react';
import Icon from '../ui/Icon.jsx';
import { useTenant } from '../../lib/TenantContext.jsx';

const TIER_LABEL = {
  starter: 'Starter Plan',
  growth: 'Growth Plan',
  business: 'Business Plan',
};

// Which store you are looking at, and — for the majority who only have one —
// a reminder of which plan is paying for it. Renders as a static row rather
// than a menu when there is nothing to switch to, because a dropdown with one
// option is a control that lies about what it does.
export default function TenantSwitcher() {
  const { tenant, memberships, selectTenant } = useTenant();
  const [open, setOpen] = useState(false);

  if (!tenant) return null;
  const switchable = memberships.length > 1;

  return (
    <div className="relative border-t border-white/10 p-3">
      {open && switchable ? (
        <div className="absolute bottom-full left-3 right-3 mb-1 overflow-hidden rounded-lg bg-white shadow-pop">
          {memberships.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                selectTenant(m.id);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13px] hover:bg-surface-2"
            >
              <span className="flex-1 truncate font-medium text-ink">{m.name}</span>
              {m.id === tenant.id ? (
                <Icon name="check" className="h-4 w-4 text-green" />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      <button
        type="button"
        disabled={!switchable}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={switchable ? open : undefined}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left enabled:hover:bg-sidebar-2"
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gold text-xs font-bold text-sidebar">
          {tenant.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[13px] font-medium text-white">
            {tenant.name}
          </span>
          <span className="block truncate text-[11px] text-white/50">
            {TIER_LABEL[tenant.tier] ?? tenant.tier}
          </span>
        </span>
        {switchable ? (
          <Icon name="chevron" className="h-4 w-4 shrink-0 text-white/50" />
        ) : null}
      </button>
    </div>
  );
}
