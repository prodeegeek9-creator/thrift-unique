import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Icon from '../../components/ui/Icon.jsx';
import StatTile from '../../components/ui/StatTile.jsx';
import { useToast } from '../../lib/ToastContext.jsx';
import {
  DEFAULT_COMMISSION,
  fetchTenant,
  setDetails,
  setFlag,
  setPlan,
  setTenantStatus,
  setPayoutsPaused,
  retryPayout,
  recordPlanPayment,
  newMemberLink,
} from '../../lib/admin.js';
import { PLAN_PRICES } from '../../lib/billing.js';
import { payoutStatusLabel } from '../../lib/payouts.js';
import { FLAG_MIN_TIER } from '../../lib/features.js';
import { formatNaira } from '../../lib/money.js';
import { dateOnly, relative } from '../../lib/time.js';
import { imageUrl } from '../../lib/images.js';
import StatusPill from '../../components/ui/StatusPill.jsx';
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

  const { tenant, signup, flags, members, stats, listings, submissions, payoutAccount, payouts, billing } = data;
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

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
          <PlanCard tenant={tenant} isOwner={isOwner} onSaved={invalidate} />
          <BillingCard tenant={tenant} billing={billing} isOwner={isOwner} onSaved={invalidate} />
          <DetailsCard tenant={tenant} isOwner={isOwner} onSaved={invalidate} />
          <TeamCard tenant={tenant} members={members} isOwner={isOwner} />
        </div>
      </div>

      <PayoutsSection
        tenant={tenant}
        account={payoutAccount}
        payouts={payouts ?? []}
        isOwner={isOwner}
        onChanged={invalidate}
      />
      <ListingsSection tenant={tenant} listings={listings} />
      <ReviewSection tenant={tenant} submissions={submissions} />
    </div>
  );
}

const TIERS = ['starter', 'growth', 'business'];

// What the store is on and what it pays. Owner-level, like everything that
// changes what a tenant is charged.
const BILLING_LABEL = {
  trial: ['Free trial', 'text-green'],
  active: ['Paid', 'text-green'],
  past_due: ['Payment due', 'text-amber'],
  paused: ['Paused: unpaid', 'text-red'],
};

