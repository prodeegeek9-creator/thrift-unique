import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useToast } from '../lib/ToastContext.jsx';
import { useTenant } from '../lib/TenantContext.jsx';
import { fetchBillingSummary, changePlan } from '../lib/billing.js';
import { formatNaira } from '../lib/money.js';
import { dateOnly } from '../lib/time.js';
import { keys } from '../lib/queryKeys.js';

// The three plans side by side, with what moving to each would do right now:
// upgrade straight away (paying the difference for the rest of this month),
// or move down when the paid month ends. The Worker works out every quote
// (worker/lib/planChange.js); this only shows them and asks.
//
// /dashboard/billing?plan=growth, the link in an upgrade nudge, highlights
// that plan and scrolls to it.

const NAME = { starter: 'Starter', growth: 'Growth', business: 'Business' };

export default function PlanPicker({ tenantId }) {
  const { tenant, role } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const [params] = useSearchParams();
  const wanted = params.get('plan');
  const wantedRef = useRef(null);
  const [confirm, setConfirm] = useState(null);
  const isOwner = role === 'owner';

  const { data, isLoading } = useQuery({
    queryKey: keys.billingSummary(tenantId),
    queryFn: () => fetchBillingSummary(tenantId),
    enabled: Boolean(tenantId),
  });

  useEffect(() => {
    if (wanted && data && wantedRef.current) wantedRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [wanted, data]);

  const go = useMutation({
    mutationFn: (tier) => changePlan(tenantId, tier),
    onSuccess: (r, tier) => {
      setConfirm(null);
      if (r.done === 'pay' && r.pay_url) {
        window.location.assign(r.pay_url);
        return;
      }
      qc.invalidateQueries({ queryKey: ['tenant', tenantId] });
      toast(
        r.done === 'scheduled'
          ? `You'll move to ${NAME[tier]} on ${dateOnly(r.effective_at)}.`
          : r.done === 'kept'
            ? `You're staying on ${NAME[tier]}.`
            : `You're on ${NAME[tier]} now.`,
        'success'
      );
      // The plan, features and commission come from the tenant row.
      setTimeout(() => window.location.reload(), 900);
    },
    onError: (e) => toast(e.message, 'error'),
  });

  if (isLoading || !data?.plans) return <div className="h-64 animate-pulse rounded-card bg-surface-2" />;

  const blocked = data.plans.find((p) => p.change?.blocked)?.change.blocked;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">Plans</h2>
        {!isOwner ? <p className="text-xs text-muted">Only the store owner can change the plan.</p> : null}
      </div>

      {data.open_upgrade ? (
        <p className="rounded-lg bg-amber-lt px-3 py-2 text-xs text-amber">
          Your move to {NAME[data.open_upgrade.tier]} is waiting on payment of {formatNaira(data.open_upgrade.amount)}.{' '}
          <a href={data.open_upgrade.pay_url} className="font-semibold underline">
            Pay now
          </a>
        </p>
      ) : null}

      {data.next_tier ? (
        <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-text">
          You're moving to {NAME[data.next_tier]} on {dateOnly(data.next_tier_at)}. Until then everything on{' '}
          {NAME[tenant?.tier]} stays on.
        </p>
      ) : null}

      {blocked ? <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-text">{blocked}</p> : null}

      <div className="grid gap-3 md:grid-cols-3">
        {data.plans.map((p) => {
          const current = p.tier === tenant?.tier;
          const highlight = wanted === p.tier && !current;
          return (
            <div
              key={p.tier}
              ref={highlight ? wantedRef : null}
              className={`card flex flex-col p-4 ${current ? 'ring-2 ring-green/40' : ''} ${highlight ? 'ring-2 ring-gold' : ''}`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="font-display text-base font-semibold text-ink">{NAME[p.tier]}</h3>
                {current ? (
                  <span className="rounded-pill bg-green-lt px-2 py-0.5 text-[10px] font-semibold text-green">Your plan</span>
                ) : null}
              </div>
              <p className="mt-1 font-display text-xl font-semibold text-ink">
                {formatNaira(p.price)}
                <span className="text-xs font-normal text-muted"> / month</span>
              </p>
              <ul className="mt-3 flex-1 space-y-1.5">
                {p.features.map((f) => (
                  <li key={f} className="flex gap-2 text-[13px] text-text">
                    <span className="text-green">✓</span>
                    {f}
                  </li>
                ))}
                {p.coming_soon ? <li className="text-[12px] text-muted">Coming soon: {p.coming_soon}</li> : null}
              </ul>
              <div className="mt-4">
                <Action
                  plan={p}
                  current={current}
                  isOwner={isOwner}
                  nextTier={data.next_tier}
                  busy={go.isPending}
                  onPick={() => setConfirm(p)}
                />
              </div>
            </div>
          );
        })}
      </div>

      {confirm ? (
        <Confirm plan={confirm} tier={tenant?.tier} busy={go.isPending} onCancel={() => setConfirm(null)} onGo={() => go.mutate(confirm.tier)} />
      ) : null}
    </section>
  );
}

function Action({ plan, current, isOwner, nextTier, busy, onPick }) {
  const c = plan.change ?? {};
  if (!isOwner || c.blocked) return null;
  if (current) {
    if (!nextTier) return null;
    return <Button onClick={onPick} busy={busy} label={`Keep ${NAME[plan.tier]}`} />;
  }
  if (c.kind === 'upgrade') {
    return (
      <Button
        onClick={onPick}
        busy={busy}
        primary
        label={c.amount > 0 ? `Upgrade · pay ${formatNaira(c.amount)} now` : `Upgrade to ${NAME[plan.tier]}`}
      />
    );
  }
  if (plan.tier === nextTier) return <p className="text-center text-xs text-muted">Starts {dateOnly(c.effective_at)}</p>;
  return (
    <Button
      onClick={onPick}
      busy={busy}
      label={c.when === 'next_period' ? `Move down on ${dateOnly(c.effective_at)}` : `Switch to ${NAME[plan.tier]}`}
    />
  );
}

function Button({ label, onClick, busy, primary = false }) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className={`w-full rounded-pill py-2 text-xs font-semibold disabled:opacity-60 ${
        primary ? 'bg-green text-white' : 'border border-line text-ink hover:bg-surface-2'
      }`}
    >
      {label}
    </button>
  );
}

