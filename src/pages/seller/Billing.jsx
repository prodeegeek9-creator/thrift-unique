import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import PageHeader from '../../components/ui/PageHeader.jsx';
import Icon from '../../components/ui/Icon.jsx';
import { useTenant } from '../../lib/TenantContext.jsx';
import { fetchUsage, planFeatures, nextTier, ALWAYS_INCLUDED } from '../../lib/billing.js';
import { keys } from '../../lib/queryKeys.js';

const TIER_NAME = { starter: 'Starter', growth: 'Growth', business: 'Business' };

export default function Billing() {
  const { tenant } = useTenant();
  const tenantId = tenant?.id;

  const { data: usage } = useQuery({
    queryKey: keys.usage(tenantId),
    queryFn: () => fetchUsage(tenantId),
    enabled: Boolean(tenantId),
  });

  const { included, locked } = planFeatures(tenant);
  const upgrade = nextTier(tenant);

  return (
    <>
      <PageHeader title="Billing & Plan" subtitle="Your plan, your usage, and what else is available." />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <div className="rounded-card bg-sidebar p-5 text-white">
            <p className="text-[11px] uppercase tracking-wider text-white/50">Your plan</p>
            <h2 className="mt-1 font-display text-2xl font-semibold text-white">
              {TIER_NAME[tenant?.tier] ?? tenant?.tier}
            </h2>
            {/* Commission is per tenant, not per tier — the Business tier is
                explicitly negotiable, so this is their rate. */}
            <p className="mt-1 text-sm text-white/70">
              {Number(tenant?.commission_pct) > 0
                ? `${tenant.commission_pct}% commission per sale`
                : 'No commission on sales'}
            </p>
          </div>

          <div className="card p-4">
            <h2 className="mb-3 text-sm font-semibold text-ink">This month</h2>
            <div className="grid grid-cols-3 gap-3">
              <Usage label="Listings" value={usage?.listings} />
              <Usage label="Orders" value={usage?.orders} />
              <Usage label="Social posts" value={usage?.socialPosts} />
            </div>
          </div>

          <div className="card grid gap-6 p-4 sm:grid-cols-2">
            <div>
              <h2 className="mb-3 text-sm font-semibold text-ink">Your features</h2>
              <ul className="space-y-2">
                {ALWAYS_INCLUDED.map((label) => (
                  <Feature key={label} label={label} on />
                ))}
                {included.map((f) => (
                  <Feature key={f.flag} label={f.label} on />
                ))}
              </ul>
            </div>

            {locked.length ? (
              <div>
                <h2 className="mb-3 text-sm font-semibold text-muted">
                  {TIER_NAME[upgrade] ?? 'Higher plan'} features
                </h2>
                <ul className="space-y-2">
                  {locked.map((f) => (
                    <Feature key={f.flag} label={f.label} />
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>

        {upgrade ? (
          <aside className="card h-fit overflow-hidden">
            <div className="bg-sidebar px-5 py-6 text-center">
              <h2 className="font-display text-lg font-semibold text-white">
                More reach. More sales.
              </h2>
              <p className="mt-1 text-sm text-white/60">All from WhatsApp.</p>
            </div>
            <div className="p-4">
              <p className="text-sm leading-relaxed text-text">
                {upgrade === 'growth'
                  ? 'Growth adds Instagram and Facebook, buyer protection and buyer tracking.'
                  : 'Business adds TikTok, staff accounts, full analytics and dedicated support.'}
              </p>
              <Link
                to="/dashboard/help"
                className="mt-4 block rounded-pill bg-green py-2.5 text-center text-sm font-semibold text-white"
              >
                Explore {TIER_NAME[upgrade]}
              </Link>
            </div>
          </aside>
        ) : null}
      </div>
    </>
  );
}

function Usage({ label, value }) {
  return (
    <div className="rounded-lg bg-surface-2 p-3 text-center">
      <p className="font-display text-xl font-semibold text-ink">{value ?? '—'}</p>
      <p className="mt-0.5 text-[11px] text-muted">{label}</p>
    </div>
  );
}

function Feature({ label, on = false }) {
  return (
    <li className={`flex items-center gap-2 text-[13px] ${on ? 'text-text' : 'text-muted'}`}>
      <span
        className={`grid h-4 w-4 shrink-0 place-items-center rounded-full ${
          on ? 'bg-green text-white' : 'bg-surface-2 text-muted'
        }`}
      >
        <Icon name={on ? 'check' : 'lock'} className="h-2.5 w-2.5" />
      </span>
      {label}
    </li>
  );
}