// The monthly fee: where the store stands, its invoices, and recording a
// payment made some other way (a transfer, cash).
function BillingCard({ tenant, billing, isOwner, onSaved }) {
  const toast = useToast();
  const record = useMutation({
    mutationFn: () => recordPlanPayment(tenant.id, window.prompt('Note (how it was paid)?') ?? null),
    onSuccess: (r) => {
      toast(r.ok ? 'Payment recorded' : 'Nothing to record', r.ok ? 'success' : 'error');
      onSaved();
    },
    onError: (e) => toast(e.message, 'error'),
  });

  const free = billing?.price === 0;
  const [label, tone] = free ? ['No plan fee', 'text-muted'] : BILLING_LABEL[tenant.billing_status] ?? ['—', 'text-muted'];

  return (
    <section className="card p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Plan fee</h2>
        <span className={`text-xs font-semibold ${tone}`}>{label}</span>
      </div>
      <dl className="mt-2 space-y-1 text-sm">
        <Row label="Per month" value={free ? 'Free' : formatNaira(billing?.price ?? 0)} plain />
        <Row label="Paid until" value={tenant.paid_until ? dateOnly(tenant.paid_until) : tenant.status === 'onboarding' ? 'Trial starts on approval' : '—'} plain />
        <Row label="Auto-renew" value={tenant.auto_renew ? 'On' : 'Off'} plain />
      </dl>
      {billing?.invoices?.length ? (
        <ul className="mt-3 space-y-1 border-t border-line pt-2 text-xs">
          {billing.invoices.slice(0, 4).map((i) => (
            <li key={i.id} className="flex justify-between gap-2">
              <span className="text-muted">{dateOnly(i.period_start)}</span>
              <span className="text-ink">{formatNaira(i.amount)}</span>
              <span className={i.status === 'paid' ? 'text-green' : 'text-amber'}>
                {i.status === 'paid' ? `paid · ${i.paid_via}` : i.status}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {isOwner && !free && tenant.paid_until ? (
        <button
          type="button"
          disabled={record.isPending}
          onClick={() => record.mutate()}
          className="mt-3 w-full rounded-pill border border-line py-1.5 text-xs font-semibold text-ink hover:bg-surface-2"
        >
          Record a month paid another way
        </button>
      ) : null}
    </section>
  );
}

function PlanCard({ tenant, isOwner, onSaved }) {
  const toast = useToast();
  const [tier, setTier] = useState(tenant.tier);
  const [pct, setPct] = useState(String(Number(tenant.commission_pct)));
  // Blank: the plan's standard price. A number: this store's own (0 = free).
  const [fee, setFee] = useState(tenant.plan_price == null ? '' : String(Number(tenant.plan_price)));

  useEffect(() => {
    setTier(tenant.tier);
    setPct(String(Number(tenant.commission_pct)));
    setFee(tenant.plan_price == null ? '' : String(Number(tenant.plan_price)));
  }, [tenant.tier, tenant.commission_pct, tenant.plan_price]);

  const save = useMutation({
    mutationFn: () => setPlan(tenant.id, tier, Number(pct), fee.trim() === '' ? null : Number(fee)),
    onSuccess: () => {
      toast('Plan updated. Features now match it.', 'success');
      onSaved();
    },
    onError: (e) => toast(e.message, 'error'),
  });

  const currentFee = tenant.plan_price == null ? '' : String(Number(tenant.plan_price));
  const changed =
    tier !== tenant.tier || Number(pct) !== Number(tenant.commission_pct) || fee.trim() !== currentFee;

  return (
    <section className="card p-4">
      <h2 className="text-sm font-semibold text-ink">Plan &amp; commission</h2>
      {isOwner ? (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block text-[11px] text-muted">Plan</span>
              <select
                value={tier}
                onChange={(e) => {
                  setTier(e.target.value);
                  // The plan's standard rate, as a starting point.
                  setPct(String(DEFAULT_COMMISSION[e.target.value] ?? pct));
                }}
                className={FIELD}
              >
                {TIERS.map((t) => (
                  <option key={t} value={t}>
                    {t[0].toUpperCase() + t.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-muted">Commission %</span>
              <input
                inputMode="decimal"
                value={pct}
                onChange={(e) => setPct(e.target.value)}
                className={FIELD}
              />
            </label>
          </div>
          <label className="mt-2 block">
            <span className="mb-1 block text-[11px] text-muted">Monthly fee (₦)</span>
            <input
              inputMode="numeric"
              value={fee}
              onChange={(e) => setFee(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder={`${PLAN_PRICES[tier] ?? ''} (plan price)`}
              className={FIELD}
            />
            <span className="mt-1 block text-[11px] text-muted">Blank for the plan's price; 0 for free.</span>
          </label>
          <p className="mt-2 text-[11px] text-muted">
            Saving switches the store's features to the plan's. Adjust feature flags after if needed.
          </p>
          <button
            type="button"
            disabled={!changed || save.isPending}
            onClick={() => save.mutate()}
            className="mt-3 w-full rounded-pill bg-green py-2 text-xs font-semibold text-white disabled:opacity-40"
          >
            {save.isPending ? 'Saving…' : 'Save plan'}
          </button>
        </>
      ) : (
        <dl className="mt-2 space-y-1 text-sm">
          <Row label="Plan" value={tenant.tier} />
          <Row label="Commission" value={Number(tenant.commission_pct) > 0 ? `${tenant.commission_pct}%` : 'None'} />
        </dl>
      )}
      <dl className="mt-3 space-y-1 border-t border-line pt-3 text-sm">
        <Row label="Status" value={tenant.status} />
        <Row
          label="Terms accepted"
          value={tenant.disclaimer_accepted_at ? dateOnly(tenant.disclaimer_accepted_at) : 'Not accepted'}
        />
        {tenant.disclaimer_version ? <Row label="Terms version" value={tenant.disclaimer_version} plain /> : null}
      </dl>
    </section>
  );
}

// Name, number, type and category. The address (slug) is not editable: it is
// in every link the store has already shared.
function DetailsCard({ tenant, isOwner, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(() => detailsForm(tenant));
  const [editing, setEditing] = useState(false);

  // Fresh from the store each time editing starts, so a cancelled edit leaves
  // nothing behind.
  useEffect(() => {
    if (!editing) setForm(detailsForm(tenant));
  }, [tenant, editing]);

  const save = useMutation({
    mutationFn: () =>
      setDetails(tenant.id, {
        name: form.name,
        whatsapp_number: form.whatsapp_number || null,
        store_type: form.store_type || null,
        category: form.category || null,
      }),
    onSuccess: () => {
      toast('Store details saved', 'success');
      setEditing(false);
      onSaved();
    },
    onError: (e) => toast(e.message, 'error'),
  });

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <section className="card p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Store</h2>
        {isOwner && !editing ? (
          <button type="button" onClick={() => setEditing(true)} className="text-xs font-semibold text-green">
            Edit
          </button>
        ) : null}
      </div>

      {editing ? (
        <div className="mt-3 space-y-2">
          <label className="block">
            <span className="mb-1 block text-[11px] text-muted">Name</span>
            <input value={form.name} onChange={set('name')} maxLength={60} className={FIELD} />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] text-muted">WhatsApp number</span>
            <input
              value={form.whatsapp_number}
              onChange={set('whatsapp_number')}
              inputMode="tel"
              placeholder="08012345678"
              className={FIELD}
            />
            <span className="mt-1 block text-[11px] text-muted">
              The number the owner messages the platform from. Changing it moves the store to that number.
            </span>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block text-[11px] text-muted">Type</span>
              <select value={form.store_type} onChange={set('store_type')} className={FIELD}>
                <option value="">Not given</option>
                {Object.entries(STORE_TYPE_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-muted">Sells</span>
              <select value={form.category} onChange={set('category')} className={FIELD}>
                <option value="">Not given</option>
                {Object.entries(CATEGORY_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              disabled={save.isPending}
              onClick={() => save.mutate()}
              className="flex-1 rounded-pill bg-green py-2 text-xs font-semibold text-white disabled:opacity-50"
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded-pill border border-line px-4 py-2 text-xs font-medium text-ink"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <dl className="mt-2 space-y-1 text-sm">
            <Row label="Address" value={`/s/${tenant.slug}`} plain />
            <Row label="Type" value={STORE_TYPE_LABELS[tenant.store_type] ?? 'Not given'} plain />
            <Row label="Sells" value={CATEGORY_LABELS[tenant.category] ?? tenant.category ?? 'Not given'} plain />
            <Row label="WhatsApp number" value={tenant.whatsapp_number ? `+${tenant.whatsapp_number}` : 'Not set'} plain />
            <Row
              label="Own WhatsApp"
              value={!tenant.waha_session ? 'Not linked' : tenant.waha_status === 'WORKING' ? 'Working' : tenant.waha_status ?? 'Unknown'}
              plain
            />
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
        </>
      )}
    </section>
  );
}

function detailsForm(tenant) {
  return {
    name: tenant.name ?? '',
    whatsapp_number: tenant.whatsapp_number ?? '',
    store_type: tenant.store_type ?? '',
    category: tenant.category ?? '',
  };
}

function TeamCard({ tenant, members, isOwner }) {
  const toast = useToast();
  const [shown, setShown] = useState(null); // { email, link }
  const make = useMutation({
    mutationFn: (m) => newMemberLink(tenant.id, m.user_id).then((r) => ({ email: m.email, link: r.link })),
    onSuccess: setShown,
    onError: (e) => toast(e.message, 'error'),
  });

  const number = String(tenant.whatsapp_number ?? '').replace(/\D/g, '');
  const message = shown
    ? `Here's a link to set your Vendwyze dashboard password (${shown.email}): ${shown.link}`
    : '';

  return (
    <section className="card p-4">
      <h2 className="text-sm font-semibold text-ink">Team</h2>
      {members.length ? (
        <ul className="mt-2 space-y-2 text-sm">
          {members.map((m) => (
            <li key={m.user_id} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-ink">
                {m.display_name || m.email || 'Unnamed'}
                {m.display_name && m.email ? <span className="block truncate text-[11px] text-muted">{m.email}</span> : null}
              </span>
              <span className="flex shrink-0 items-center gap-2 text-[11px] capitalize text-muted">
                {m.role}
                {m.accepted_at ? '' : ' · invited'}
                {isOwner && m.email ? (
                  <button
                    type="button"
                    disabled={make.isPending}
                    onClick={() => make.mutate(m)}
                    className="rounded-pill border border-line px-2 py-0.5 text-[11px] normal-case text-ink hover:bg-surface-2 disabled:opacity-60"
                  >
                    New sign-in link
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-sm text-muted">Nobody yet. The owner's login is created on approval.</p>
      )}

      {shown ? (
        <div className="mt-3 space-y-2 rounded-lg border border-gold/40 p-3">
          <p className="text-xs text-text">
            Sign-in link for {shown.email}. It works once and is shown only now.
          </p>
          <p className="break-all rounded bg-bg px-2 py-1.5 font-mono text-[10px] text-text">{shown.link}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() =>
                navigator.clipboard
                  ?.writeText(shown.link)
                  .then(() => toast('Link copied', 'success'))
                  .catch(() => toast('Copy it by hand', 'error'))
              }
              className="rounded-pill bg-ink px-3 py-1 text-[11px] font-semibold text-white"
            >
              Copy link
            </button>
            <a
              href={`https://wa.me/${number}?text=${encodeURIComponent(message)}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-pill bg-green px-3 py-1 text-[11px] font-semibold text-white"
            >
              Send to the store on WhatsApp
            </a>
            <button type="button" onClick={() => setShown(null)} className="px-1 text-[11px] text-muted">
              Done
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ListingsSection({ tenant, listings }) {
  const counts = listings?.counts ?? {};
  const recent = listings?.recent ?? [];
  const summary = ['active', 'sold', 'draft', 'archived']
    .filter((k) => counts[k])
    .map((k) => `${counts[k]} ${k}`)
    .join(' · ');

  return (
    <section className="card mt-4 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">Listings</h2>
        <span className="text-xs text-muted">{summary || 'Nothing listed yet'}</span>
      </div>
      {recent.length ? (
        <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {recent.map((p) => {
            const img = imageUrl(p.images?.[0]);
            const live = p.status === 'active' && tenant.status === 'active';
            const Tile = live ? 'a' : 'div';
            return (
              <li key={p.id}>
                <Tile
                  {...(live ? { href: `/p/${p.public_code}`, target: '_blank', rel: 'noreferrer' } : {})}
                  className="block"
                >
                  {img ? (
                    <img src={img} alt="" loading="lazy" className="aspect-square w-full rounded-lg bg-surface-2 object-cover" />
                  ) : (
                    <div className="aspect-square w-full rounded-lg bg-surface-2" />
                  )}
                  <p className="mt-1 truncate text-xs text-ink">{p.title}</p>
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-xs font-semibold text-ink">{formatNaira(p.price)}</span>
                    <StatusPill status={p.status} />
                  </div>
                </Tile>
              </li>
            );
          })}
        </ul>
      ) : null}
      {(counts.active ?? 0) + (counts.sold ?? 0) + (counts.draft ?? 0) + (counts.archived ?? 0) > recent.length ? (
        <p className="mt-3 text-[11px] text-muted">Showing the {recent.length} most recent.</p>
      ) : null}
    </section>
  );
}

// Where the store is paid and what has gone out. Owners can hold payouts
// (they keep accruing) and push a stuck one again.
function PayoutsSection({ tenant, account, payouts, isOwner, onChanged }) {
  const toast = useToast();
  const pause = useMutation({
    mutationFn: (paused) => setPayoutsPaused(tenant.id, paused),
    onSuccess: (r) => {
      toast(r.paused ? 'Payouts paused' : `Payouts resumed${r.sent ? `, ${r.sent} sent` : ''}`, 'success');
      onChanged();
    },
    onError: (e) => toast(e.message, 'error'),
  });
  const retry = useMutation({
    mutationFn: (id) => retryPayout(id),
    onSuccess: (r) => {
      toast(r.ok ? 'Sent to Paystack' : `Not sent: ${r.result}`, r.ok ? 'success' : 'error');
      onChanged();
    },
    onError: (e) => toast(e.message, 'error'),
  });

  return (
    <section className="card mt-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">Payouts</h2>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-muted">
            {account
              ? `${account.bank_name} ••••${account.account_last4} · ${account.account_name}`
              : 'No bank account yet: payouts wait'}
          </span>
          {isOwner ? (
            <button
              type="button"
              disabled={pause.isPending}
              onClick={() => pause.mutate(!tenant.payouts_paused)}
              className={`rounded-pill px-3 py-1 font-semibold ${
                tenant.payouts_paused ? 'bg-green text-white' : 'border border-red/30 text-red'
              }`}
            >
              {tenant.payouts_paused ? 'Resume payouts' : 'Pause payouts'}
            </button>
          ) : null}
        </div>
      </div>
      {tenant.payouts_paused ? (
        <p className="mt-2 rounded-lg bg-amber-lt px-3 py-2 text-xs text-amber">
          Payouts are paused. They keep adding up and go out when resumed.
        </p>
      ) : null}
      {payouts.length ? (
        <ul className="mt-3 divide-y divide-line text-sm">
          {payouts.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 py-2">
              <span className="w-24 font-semibold text-ink">{formatNaira(p.amount)}</span>
              <span className="text-xs text-muted">{p.reference}</span>
              <StatusPill status={p.status} label={payoutStatusLabel(p)} />
              {p.failure_reason ? <span className="text-xs text-red">{p.failure_reason}</span> : null}
              <span className="ml-auto text-xs text-muted">{dateOnly(p.paid_at ?? p.created_at)}</span>
              {isOwner && p.status === 'pending' ? (
                <button
                  type="button"
                  disabled={retry.isPending}
                  onClick={() => retry.mutate(p.id)}
                  className="text-xs font-semibold text-green"
                >
                  Retry
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted">No payouts yet.</p>
      )}
    </section>
  );
}

function ReviewSection({ tenant, submissions }) {
  if (tenant.store_type === 'brand') return null;
  const counts = submissions?.counts ?? {};
  const pending = submissions?.pending ?? [];

  return (
    <section className="card mt-4 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">Items waiting for the store to review</h2>
        <span className="text-xs text-muted">
          {counts.pending ?? 0} waiting · {counts.approved ?? 0} listed · {counts.declined ?? 0} declined
        </span>
      </div>
      {pending.length ? (
        <ul className="mt-3 divide-y divide-line">
          {pending.map((x) => (
            <li key={x.id} className="flex items-center gap-3 py-2">
              {imageUrl(x.images?.[0]) ? (
                <img src={imageUrl(x.images[0])} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" />
              ) : (
                <div className="h-10 w-10 shrink-0 rounded-lg bg-surface-2" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-ink">{x.title}</p>
                <p className="text-[11px] text-muted">
                  {x.seller_name ?? 'Someone'} · {relative(x.created_at)}
                </p>
              </div>
              <span className="text-sm font-semibold text-ink">{formatNaira(x.asking_price)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted">Nothing waiting.</p>
      )}
    </section>
  );
}

const FIELD =
  'w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-green/40';

function Row({ label, value, plain = false }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className={`min-w-0 truncate text-right font-medium text-ink ${plain ? '' : 'capitalize'}`}>{value}</dd>
    </div>
  );
}
