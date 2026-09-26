import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../lib/ToastContext.jsx';
import { fetchRefund, previewRefund, refundOrder } from '../lib/orders.js';
import { formatNaira } from '../lib/money.js';
import { dateTime } from '../lib/time.js';
import { keys } from '../lib/queryKeys.js';

// Refunding a buyer from the order screen, and what became of it.
//
// Only while Vendwyze still holds the payment: in escrow, or before the store's
// payout has gone out. After that the buyer opens a dispute. The buyer gets
// back what they paid less Paystack's processing fee, which Paystack keeps on
// a refund. See worker/lib/refunds.js.

const HELD = (o) => o.escrow_status === 'held' || (o.escrow_status === 'none' && ['paid', 'processing'].includes(o.status));

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
  if (!order.paid_at || !HELD(order)) return null;
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
        {Number(refund.fee) > 0 ? (
          <div className="flex justify-between">
            <dt className="text-muted">Paystack's fee (kept by Paystack)</dt>
            <dd className="text-ink">{formatNaira(refund.fee)}</dd>
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
          Give the buyer their money back, for example if the item is no longer available. Possible until the payment
          is released to you.
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
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted">Buyer paid</dt>
              <dd className="text-ink">{formatNaira(p.paid)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Paystack's fee</dt>
              <dd className="text-ink">{p.fee == null ? 'worked out on refund' : `−${formatNaira(p.fee)}`}</dd>
            </div>
            <div className="flex justify-between font-semibold">
              <dt className="text-ink">Back to the buyer</dt>
              <dd className="text-ink">{p.amount == null ? 'paid less the fee' : formatNaira(p.amount)}</dd>
            </div>
          </dl>
          <p className="rounded-lg bg-green-lt px-3 py-2 text-xs text-green">
            You haven't been paid for this sale yet, so nothing comes out of your payouts. Paystack keeps its fee on a
            refund, so the buyer carries that.
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
            {send.isPending ? 'Refunding…' : p.amount == null ? 'Refund buyer' : `Refund ${formatNaira(p.amount)}`}
          </button>
        ) : null}
        <button type="button" onClick={() => setOpen(false)} className="px-2 text-xs text-muted hover:text-text">
          Cancel
        </button>
      </div>
    </div>
  );
}
