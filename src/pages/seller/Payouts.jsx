import { useQuery } from '@tanstack/react-query';
import PageHeader from '../../components/ui/PageHeader.jsx';
import Icon from '../../components/ui/Icon.jsx';
import StatTile from '../../components/ui/StatTile.jsx';
import StatusPill from '../../components/ui/StatusPill.jsx';
import EmptyState, { LoadingRows } from '../../components/ui/EmptyState.jsx';
import { useTenant } from '../../lib/TenantContext.jsx';
import { fetchBalance, fetchPayouts, payoutStatusLabel } from '../../lib/payouts.js';
import PayoutAccountCard from '../../components/PayoutAccountCard.jsx';
import { formatNaira } from '../../lib/money.js';
import { dateOnly } from '../../lib/time.js';
import { keys } from '../../lib/queryKeys.js';

// The five escrow steps, as a static explainer.
//
// Not a progress bar — it belongs to no particular order. Sellers on Growth
// and Business are being asked to wait for money they can see, and the thing
// that makes that tolerable is knowing the shape of the wait.
// Starter: no hold, so no waiting on the buyer.
const DIRECT_STEPS = [
  'Buyer pays through us',
  'Commission comes off',
  'The rest goes to your bank the same day',
];

const ESCROW_STEPS = [
  'Buyer pays',
  'We hold the funds',
  'You ship the item',
  'Buyer confirms',
  'Funds released to you',
];

export default function Payouts() {
  const { tenant, can, role } = useTenant();
  const tenantId = tenant?.id;
  const hasEscrow = can('escrow');

  const { data: balance, isLoading: balanceLoading } = useQuery({
    queryKey: keys.balance(tenantId),
    queryFn: () => fetchBalance(tenantId),
    enabled: Boolean(tenantId),
  });

  const { data: payouts, isLoading } = useQuery({
    queryKey: keys.payouts(tenantId),
    queryFn: () => fetchPayouts(tenantId),
    enabled: Boolean(tenantId),
  });

  return (
    <>
      <PageHeader title="Payouts" subtitle="What you have been paid, and what is pending." />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <div className="grid gap-3 sm:grid-cols-2">
            <StatTile
              icon="payouts"
              label="Available Balance"
              value={balanceLoading ? '—' : formatNaira(balance?.available ?? 0)}
              note="Ready to pay out"
            />
            <StatTile
              icon="orders"
              label={hasEscrow ? 'Pending Escrow' : 'Awaiting payment'}
              value={balanceLoading ? '—' : formatNaira(balance?.pendingEscrow ?? 0)}
              note={balance?.nextPayoutNote ?? 'Nothing on hold'}
              tone="amber"
            />
          </div>

          <div className="card overflow-hidden">
            <div className="border-b border-line px-4 py-3">
              <h2 className="text-sm font-semibold text-ink">Recent Payouts</h2>
            </div>

            {isLoading ? (
              <LoadingRows rows={4} className="p-4" />
            ) : !payouts?.length ? (
              <EmptyState
                icon="payouts"
                title="No payouts yet"
                body={
                  hasEscrow
                    ? 'Once a buyer confirms an order, the funds are released and the transfer shows up here.'
                    : 'Payouts appear here after your first sale settles.'
                }
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-muted">
                      <th className="px-4 py-2.5 font-medium">Amount</th>
                      <th className="px-4 py-2.5 font-medium">Reference</th>
                      <th className="px-4 py-2.5 font-medium">Status</th>
                      <th className="px-4 py-2.5 font-medium">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payouts.map((p) => (
                      <tr key={p.id} className="border-b border-line/60 last:border-0">
                        <td className="whitespace-nowrap px-4 py-3 font-medium text-ink">
                          {formatNaira(p.amount)}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted">{p.reference ?? '—'}</td>
                        <td className="px-4 py-3">
                          <StatusPill status={p.status} label={payoutStatusLabel(p)} />
                          {p.failure_reason ? (
                            <span className="ml-2 text-xs text-red">{p.failure_reason}</span>
                          ) : null}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-muted">
                          {dateOnly(p.paid_at ?? p.created_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-4">
        <PayoutAccountCard tenantId={tenantId} isOwner={role === 'owner'} />

        <div className="card h-fit p-4">
          <h2 className="text-sm font-semibold text-ink">
            {hasEscrow ? 'How escrow works' : 'How you get paid'}
          </h2>
          <p className="mt-1 text-xs text-muted">
            {hasEscrow
              ? 'Buyers pay upfront. We hold it until they confirm the item arrived.'
              : 'Buyers pay through us and you are paid the same day, minus commission.'}
          </p>

          <ol className="mt-4 space-y-3">
            {(hasEscrow ? ESCROW_STEPS : DIRECT_STEPS).map((step, i) => (
              <li key={step} className="flex items-start gap-2.5">
                <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-green-lt text-[10px] font-semibold text-green">
                  {i + 1}
                </span>
                <span className="text-[13px] leading-snug text-text">{step}</span>
              </li>
            ))}
          </ol>

          {hasEscrow ? (
            <p className="mt-4 flex gap-2 rounded-lg bg-surface-2 p-3 text-[11px] leading-relaxed text-muted">
              <Icon name="help" className="mt-px h-3.5 w-3.5 shrink-0" />
              If a buyer goes quiet, the hold releases to you automatically once
              the confirmation window closes.
            </p>
          ) : null}
        </div>
        </div>
      </div>
    </>
  );
}
