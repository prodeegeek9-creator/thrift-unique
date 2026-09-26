import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../lib/ToastContext.jsx';
import { fetchRefund, previewRefund, refundOrder } from '../lib/orders.js';
import { formatNaira } from '../lib/money.js';
import { dateTime } from '../lib/time.js';
import { keys } from '../lib/queryKeys.js';

// Refunding a buyer from the order screen, and what became of it.
//
// Before anything moves, the Worker says what the refund would cost the store:
// nothing if it hasn't been paid for the sale yet, or what it received, taken
// from its next payouts, if it has. See worker/lib/refunds.js.

const PAID = ['paid', 'escrow', 'completed', 'processing'];

const STATUS = {
  pending: { tone: 'bg-amber-lt text-amber', text: 'Refund on its way to the buyer.' },
  processing: { tone: 'bg-amber-lt text-amber', text: 'Refund on its way to the buyer.' },
  processed: { tone: 'bg-green-lt text-green', text: 'Refunded to the buyer.' },
  failed: {
    tone: 'bg-red-lt text-red',
    text: "The refund hasn't gone through yet. Vendwyze has been told and will retry it.",
  },
};

export default function RefundCard({ tenantId, order, canRefund }) {
  const { data: refund, isLoading } = useQuery({
    queryKey: keys.orderRefund(tenantId, order.id),
    queryFn: () => fetchRefund(tenantId, order.id),
    enabled: Boolean(tenantId && canRefund),
  });

  if (!canRefund || isLoading) return null;
  if (refund) return <RefundStatus refund={refund} />;
  if (!order.paid_at || !PAID.includes(order.status)) return null;
  return <RefundForm tenantId={tenantId} order={order} />;
}

function RefundStatus({ refund }) {
  const s = STATUS[refund.status] ?? STATUS.pending;
  return (
    <div className="card space-y-2 p-4">
      <h2 className="text-sm font-semibold text-ink">Refund</h2>
      <p className={`rounded-lg px-3 py-2 text-xs ${s.tone}`}>{s.text}</p>
      <dl className="space-y-1 text-sm">
        <div className="flex justify-between">
          <dt className="text-muted">Back to the buyer</dt>
          <dd className="text-ink">{formatNaira(refund.amount)}</dd>
        </div>
        {Number(refund.store_debt) > 0 ? (
          <div className="flex justify-between">
            <dt className="text-muted">From your next payouts</dt>
            <dd className="text-ink">{formatNaira(refund.store_debt)}</dd>
          </div>
        ) : null}
      </dl>
      {refund.reason ? <p className="text-xs text-muted">Reason: {refund.reason}</p> : null}
      <p className="text-[11px] text-muted">
        {refund.processed_at ? `Completed ${dateTime(refund.processed_at)}` : `Started ${dateTime(refund.created_at)}`}
      </p>
    </div>
  );
}

function RefundForm({ tenantId, order }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [relist, setRelist] = useState(false);

  const preview = useQuery({
    queryKey: [...keys.orderRefund(tenantId, order.id), 'preview'],
    queryFn: () => previewRefund(tenantId, order.id),
    enabled: open,
    staleTime: 0,
  });

  const send = useMutation({
    mutationFn: () => refundOrder(tenantId, order.id, { reason: reason.trim() || null, relist }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['tenant', tenantId] });
      toast(
        r.refund?.status === 'failed'
          ? "Recorded, but Paystack didn't take it yet. Vendwyze will retry."
          : 'Refund started. The buyer has been told.',
        r.refund?.status === 'failed' ? 'error' : 'success'
      );
    },
    onError: (e) => toast(e.message, 'error'),
  });

  if (!open) {
    return (
      <div className="card p-4">
        <h2 className="text-sm font-semibold text-ink">Refund</h2>
        <p className="mt-1 text-xs text-muted">
          Give the buyer their {formatNaira(order.amount)} back, for example if the item is no longer available.
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-3 rounded-pill border border-red/30 px-4 py-1.5 text-xs font-medium text-red hover:bg-red-lt"
        >
          Refund buyer
        </button>
      </div>
    );
  }

  const p = preview.data;

  return (
    <div className="card space-y-3 p-4">
      <h2 className="text-sm font-semibold text-ink">Refund this order?</h2>

      {preview.isLoading ? (
        <div className="h-12 animate-pulse rounded-lg bg-surface-2" />
      ) : preview.error ? (
        <p className="text-xs text-red">{preview.error.message}</p>
      ) : !p?.refundable ? (
        <p className="text-xs text-red">{p?.reason ?? "This order can't be refunded."}</p>
      ) : (
        <>
          <p className="text-sm text-ink">
            {formatNaira(p.amount)} goes back to the buyer's card or account.
          </p>
          <p className={`rounded-lg px-3 py-2 text-xs ${p.store_debt > 0 ? 'bg-amber-lt text-amber' : 'bg-green-lt text-green'}`}>
            {p.store_debt > 0
              ? `You've already been paid ${formatNaira(p.store_debt)} for this sale. It will come out of your next payouts.`
              : "You haven't been paid for this sale yet, so nothing comes out of your payouts."}
          </p>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Reason (the buyer sees this)</span>
            <textarea
              rows={2}
              maxLength={300}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Sorry, this item was already sold"
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-green/40"
            />
          </label>

          <label className="flex items-center gap-2 text-xs text-text">
            <input type="checkbox" checked={relist} onChange={(e) => setRelist(e.target.checked)} />
            Put the item back on sale
          </label>

          <p className="text-[11px] text-muted">A refund can't be undone.</p>
        </>
      )}

      <div className="flex flex-wrap gap-2">
        {p?.refundable ? (
          <button
            type="button"
            disabled={send.isPending}
            onClick={() => send.mutate()}
            className="rounded-pill bg-red px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
          >
            {send.isPending ? 'Refunding…' : `Refund ${formatNaira(p.amount)}`}
          </button>
        ) : null}
        <button type="button" onClick={() => setOpen(false)} className="px-2 text-xs text-muted hover:text-text">
          Cancel
        </button>
      </div>
    </div>
  );
}
