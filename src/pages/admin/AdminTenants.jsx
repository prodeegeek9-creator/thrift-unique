import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import PageHeader from '../../components/ui/PageHeader.jsx';
import StatusPill from '../../components/ui/StatusPill.jsx';
import { LoadingRows } from '../../components/ui/EmptyState.jsx';
import { fetchTenants } from '../../lib/admin.js';
import { formatNaira } from '../../lib/money.js';
import { dateOnly } from '../../lib/time.js';

const TIER_TONE = {
  starter: 'bg-surface-2 text-muted',
  growth: 'bg-tier-growth-lt text-tier-growth',
  business: 'bg-tier-business-lt text-tier-business',
};

// The status chips. "WhatsApp down" is a store whose own number was linked
// and has since stopped working: it is still live, and quietly reaching nobody.
const FILTERS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'onboarding', label: 'Awaiting approval', test: (t) => t.status === 'onboarding' },
  { id: 'active', label: 'Active', test: (t) => t.status === 'active' },
  { id: 'suspended', label: 'Suspended', test: (t) => t.status === 'suspended' },
  { id: 'whatsapp', label: 'WhatsApp down', test: (t) => whatsappBroken(t) },
];

export function whatsappBroken(t) {
  return Boolean(t.waha_session) && !['WORKING', 'STARTING', 'SCAN_QR_CODE'].includes(t.waha_status);
}

export default function AdminTenants() {
  const { data: tenants, isLoading } = useQuery({
    queryKey: ['admin', 'tenants'],
    queryFn: fetchTenants,
  });
  // ?filter=whatsapp, from the Overview's "Needs attention" rows.
  const [params] = useSearchParams();
  const [filter, setFilter] = useState(() =>
    FILTERS.some((f) => f.id === params.get('filter')) ? params.get('filter') : 'all'
  );
  const [plan, setPlan] = useState('all');
  const [search, setSearch] = useState('');

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    const test = FILTERS.find((f) => f.id === filter)?.test ?? (() => true);
    return (tenants ?? []).filter(
      (t) =>
        test(t) &&
        (plan === 'all' || t.tier === plan) &&
        (!q ||
          t.name?.toLowerCase().includes(q) ||
          t.slug?.includes(q) ||
          (digits.length >= 4 && String(t.whatsapp_number ?? '').includes(digits.replace(/^0/, ''))))
    );
  }, [tenants, filter, plan, search]);

  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f.id, (tenants ?? []).filter(f.test).length])),
    [tenants]
  );

  return (
    <>
      <PageHeader
        title="Stores"
        subtitle={tenants ? `${tenants.length} on the platform` : 'Every tenant.'}
      />

      <div className="mb-4 space-y-3">
        <div className="flex flex-wrap gap-2">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, address or number…"
            className="w-full max-w-xs rounded-pill border border-line bg-surface px-4 py-2 text-sm outline-none placeholder:text-muted focus:border-green/40"
          />
          <select
            value={plan}
            onChange={(e) => setPlan(e.target.value)}
            className="rounded-pill border border-line bg-surface px-3 py-2 text-sm text-ink outline-none"
            aria-label="Plan"
          >
            <option value="all">All plans</option>
            <option value="starter">Starter</option>
            <option value="growth">Growth</option>
            <option value="business">Business</option>
          </select>
        </div>
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={`rounded-pill border px-3 py-1.5 text-xs font-medium transition-colors ${
                filter === f.id
                  ? 'border-sidebar bg-sidebar text-white'
                  : 'border-line bg-surface text-muted hover:text-ink'
              }`}
            >
              {f.label}
              {tenants ? ` (${counts[f.id]})` : ''}
            </button>
          ))}
        </div>
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <LoadingRows rows={6} className="p-4" />
        ) : !tenants?.length ? (
          <p className="px-4 py-12 text-center text-sm text-muted">
            No stores yet. The first one is provisioned by the bot, or by hand —
            see supabase/seed/first_tenant.sql.
          </p>
        ) : !shown.length ? (
          <p className="px-4 py-12 text-center text-sm text-muted">No stores match.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-muted">
                  <th className="px-4 py-2.5 font-medium">Store</th>
                  <th className="px-4 py-2.5 font-medium">Plan</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Commission</th>
                  <th className="px-4 py-2.5 font-medium">Orders</th>
                  <th className="px-4 py-2.5 font-medium">GMV</th>
                  <th className="px-4 py-2.5 font-medium">WhatsApp</th>
                  <th className="px-4 py-2.5 font-medium">Joined</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((t) => (
                  <tr key={t.id} className="border-b border-line/60 last:border-0 hover:bg-surface-2/60">
                    <td className="px-4 py-3">
                      <Link to={`/admin/tenants/${t.id}`} className="font-medium text-ink hover:underline">
                        {t.name}
                      </Link>
                      <span className="block text-[11px] text-muted">/{t.slug}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-pill px-2 py-0.5 text-[11px] font-medium capitalize ${TIER_TONE[t.tier] ?? ''}`}>
                        {t.tier}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill
                        status={t.status === 'active' ? 'active' : t.status === 'suspended' ? 'open' : 'pending'}
                        label={t.status === 'onboarding' ? 'Awaiting approval' : t.status}
                      />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums">
                      {Number(t.commission_pct) > 0 ? `${t.commission_pct}%` : '—'}
                    </td>
                    <td className="px-4 py-3 tabular-nums">{t.stats.orders}</td>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums">
                      {formatNaira(t.stats.gmv)}
                    </td>
                    <td className="px-4 py-3">
                      <WhatsappCell tenant={t} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted">{dateOnly(t.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

// Whether a store can actually reach anybody.
//
// "Has a session" and "that session works" are different questions, and only
// the second one matters: a seller whose phone was unlinked from WhatsApp's
// Linked Devices list still has a session row and reaches nobody. This is the
// one place on the platform where that shows up before the seller complains,
// so a dead session reads as a problem rather than as a tick.
function WhatsappCell({ tenant }) {
  if (!tenant.waha_session) {
    return <span className="text-muted">Not linked</span>;
  }

  if (tenant.waha_status === 'WORKING') {
    return <span className="text-green">Working</span>;
  }

  if (tenant.waha_status === 'SCAN_QR_CODE' || tenant.waha_status === 'STARTING') {
    return <span className="text-amber">Pairing</span>;
  }

  return (
    <span className="font-medium text-red" title={tenant.waha_status ?? 'No status reported'}>
      {tenant.waha_status === 'FAILED' ? 'Logged out' : 'Not working'}
    </span>
  );
}
