import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import PageHeader from '../../components/ui/PageHeader.jsx';
import Icon from '../../components/ui/Icon.jsx';
import EmptyState, { LoadingRows } from '../../components/ui/EmptyState.jsx';
import { useToast } from '../../lib/ToastContext.jsx';
import { fetchReleaseQueue, forceRelease } from '../../lib/admin.js';
import { formatNaira } from '../../lib/money.js';
import { maskPhone } from '../../lib/privacy.js';
import { dateTime } from '../../lib/time.js';

export default function AdminEscrow({ operator }) {
  const qc = useQueryClient();
  const toast = useToast();
  const isOwner = operator?.level === 'owner';
  const [releasing, setReleasing] = useState(null);

  const { data: queue, isLoading } = useQuery({
    queryKey: ['admin', 'escrow'],
    queryFn: fetchReleaseQueue,
  });

  const release = useMutation({
    mutationFn: ({ orderId, reason }) => forceRelease(orderId, reason),
    onSuccess: () => {
      toast('Funds released', 'success');
      setReleasing(null);
      qc.invalidateQueries({ queryKey: ['admin'] });
    },
    onError: (e) => toast(e.message, 'error'),
  });

  const overdue = (queue ?? []).filter((o) => o.overdue);

  return (
    <>
      <PageHeader
        title="Release queue"
        subtitle={queue ? `${queue.length} held · ${overdue.length} past deadline` : 'Funds waiting on a buyer.'}
      />

      {overdue.length ? (
        <p className="mb-4 flex items-start gap-2 rounded-card border border-red/30 bg-red-lt p-3 text-xs leading-relaxed text-red">
          <Icon name="disputes" className="mt-px h-4 w-4 shrink-0" />
          <span>
            These should have released automatically. If the hourly sweep were
            running, nothing would sit here past its deadline — check the
            Worker's cron trigger before releasing by hand.
          </span>
        </p>
      ) : null}

      <div className="card overflow-hidden">
        {isLoading ? (
          <LoadingRows rows={5} className="p-4" />
        ) : !queue?.length ? (
          <EmptyState
            icon="payouts"
            title="Nothing held"
            body="Orders in escrow appear here until the buyer confirms or the deadline passes."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-muted">
                  <th className="px-4 py-2.5 font-medium">Order</th>
                  <th className="px-4 py-2.5 font-medium">Store</th>
                  <th className="px-4 py-2.5 font-medium">Buyer</th>
                  <th className="px-4 py-2.5 font-medium">Held</th>
                  <th className="px-4 py-2.5 font-medium">Seller gets</th>
                  <th className="px-4 py-2.5 font-medium">Deadline</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {queue.map((o) => (
                  <tr key={o.id} className={`border-b border-line/60 last:border-0 ${o.overdue ? 'bg-red-lt/40' : ''}`}>
                    <td className="whitespace-nowrap px-4 py-3 font-medium text-ink">{o.order_code}</td>
                    <td className="px-4 py-3">{o.tenant_name ?? '—'}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted">
                      {o.buyer?.name || maskPhone(o.buyer?.phone)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums">{formatNaira(o.amount)}</td>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums text-muted">
                      {formatNaira(o.seller_receives)}
                    </td>
                    <td className={`whitespace-nowrap px-4 py-3 ${o.overdue ? 'font-medium text-red' : 'text-muted'}`}>
                      {dateTime(o.confirm_deadline)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {isOwner ? (
                        <button
                          type="button"
                          onClick={() => setReleasing(o)}
                          className="rounded-pill border border-line px-3 py-1 text-xs font-medium text-ink hover:bg-surface-2"
                        >
                          Release
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* A reason is required, not optional. Releasing somebody's money by hand
          is exactly the action a log needs to explain six weeks later, and a
          blank field would make the audit row useless at the moment it
          mattered. */}
      {releasing ? (
        <ReleaseDialog
          order={releasing}
          pending={release.isPending}
          onCancel={() => setReleasing(null)}
          onConfirm={(reason) => release.mutate({ orderId: releasing.id, reason })}
        />
      ) : null}
    </>
  );
}

function ReleaseDialog({ order, pending, onCancel, onConfirm }) {
  const [reason, setReason] = useState('');

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-4">
      <div className="card w-full max-w-sm p-5">
        <h2 className="font-display text-base font-semibold text-ink">
          Release {formatNaira(order.amount)}?
        </h2>
        <p className="mt-1 text-sm text-muted">
          {order.order_code} · {order.tenant_name}. The seller receives{' '}
          {formatNaira(order.seller_receives)}. This cannot be undone.
        </p>

        <label className="mt-4 block">
          <span className="mb-1 block text-xs font-medium text-muted">
            Why are you releasing this?
          </span>
          <input
            type="text"
            value={reason}
            autoFocus
            onChange={(e) => setReason(e.target.value)}
            placeholder="Buyer confirmed by phone"
            className="w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-green/40"
          />
        </label>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-pill border border-line py-2 text-sm font-medium text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!reason.trim() || pending}
            onClick={() => onConfirm(reason.trim())}
            className="flex-1 rounded-pill bg-green py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {pending ? 'Releasing…' : 'Release'}
          </button>
        </div>
      </div>
    </div>
  );
}
