import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Icon from '../../components/ui/Icon.jsx';
import StatTile from '../../components/ui/StatTile.jsx';
import { useToast } from '../../lib/ToastContext.jsx';
import { fetchTenant, setFlag, setTenantStatus } from '../../lib/admin.js';
import { FLAG_MIN_TIER } from '../../lib/features.js';
import { formatNaira } from '../../lib/money.js';
import { dateOnly } from '../../lib/time.js';
import { CATEGORY_LABELS, STORE_TYPE_LABELS, storeUrl } from '../../lib/tenants.js';

export default function AdminTenantDetail({ operator }) {
  const { tenantId } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const isOwner = operator?.level === 'owner';

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'tenant', tenantId],
    queryFn: () => fetchTenant(tenantId),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['admin', 'tenant', tenantId] });
    qc.invalidateQueries({ queryKey: ['admin', 'tenants'] });
    qc.invalidateQueries({ queryKey: ['admin', 'audit'] });
  };

  const flagMutation = useMutation({
    mutationFn: ({ flag, enabled }) => setFlag(tenantId, flag, enabled),
    onSuccess: (_, v) => {
      toast(`${v.flag} ${v.enabled ? 'on' : 'off'}`, 'success');
      invalidate();
    },
    onError: (e) => toast(e.message, 'error'),
  });

  const statusMutation = useMutation({
    mutationFn: (status) => setTenantStatus(tenantId, status),
    onSuccess: (result, status) => {
      invalidate();

      if (result?.notified === true) {
        toast('Approved. The seller has been messaged on WhatsApp.', 'success');
      } else if (result?.notified === false) {
        // The store is live either way; the seller just has not been told.
        toast('Approved, but the WhatsApp message did not go out.', 'error');
        if (result.link) {
          window.prompt('Send the seller this link to set their dashboard password:', result.link);
        }
      } else {
        toast(`Store ${status}`, 'success');
      }
    },
    onError: (e) => toast(e.message, 'error'),
  });

  if (isLoading) return <div className="h-64 animate-pulse rounded-card bg-surface-2" />;
  if (!data?.tenant) {
    return <p className="card p-8 text-center text-sm text-muted">No such store.</p>;
  }

  const { tenant, signup, flags, members, stats } = data;
  const pending = tenant.status === 'onboarding';

  return (
    <div className="mx-auto max-w-4xl">
      <Link to="/admin/tenants" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <Icon name="back" className="h-4 w-4" />
        All stores
      </Link>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-ink">{tenant.name}</h1>
          <p className="text-sm text-muted">
            /{tenant.slug} · {tenant.tier} · joined {dateOnly(tenant.created_at)}
          </p>
        </div>

        {isOwner && pending ? (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                if (confirm(`Turn down ${tenant.name}? The store is suspended and no login is created.`)) {
                  statusMutation.mutate('suspended');
                }
              }}
              disabled={statusMutation.isPending}
              className="rounded-pill border border-red/30 px-3 py-1.5 text-xs font-medium text-red hover:bg-red-lt disabled:opacity-50"
            >
              Turn down
            </button>
            <button
              type="button"
              onClick={() => statusMutation.mutate('active')}
              disabled={statusMutation.isPending}
              className="rounded-pill bg-green px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              {statusMutation.isPending ? 'Approving…' : 'Approve'}
            </button>
          </div>
        ) : isOwner ? (
          <div className="flex gap-2">
            {tenant.status !== 'suspended' ? (
              <button
                type="button"
                onClick={() => {
                  // Suspending stops a live business trading. Worth one
                  // deliberate press rather than a stray click on a row.
                  if (confirm(`Suspend ${tenant.name}? Their store stops taking orders.`)) {
                    statusMutation.mutate('suspended');
                  }
                }}
                className="rounded-pill border border-red/30 px-3 py-1.5 text-xs font-medium text-red hover:bg-red-lt"
              >
                Suspend
              </button>
            ) : (
              <button
                type="button"
                onClick={() => statusMutation.mutate('active')}
                className="rounded-pill bg-green px-3 py-1.5 text-xs font-semibold text-white"
              >
                Reactivate
              </button>
            )}
          </div>
        ) : null}
      </div>

      {pending ? (
        <section className="mb-4 rounded-card bg-amber-lt p-4 text-sm text-amber">
          <p className="font-semibold">Waiting for approval</p>
          <p className="mt-1 leading-relaxed">
            Signed up over WhatsApp from {tenant.whatsapp_number ?? 'an unknown number'}
            {signup?.email ? (
              <>
                {' '}with <span className="font-medium">{signup.email}</span>
              </>
            ) : null}
            {signup?.created_at ? ` on ${dateOnly(signup.created_at)}` : ''}.
            {' '}They accepted the {tenant.disclaimer_version ?? 'commission'} terms for the{' '}
            <span className="font-medium capitalize">{tenant.tier}</span> plan and can already list
            items; nothing is public until you approve. Approving creates their login and sends them
            the link on WhatsApp.
          </p>
        </section>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-4">
        <StatTile label="Orders" value={stats.orders} />
        <StatTile label="GMV" value={formatNaira(stats.gmv)} />
        <StatTile label="Commission" value={formatNaira(stats.commission)} />
        <StatTile label="Held" value={stats.held} tone="amber" />
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <section className="card p-4">
          <h2 className="text-sm font-semibold text-ink">Feature flags</h2>
          <p className="mt-0.5 text-xs text-muted">
            An override here beats the plan, in both directions — that is why
            flags are rows rather than derived from the tier.
          </p>

          <div className="mt-3 space-y-1">
            {Object.keys(FLAG_MIN_TIER).map((flag) => {
              const row = flags.find((f) => f.flag === flag);
              const on = Boolean(row?.enabled);
              return (
                <div key={flag} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-surface-2">
                  <span className="flex-1 text-[13px] text-text">{flag}</span>
                  <span className="text-[10px] uppercase tracking-wider text-muted">
                    {FLAG_MIN_TIER[flag]}
                  </span>
                  <button
                    type="button"
                    disabled={!isOwner || flagMutation.isPending}
                    onClick={() => flagMutation.mutate({ flag, enabled: !on })}
                    aria-label={`${flag}: ${on ? 'on' : 'off'}`}
                    className={`h-5 w-9 shrink-0 rounded-pill p-0.5 transition-colors disabled:opacity-50 ${
                      on ? 'bg-green' : 'bg-line'
                    }`}
                  >
                    <span
                      className={`block h-4 w-4 rounded-full bg-white transition-transform ${
                        on ? 'translate-x-4' : ''
                      }`}
                    />
                  </button>
                </div>
              );
            })}
          </div>

          {!isOwner ? (
            <p className="mt-3 text-[11px] text-muted">
              Changing a plan is owner-level. You have support access.
            </p>
          ) : null}
        </section>

        <div className="space-y-4">
          <section className="card p-4">
            <h2 className="text-sm font-semibold text-ink">Commercials</h2>
            <dl className="mt-2 space-y-1 text-sm">
              <Row label="Plan" value={tenant.tier} />
              <Row
                label="Commission"
                value={Number(tenant.commission_pct) > 0 ? `${tenant.commission_pct}%` : 'None'}
              />
              <Row label="Status" value={tenant.status} />
              <Row label="Disclaimer" value={tenant.disclaimer_accepted_at ? dateOnly(tenant.disclaimer_accepted_at) : 'Not accepted'} />
              {tenant.disclaimer_version ? <Row label="Terms version" value={tenant.disclaimer_version} /> : null}
            </dl>
          </section>

          <section className="card p-4">
            <h2 className="text-sm font-semibold text-ink">Store</h2>
            <dl className="mt-2 space-y-1 text-sm">
              <Row label="Type" value={STORE_TYPE_LABELS[tenant.store_type] ?? 'Not given'} />
              <Row label="Sells" value={CATEGORY_LABELS[tenant.category] ?? tenant.category ?? 'Not given'} />
            </dl>
            {tenant.status === 'active' ? (
              <a
                href={storeUrl(tenant.slug)}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-block text-xs font-semibold text-green"
              >
                Open store page ↗
              </a>
            ) : (
              <p className="mt-2 text-xs text-muted">The store page goes live on approval.</p>
            )}
          </section>

          <section className="card p-4">
            <h2 className="text-sm font-semibold text-ink">WhatsApp</h2>
            <dl className="mt-2 space-y-1 text-sm">
              <Row label="Number" value={tenant.whatsapp_number ?? 'Not set'} />
              <Row label="WAHA session" value={tenant.waha_session ?? 'Not linked'} />
            </dl>
          </section>

          <section className="card p-4">
            <h2 className="text-sm font-semibold text-ink">Team</h2>
            <p className="mt-1 text-sm text-muted">
              {members.length} member{members.length === 1 ? '' : 's'}
              {members.length ? ` · ${members.filter((m) => m.role === 'owner').length} owner` : ''}
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted">{label}</dt>
      <dd className="font-medium capitalize text-ink">{value}</dd>
    </div>
  );
}