function Confirm({ plan, tier, busy, onCancel, onGo }) {
  const c = plan.change;
  const up = c.kind === 'upgrade';
  const text =
    c.kind === 'keep'
      ? `You'll stay on ${NAME[plan.tier]} and your planned move down is called off.`
      : up
        ? c.amount > 0
          ? `You'll pay ${formatNaira(c.amount)} now: the difference between ${NAME[tier]} and ${NAME[plan.tier]} for the rest of this month. ${NAME[plan.tier]} switches on as soon as it's paid, and from your next renewal the plan is ${formatNaira(plan.price)} a month.`
          : `${NAME[plan.tier]} switches on straight away, with nothing to pay today. From your next renewal the plan is ${formatNaira(plan.price)} a month.`
        : c.when === 'next_period'
          ? `You keep everything on ${NAME[tier]} until ${dateOnly(c.effective_at)}, then move to ${NAME[plan.tier]} at ${formatNaira(plan.price)} a month. No refund for the rest of this month.`
          : `You'll move to ${NAME[plan.tier]} straight away. Features that aren't on ${NAME[plan.tier]} will switch off.`;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-4">
      <div className="card w-full max-w-sm p-5">
        <h2 className="font-display text-base font-semibold text-ink">
          {c.kind === 'keep' ? `Keep ${NAME[plan.tier]}?` : up ? `Upgrade to ${NAME[plan.tier]}?` : `Move to ${NAME[plan.tier]}?`}
        </h2>
        <p className="mt-2 text-sm text-text">{text}</p>
        <div className="mt-4 flex gap-2">
          <button type="button" onClick={onCancel} className="flex-1 rounded-pill border border-line py-2 text-sm font-medium text-ink">
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onGo}
            className="flex-1 rounded-pill bg-green py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {busy ? 'One moment…' : up && c.amount > 0 ? `Pay ${formatNaira(c.amount)}` : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
