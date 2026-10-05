import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../lib/ToastContext.jsx';
import { fetchBillingSummary, payPlanNow, setAutoRenew } from '../lib/billing.js';
import { formatNaira } from '../lib/money.js';
import { dateOnly } from '../lib/time.js';
import { keys, tenantScope } from '../lib/queryKeys.js';

// The monthly plan fee: where the store stands, the button to pay, the saved
// card and the invoices. Owners and managers see it; only the owner changes
// auto-renew.
const STATUS = {
  trial: { tone: 'bg-green-lt text-green', label: 'Free trial' },
  active: { tone: 'bg-green-lt text-green', label: 'Paid' },
  past_due: { tone: 'bg-amber-lt text-amber', label: 'Payment due' },
  paused: { tone: 'bg-red-lt text-red', label: 'Paused: unpaid' },
  free: { tone: 'bg-surface-2 text-muted', label: 'No plan fee' },
  awaiting_approval: { tone: 'bg-surface-2 text-muted', label: 'Starts on approval' },
};

export default function PlanFeeCard({ tenantId, role }) {
  const toast = useToast();
  const qc = useQueryClient();
  const canSee = role === 'owner' || role === 'manager';

  const { data, isLoading, error } = useQuery({
    queryKey: keys.billingSummary(tenantId),
    queryFn: () => fetchBillingSummary(tenantId),
    enabled: Boolean(tenantId && canSee),
    retry: false,
  });

  const payEarly = useMutation({
    mutationFn: () => payPlanNow(tenantId),
    onSuccess: (r) => window.location.assign(r.pay_url),
    onError: (e) => toast(e.message, 'error'),
  });

  const renew = useMutation({
    mutationFn: (on) => setAutoRenew(tenantId, on),
    onSuccess: (r) => {
      qc.invalidateQueries(tenantScope(tenantId));
      toast(r.auto_renew ? 'Auto-renew is on' : 'Auto-renew is off, and the card is forgotten', 'success');
    },
    onError: (e) => toast(e.message, 'error'),
  });

  if (!canSee) return null;
  if (isLoading) return <div className="card h-40 animate-pulse" />;
  if (error || !data) return null;

  const status = STATUS[data.status] ?? STATUS.active;
  const until = data.paid_until ? dateOnly(data.paid_until) : null;
  const line =
    data.status === 'trial'
      ? `Free until ${until}, then ${formatNaira(data.price)} a month.`
      : data.status === 'active'
        ? `${formatNaira(data.price)} a month · paid until ${until}.`
        : data.status === 'past_due'
          ? `${formatNaira(data.price)} was due on ${until}. Pay within the grace period to keep your store running.`
          : data.status === 'paused'
            ? 'Your store is paused: your pages are hidden and the bot is off. Pay to bring it back straight away.'
            : data.status === 'free'
              ? "Your store doesn't pay a plan fee."
              : `Your ${data.trial_days}-day free trial starts when your store is approved.`;

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">Plan fee</h2>
        <span className={`rounded-pill px-2 py-0.5 text-[11px] font-semibold ${status.tone}`}>{status.label}</span>
      </div>
      <p className="mt-2 text-sm text-text">{line}</p>

      {data.open_invoice ? (
        <a
          href={data.open_invoice.pay_url}
          className="mt-3 block rounded-pill bg-green py-2.5 text-center text-sm font-semibold text-white"
        >
          Pay {formatNaira(data.open_invoice.amount)} now
        </a>
      ) : ['trial', 'active'].includes(data.status) ? (
        <button
          type="button"
          disabled={payEarly.isPending}
          onClick={() => payEarly.mutate()}
          className="mt-3 w-full rounded-pill border border-line py-2 text-sm font-medium text-ink hover:bg-surface-2 disabled:opacity-50"
        >
          {payEarly.isPending ? 'Opening…' : 'Pay the next month early'}
        </button>
      ) : null}

      {data.status !== 'free' && data.status !== 'awaiting_approval' ? (
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-3 text-sm">
          <div>
            <p className="font-medium text-ink">Renew automatically</p>
            <p className="text-[11px] text-muted">
              {data.card
                ? `${String(data.card.brand ?? 'Card').toUpperCase()} ••••${data.card.last4}${data.card.exp ? ` · expires ${data.card.exp}` : ''}`
                : 'Pay once by card with "Renew automatically" ticked to turn this on.'}
            </p>
          </div>
          {role === 'owner' && data.card ? (
            <button
              type="button"
              disabled={renew.isPending}
              onClick={() => renew.mutate(!data.auto_renew)}
              aria-label={`Renew automatically: ${data.auto_renew ? 'on' : 'off'}`}
              className={`h-5 w-9 shrink-0 rounded-pill p-0.5 transition-colors disabled:opacity-50 ${data.auto_renew ? 'bg-green' : 'bg-line'}`}
            >
              <span className={`block h-4 w-4 rounded-full bg-white transition-transform ${data.auto_renew ? 'translate-x-4' : ''}`} />
            </button>
          ) : null}
        </div>
      ) : null}

      {data.invoices?.length ? (
        <div className="mt-4 border-t border-line pt-3">
          <p className="mb-2 text-xs font-medium text-muted">Invoices</p>
          <ul className="space-y-1.5 text-xs">
            {data.invoices.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-2">
                <span className="text-text">
                  {dateOnly(i.period_start)} – {dateOnly(i.period_end)}
                </span>
                <span className="font-medium text-ink">{formatNaira(i.amount)}</span>
                <span className={i.status === 'paid' ? 'text-green' : i.status === 'open' ? 'text-amber' : 'text-muted'}>
                  {i.status === 'paid' ? `Paid${i.paid_via === 'card' ? ' (auto)' : ''}` : i.status === 'open' ? 'Due' : 'Void'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
