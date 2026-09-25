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
