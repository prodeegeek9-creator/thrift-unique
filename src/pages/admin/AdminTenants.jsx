import { Link } from 'react-router-dom';
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

export default function AdminTenants() {
  const { data: tenants, isLoading } = useQuery({
    queryKey: ['admin', 'tenants'],
    queryFn: fetchTenants,
  });

  return (
    <>
      <PageHeader
        title="Stores"
        subtitle={tenants ? `${tenants.length} on the platform` : 'Every tenant.'}
      />

      <div className="card overflow-hidden">
        {isLoading ? (
          <LoadingRows rows={6} className="p-4" />
        ) : !tenants?.length ? (
          <p className="px-4 py-12 text-center text-sm text-muted">
            No stores yet. The first one is provisioned by the bot, or by hand —
            see supabase/seed/first_tenant.sql.
          </p>
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
                {tenants.map((t) => (
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
                        label={t.status}
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
                      {/* Whether a store can actually receive listings. A tenant
                          with no WAHA session is onboarded but mute. */}
                      <span className={t.waha_session ? 'text-green' : 'text-muted'}>
                        {t.waha_session ? 'Linked' : 'Not linked'}
                      </span>
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
