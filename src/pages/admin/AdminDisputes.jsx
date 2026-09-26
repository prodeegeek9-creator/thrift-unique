import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import PageHeader from '../../components/ui/PageHeader.jsx';
import StatusPill from '../../components/ui/StatusPill.jsx';
import EmptyState, { LoadingRows } from '../../components/ui/EmptyState.jsx';
import { useToast } from '../../lib/ToastContext.jsx';
import { fetchDisputes, resolveDispute } from '../../lib/admin.js';
import { formatNaira } from '../../lib/money.js';
import { dateOnly } from '../../lib/time.js';

// Resolving is the one thing a tenant may never do to a dispute raised against
// them — the policies allow insert only. It lands here instead.
const OUTCOMES = [
  {
    id: 'released',
    label: 'Seller was right',
    detail: 'Release the held funds to the seller.',
    tone: 'green',
  },
  {
    id: 'refunded',
    label: 'Buyer was right',
    detail: 'Refund the buyer in full to their card, through Paystack. Needs an owner.',
    tone: 'red',
  },
  {
    id: 'no_action',
    label: 'Nothing owed',
    detail: 'Close it without moving money.',
    tone: 'neutral',
  },
];

export default function AdminDisputes() {
  const qc = useQueryClient();
  const toast = useToast();
  const [working, setWorking] = useState(null);

  const { data: disputes, isLoading } = useQuery({
    queryKey: ['admin', 'disputes'],
    queryFn: fetchDisputes,
  });

  const resolve = useMutation({
    mutationFn: ({ id, outcome, resolution }) => resolveDispute(id, outcome, resolution),
    onSuccess: (r) => {
      toast(
        r.moved === 'refunded'
          ? 'Refund sent to Paystack'
          : r.moved === 'refund_failed'
            ? 'Resolved, but Paystack refused the refund. Retry it under Refunds.'
            : r.moved === 'released'
              ? 'Funds released'
              : 'Closed',
        r.moved === 'refund_failed' ? 'error' : 'success'
      );
      setWorking(null);
      qc.invalidateQueries({ queryKey: ['admin'] });
    },
    onError: (e) => toast(e.message, 'error'),
  });

  const open = (disputes ?? []).filter((d) => d.status !== 'resolved');

  return (
    <>
      <PageHeader
        title="Disputes"
        subtitle={disputes ? `${open.length} open of ${disputes.length}` : 'Across every store.'}
      />

      {isLoading ? (
        <LoadingRows rows={3} />
      ) : !disputes?.length ? (
        <EmptyState icon="disputes" title="No disputes" body="Nothing has gone wrong yet." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {disputes.map((d) => (
            <article key={d.id} className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">
                    {d.order?.order_code ?? 'Order'}{' '}
                    <span className="font-normal text-muted">· {d.tenant_name}</span>
                  </p>
                  <p className="mt-1 text-sm leading-snug text-text">{d.reason}</p>
                </div>
                <StatusPill status={d.status} />
              </div>

              <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
                <span className="font-display text-base font-semibold text-ink">
                  {formatNaira(d.order?.amount ?? 0)}
                </span>
                <span className="text-xs text-muted">
                  {d.order?.escrow_status === 'held' ? 'Funds held' : d.order?.escrow_status} ·{' '}
                  {dateOnly(d.created_at)}
                </span>
              </div>

              {d.status === 'resolved' ? (
                <div className="mt-3 rounded-lg bg-surface-2 p-3">
                  <p className="text-xs font-medium capitalize text-ink">{d.outcome?.replace('_', ' ')}</p>
                  {d.resolution ? <p className="mt-0.5 text-xs text-muted">{d.resolution}</p> : null}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setWorking(d)}
                  className="mt-3 w-full rounded-pill bg-sidebar py-2 text-xs font-semibold text-white"
                >
                  Resolve
                </button>
              )}
            </article>
          ))}
        </div>
      )}

      {working ? (
        <ResolveDialog
          dispute={working}
          pending={resolve.isPending}
          onCancel={() => setWorking(null)}
          onConfirm={(outcome, resolution) =>
            resolve.mutate({ id: working.id, outcome, resolution })
          }
        />
      ) : null}
    </>
  );
}

function ResolveDialog({ dispute, pending, onCancel, onConfirm }) {
  const [outcome, setOutcome] = useState(null);
  const [note, setNote] = useState('');
  const held = dispute.order?.escrow_status === 'held';

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-4">
      <div className="card max-h-[90dvh] w-full max-w-md overflow-y-auto p-5">
        <h2 className="font-display text-base font-semibold text-ink">
          Resolve {dispute.order?.order_code}
        </h2>
        <p className="mt-1 text-sm text-muted">
          {dispute.tenant_name} · {formatNaira(dispute.order?.amount ?? 0)}
          {held ? ' held in escrow' : ' — no funds held'}
        </p>
        <p className="mt-2 rounded-lg bg-surface-2 p-2.5 text-xs text-text">{dispute.reason}</p>

        <div className="mt-4 space-y-2">
          {OUTCOMES.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => setOutcome(o.id)}
              className={`block w-full rounded-lg border p-3 text-left transition-colors ${
                outcome === o.id ? 'border-green bg-green-lt' : 'border-line hover:bg-surface-2'
              }`}
            >
              <span className="block text-sm font-medium text-ink">{o.label}</span>
              <span className="block text-xs text-muted">{o.detail}</span>
              {!held && o.id !== 'no_action' ? (
                <span className="mt-1 block text-[11px] text-amber">
                  No funds are held — this records the decision only.
                </span>
              ) : null}
            </button>
          ))}
        </div>

        <label className="mt-4 block">
          <span className="mb-1 block text-xs font-medium text-muted">
            What did you decide, and why?
          </span>
          <textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Tracking shows delivered and signed for"
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
            disabled={!outcome || !note.trim() || pending}
            onClick={() => onConfirm(outcome, note.trim())}
            className="flex-1 rounded-pill bg-green py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {pending ? 'Saving…' : 'Resolve'}
          </button>
        </div>
      </div>
    </div>
  );
}
