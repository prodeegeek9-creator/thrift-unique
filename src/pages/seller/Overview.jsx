import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import Icon from '../../components/ui/Icon.jsx';
import StatTile from '../../components/ui/StatTile.jsx';
import StatusPill from '../../components/ui/StatusPill.jsx';
import EmptyState, { LoadingRows } from '../../components/ui/EmptyState.jsx';
import { useAuth } from '../../lib/AuthContext.jsx';
import { useTenant } from '../../lib/TenantContext.jsx';
import { fetchOverview, snoozeNudge, nudgeSnoozed } from '../../lib/dashboard.js';
import { fetchNudge } from '../../lib/billing.js';
import { listingDeepLink, botConfigured } from '../../lib/whatsapp.js';
import { formatNaira, formatDelta } from '../../lib/money.js';
import { maskPhone, shortName } from '../../lib/privacy.js';
import { dateTime } from '../../lib/time.js';
import { keys } from '../../lib/queryKeys.js';

const TIER_LABEL = { starter: 'Starter Plan', growth: 'Growth Plan', business: 'Business Plan' };

export default function Overview() {
  const { user } = useAuth();
  const { tenant } = useTenant();
  const tenantId = tenant?.id;
  const [nudgeDismissed, setNudgeDismissed] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: keys.overview(tenantId),
    queryFn: () => fetchOverview(tenantId),
    enabled: Boolean(tenantId),
  });

  const { data: nudgeData } = useQuery({
    queryKey: [...keys.usage(tenantId), 'nudge'],
    queryFn: () => fetchNudge(tenantId),
    enabled: Boolean(tenantId) && !nudgeSnoozed(tenantId),
    staleTime: 10 * 60 * 1000,
  });

  const nudge = nudgeDismissed ? null : nudgeData?.nudge ?? null;
  const name = user?.user_metadata?.name || user?.email?.split('@')[0] || 'there';

  return (
    <>
      <div className="mb-5">
        <h1 className="font-display text-xl font-semibold text-ink">
          {greeting()}, {name} <span aria-hidden="true">👋</span>
        </h1>
        <p className="mt-0.5 text-sm text-muted">
          Here's what's happening with your store today.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <StoreCard tenant={tenant} />

          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <StatTile
              icon="listings"
              label="Active Listings"
              value={isLoading ? '—' : data?.activeListings ?? 0}
              delta={data?.newListingsThisWeek ? `+${data.newListingsThisWeek} this week` : null}
            />
            <StatTile
              icon="orders"
              label="Sold This Month"
              value={isLoading ? '—' : data?.soldThisMonth ?? 0}
              delta={data?.soldThisWeek ? `+${data.soldThisWeek} this week` : null}
              tone="amber"
            />
            <StatTile
              icon="analytics"
              label="Total Sales"
              value={isLoading ? '—' : formatNaira(data?.totalSales ?? 0)}
              delta={
                data?.salesDeltaPct != null
                  ? `${formatDelta(data.salesDeltaPct)} this month`
                  : null
              }
            />
            <StatTile
              icon="payouts"
              label="Available Balance"
              value={isLoading ? '—' : formatNaira(data?.availableBalance ?? 0)}
              note={data?.nextPayoutNote ? `Next payout: ${data.nextPayoutNote}` : 'Ready to pay out'}
            />
          </div>

          <RecentOrders orders={data?.recentOrders} loading={isLoading} />
        </div>

        <div className="space-y-4">
          <QuickActions tenant={tenant} />
          {nudge ? (
            <UpgradeNudge
              nudge={nudge}
              onSnooze={() => {
                snoozeNudge(tenantId);
                setNudgeDismissed(true);
              }}
            />
          ) : null}
        </div>
      </div>
    </>
  );
}

