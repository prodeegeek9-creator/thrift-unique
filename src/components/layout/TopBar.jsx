import Icon from '../ui/Icon.jsx';
import { useAuth, signOut } from '../../lib/AuthContext.jsx';
import { initialsOf } from '../../lib/privacy.js';
import { useTenant } from '../../lib/TenantContext.jsx';

const ROLE_LABEL = {
  owner: 'Store Owner',
  manager: 'Manager',
  staff: 'Staff',
};

export default function TopBar() {
  const { user } = useAuth();
  const { role } = useTenant();
  const name = user?.user_metadata?.name || user?.email?.split('@')[0] || 'there';

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-line bg-bg/90 px-4 backdrop-blur md:px-6">
      <label className="relative hidden max-w-md flex-1 md:block">
        <Icon
          name="search"
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
        />
        <span className="sr-only">Search</span>
        <input
          type="search"
          placeholder="Search anything…"
          className="w-full rounded-pill border border-line bg-surface py-2 pl-9 pr-4 text-sm outline-none placeholder:text-muted focus:border-green/40"
        />
      </label>

      <div className="flex-1 md:hidden" />

      <button
        type="button"
        className="relative grid h-9 w-9 place-items-center rounded-full hover:bg-overlay"
        aria-label="Notifications"
      >
        <Icon name="bell" className="h-5 w-5 text-ink" />
        <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-amber ring-2 ring-bg" />
      </button>

      <div className="flex items-center gap-2.5 rounded-pill border border-line bg-surface py-1 pl-1 pr-3">
        <span className="grid h-7 w-7 place-items-center rounded-full bg-green-lt text-[11px] font-semibold text-green">
          {initialsOf(name)}
        </span>
        <span className="hidden leading-tight sm:block">
          <span className="block text-[13px] font-medium text-ink">{name}</span>
          <span className="block text-[11px] text-muted">
            {ROLE_LABEL[role] ?? 'Member'}
          </span>
        </span>
        <button
          type="button"
          onClick={signOut}
          className="text-[11px] font-medium text-muted hover:text-ink"
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
