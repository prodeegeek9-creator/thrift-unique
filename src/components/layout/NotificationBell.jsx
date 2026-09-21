import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import Icon from '../ui/Icon.jsx';
import { useTenant } from '../../lib/TenantContext.jsx';
import { fetchNotifications, unreadCount } from '../../lib/notifications.js';

// The bell, doing something.
//
// It was a <button> with no onClick and a dot that was always lit, which is
// worse than having no bell: a permanent unread badge teaches people to stop
// looking at the one place the app has to interrupt them.

const TONE = {
  bad: 'bg-red-lt text-red',
  warn: 'bg-amber-lt text-amber',
  good: 'bg-green-lt text-green',
  info: 'bg-surface-2 text-muted',
};

export default function NotificationBell() {
  const { tenant } = useTenant();
  const tenantId = tenant?.id;

  const [open, setOpen] = useState(false);
  const wrap = useRef(null);

  const { data: items, isLoading } = useQuery({
    queryKey: ['tenant', tenantId, 'notifications'],
    queryFn: () => fetchNotifications(tenantId, tenant),
    enabled: Boolean(tenantId),
    // Derived from live rows, so it is worth re-reading now and then — but
    // not often enough to be a poller. A dispute that shows up two minutes
    // late is fine; one that never shows up is not.
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
  });

  const unread = unreadCount(items);

  useEffect(() => {
    if (!open) return undefined;

    function onPointer(e) {
      if (!wrap.current?.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === 'Escape') setOpen(false);
    }

    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={wrap}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative grid h-9 w-9 place-items-center rounded-full hover:bg-overlay"
        aria-label={unread ? `Notifications, ${unread} need attention` : 'Notifications'}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon name="bell" className="h-5 w-5 text-ink" />
        {/* Only when something actually needs doing. */}
        {unread > 0 ? (
          <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-amber ring-2 ring-bg" />
        ) : null}
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-11 z-40 w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-card border border-line bg-surface shadow-lg"
        >
          <p className="border-b border-line px-4 py-2.5 text-xs font-semibold text-ink">
            Needs your attention
          </p>

          {isLoading ? (
            <div className="space-y-2 p-4">
              <div className="h-10 animate-pulse rounded-lg bg-surface-2" />
              <div className="h-10 animate-pulse rounded-lg bg-surface-2" />
            </div>
          ) : !items?.length ? (
            <p className="px-4 py-8 text-center text-sm text-muted">
              Nothing needs you right now.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {items.map((item) => (
                <li key={item.id}>
                  <Link
                    to={item.to}
                    role="menuitem"
                    onClick={() => setOpen(false)}
                    className="flex gap-3 p-3.5 hover:bg-surface-2"
                  >
                    <span
                      className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${TONE[item.tone] ?? TONE.info}`}
                    >
                      <Icon name={item.icon} className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 leading-tight">
                      <span className="block text-[13px] font-medium text-ink">{item.title}</span>
                      <span className="mt-0.5 block text-xs text-muted">{item.body}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