function StoreCard({ tenant }) {
  const link = listingDeepLink(tenant);

  return (
    <div className="overflow-hidden rounded-card bg-sidebar p-5 text-white">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-lg font-semibold text-white">{tenant?.name ?? 'Your store'}</h2>
        <span className="rounded-pill bg-white/10 px-2 py-0.5 text-[11px] font-medium">
          {TIER_LABEL[tenant?.tier] ?? tenant?.tier}
        </span>
      </div>

      <p className="mt-1 flex items-center gap-1.5 text-xs text-white/60">
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            tenant?.status === 'active' ? 'bg-green' : 'bg-amber'
          }`}
        />
        {tenant?.status === 'active' ? 'Active' : tenant?.status}
      </p>

      <p className="mt-3 max-w-md text-sm leading-relaxed text-white/75">
        {tenant?.waha_session
          ? 'Your store is live on WhatsApp. Keep adding products to grow your reach.'
          : 'Your store is set up. Connect WhatsApp to start listing from your phone.'}
      </p>

      {link ? (
        <a
          href={link}
          className="mt-4 inline-flex items-center gap-2 rounded-pill bg-green px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
        >
          <Icon name="plus" className="h-4 w-4" />
          Add Product
        </a>
      ) : (
        <Link
          to="/dashboard/listings"
          className="mt-4 inline-flex items-center gap-2 rounded-pill bg-green px-4 py-2 text-sm font-semibold text-white"
        >
          <Icon name="plus" className="h-4 w-4" />
          Add Product
        </Link>
      )}
    </div>
  );
}

function QuickActions({ tenant }) {
  const link = listingDeepLink(tenant);

  const actions = [
    {
      icon: 'plus',
      title: 'Add Product',
      body: botConfigured() ? 'List a new item on WhatsApp' : 'List a new item',
      href: link,
      to: link ? null : '/dashboard/listings',
    },
    { icon: 'orders', title: 'View Orders', body: 'Check recent orders and status', to: '/dashboard/orders' },
    { icon: 'payouts', title: 'Check Payouts', body: 'See your balance and history', to: '/dashboard/payouts' },
  ];

  return (
    <div className="card p-4">
      <h2 className="mb-3 text-sm font-semibold text-ink">Quick Actions</h2>
      <div className="space-y-1">
        {actions.map((a) => {
          const inner = (
            <>
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-green-lt text-green">
                <Icon name={a.icon} className="h-4 w-4" />
              </span>
              <span className="min-w-0 leading-tight">
                <span className="block text-[13px] font-medium text-ink">{a.title}</span>
                <span className="block truncate text-[11px] text-muted">{a.body}</span>
              </span>
            </>
          );
          const cls = 'flex w-full items-center gap-3 rounded-lg p-2 text-left hover:bg-surface-2';

          return a.href ? (
            <a key={a.title} href={a.href} className={cls}>{inner}</a>
          ) : (
            <Link key={a.title} to={a.to} className={cls}>{inner}</Link>
          );
        })}
      </div>
    </div>
  );
}

function UpgradeNudge({ nudge, onSnooze }) {
  return (
    <div className="rounded-card border border-green/20 bg-green-lt p-4">
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-green/15 text-green">
        <Icon name="analytics" className="h-4 w-4" />
      </span>
      <p className="mt-3 text-sm font-semibold text-ink">{nudge.headline}</p>
      <p className="mt-1 text-xs leading-relaxed text-text">{nudge.body}</p>
      <Link
        to={`/dashboard/billing?plan=${nudge.tier}`}
        className="mt-3 block rounded-pill bg-green py-2 text-center text-xs font-semibold text-white"
      >
        See {nudge.tier === 'growth' ? 'Growth' : 'Business'} plan
      </Link>
      <p className="mt-2 text-center text-[11px] text-muted">
        You only pay the difference for the rest of this month.
      </p>
      <button
        type="button"
        onClick={onSnooze}
        className="mt-2 w-full text-center text-[11px] text-muted hover:text-ink"
      >
        Remind me later
      </button>
    </div>
  );
}

function RecentOrders({ orders, loading }) {
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Recent Orders</h2>
        <Link to="/dashboard/orders" className="text-xs font-medium text-green hover:underline">
          View all →
        </Link>
      </div>

      {loading ? (
        <LoadingRows className="p-4" />
      ) : !orders?.length ? (
        <p className="px-4 py-10 text-center text-sm text-muted">
          No orders yet. They'll appear here as buyers pay.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-muted">
                <th className="px-4 py-2 font-medium">#</th>
                <th className="px-4 py-2 font-medium">Product</th>
                <th className="px-4 py-2 font-medium">Buyer</th>
                <th className="px-4 py-2 font-medium">Amount</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Date</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-b border-line/60 last:border-0">
                  <td className="whitespace-nowrap px-4 py-3 font-medium text-ink">
                    <Link to={`/dashboard/orders/${o.id}`} className="hover:underline">
                      {o.order_code}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{o.product?.title ?? '—'}</td>
                  {/* Masked here as everywhere: see lib/privacy.js */}
                  <td className="whitespace-nowrap px-4 py-3 text-muted">
                    {o.buyer?.name ? shortName(o.buyer.name, 14) : maskPhone(o.buyer?.phone)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 font-medium">
                    {formatNaira(o.amount)}
                  </td>
                  <td className="px-4 py-3"><StatusPill status={o.status} /></td>
                  <td className="whitespace-nowrap px-4 py-3 text-muted">{dateTime(o.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

