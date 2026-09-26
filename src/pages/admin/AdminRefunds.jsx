import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import PageHeader from '../../components/ui/PageHeader.jsx';
import EmptyState, { LoadingRows } from '../../components/ui/EmptyState.jsx';
import StatusPill from '../../components/ui/StatusPill.jsx';
import { useToast } from '../../lib/ToastContext.jsx';
import { fetchRefunds, retryRefund } from '../../lib/admin.js';
import { formatNaira } from '../../lib/money.js';
import { dateTime } from '../../lib/time.js';

// Every refund on the platform: who asked for it, what went back to the buyer
// after Paystack's fee, and whether it reached their card. A failed one
// (usually the Paystack balance was short) is retried from here by an owner.

// Colours come from StatusPill's own map; only the words differ.
const LABEL = {
  pending: 'With Paystack',
  processing: 'With Paystack',
  processed: 'Refunded',
  failed: 'Failed',
};

const VIA = { store: 'Store', operator: 'Console', dispute: 'Dispute' };

export default function AdminRefunds({ operator }) {
  const qc = useQueryClient();
  const toast = useToast();
  const isOwner = operator?.level === 'owner';
  const { data: rows, isLoading } = useQuery({ queryKey: ['admin', 'refunds'], queryFn: fetchRefunds });

  const retry = useMutation({
    mutationFn: (id) => retryRefund(id),
    onSuccess: (r) => {
      toast(r.status === 'failed' ? `Still refused: ${r.failure_reason ?? 'Paystack said no'}` : 'Sent to Paystack again', r.status === 'failed' ? 'error' : 'success');
      qc.invalidateQueries({ queryKey: ['admin', 'refunds'] });
      qc.invalidateQueries({ queryKey: ['admin', 'audit'] });
    },
    onError: (e) => toast(e.message, 'error'),
  });

  const failed = (rows ?? []).filter((r) => r.status === 'failed').length;

  return (
    <>
      <PageHeader
        title="Refunds"
        subtitle={rows ? `${rows.length} refund${rows.length === 1 ? '' : 's'}${failed ? ` · ${failed} failed` : ''}` : 'Money going back to buyers.'}
      />

      <div className="card overflow-hidden">
        {isLoading ? (
          <LoadingRows rows={5} className="p-4" />
        ) : !rows?.length ? (
          <EmptyState icon="payouts" title="No refunds yet" body="Refunds made by stores, from disputes or from the release queue appear here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-muted">
                  <th className="px-4 py-2.5 font-medium">Order</th>
                  <th className="px-4 py-2.5 font-medium">Store</th>
                  <th className="px-4 py-2.5 font-medium">Paid</th>
                  <th className="px-4 py-2.5 font-medium">Paystack fee</th>
                  <th className="px-4 py-2.5 font-medium">Refunded</th>
                  <th className="px-4 py-2.5 font-medium">From</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">When</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  return (
                    <tr key={r.id} className="border-b border-line/60 align-top last:border-0">
                      <td className="whitespace-nowrap px-4 py-3 font-medium text-ink">
                        {r.order?.order_code ?? '—'}
                        {r.reason ? <span className="block max-w-[220px] truncate text-[11px] font-normal text-muted">{r.reason}</span> : null}
                      </td>
                      <td className="px-4 py-3">{r.tenant_name ?? '—'}</td>
                      <td className="whitespace-nowrap px-4 py-3 tabular-nums text-muted">{formatNaira(r.paid)}</td>
                      <td className="whitespace-nowrap px-4 py-3 tabular-nums text-muted">
                        {Number(r.fee) > 0 ? `−${formatNaira(r.fee)}` : '—'}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-medium tabular-nums">{formatNaira(r.amount)}</td>
                      <td className="px-4 py-3 text-muted">{VIA[r.requested_via] ?? r.requested_via}</td>
                      <td className="px-4 py-3">
                        <StatusPill status={r.status} label={LABEL[r.status] ?? r.status} />
                        {r.failure_reason && r.status === 'failed' ? (
                          <span className="mt-1 block max-w-[220px] text-[11px] text-red">{r.failure_reason}</span>
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-muted">{dateTime(r.processed_at ?? r.created_at)}</td>
                      <td className="px-4 py-3 text-right">
                        {isOwner && r.status === 'failed' ? (
                          <button
                            type="button"
                            disabled={retry.isPending}
                            onClick={() => retry.mutate(r.id)}
                            className="rounded-pill border border-line px-3 py-1 text-xs font-medium text-ink hover:bg-surface-2 disabled:opacity-60"
                          >
                            Retry
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
