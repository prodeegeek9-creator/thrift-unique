import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import PageHeader from '../../components/ui/PageHeader.jsx';
import EmptyState, { LoadingRows } from '../../components/ui/EmptyState.jsx';
import { useToast } from '../../lib/ToastContext.jsx';
import { fetchMoney, resolveProblem, retryPayout, retryRefund } from '../../lib/admin.js';
import { formatNaira } from '../../lib/money.js';
import { dateTime } from '../../lib/time.js';

// Money that needs a person, in one place (GET /api/admin/money). Everything
// here used to reach nothing but the Worker's logs, or sat in a table nobody
// was looking at:
//
//   payments nobody can match   money has arrived and we don't know what for
//   payouts not getting through a store is owed money it isn't receiving
//   refunds that failed         a buyer is owed money back
//   unsigned webhook calls      often a wrong PAYSTACK_SECRET_KEY, which
//                               turns every real payment away
//
// Looking is for anyone on the admin team; acting is for owners, and every
// action is in the audit log.

export default function AdminMoney({ operator }) {
  const isOwner = operator?.level === 'owner';
  const { data, isLoading } = useQuery({ queryKey: ['admin', 'money'], queryFn: fetchMoney });

  const count =
    (data?.payments?.length ?? 0) + (data?.payouts?.length ?? 0) + (data?.refunds?.length ?? 0) + (data?.badSignatures?.length ?? 0);

  return (
    <>
      <PageHeader
        title="Money"
        subtitle={isLoading ? 'Money that needs a person.' : count ? `${count} to look at` : 'Nothing needs a person right now.'}
      />

      {isLoading ? (
        <div className="card p-4">
          <LoadingRows rows={4} />
        </div>
      ) : (
        <div className="space-y-4">
          <BadSignatures rows={data?.badSignatures ?? []} isOwner={isOwner} />
          <Payments rows={data?.payments ?? []} isOwner={isOwner} />
          <Payouts rows={data?.payouts ?? []} isOwner={isOwner} />
          <Refunds rows={data?.refunds ?? []} isOwner={isOwner} />
        </div>
      )}
    </>
  );
}

function Section({ title, why, empty, children, count }) {
  return (
    <section className="card overflow-hidden">
      <div className="border-b border-line px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          {title}
          <span
            className={`rounded-pill px-2 py-0.5 text-xs font-semibold tabular-nums ${
              count ? 'bg-red-lt text-red' : 'bg-green-lt text-green'
            }`}
          >
            {count}
          </span>
        </h2>
        <p className="mt-0.5 text-xs text-muted">{why}</p>
      </div>
      {count ? <ul className="divide-y divide-line/60">{children}</ul> : <p className="px-4 py-3 text-sm text-muted">{empty}</p>}
    </section>
  );
}

// Calls to the Paystack webhook that Paystack did not sign. Only shown when
// there are some: an empty section here would just be noise.
function BadSignatures({ rows, isOwner }) {
  if (!rows.length) return null;
  return (
    <section className="rounded-card border border-red/30 bg-red-lt p-4 text-sm text-red">
      <p className="font-semibold">Calls to the Paystack webhook that Paystack did not sign</p>
      <p className="mt-1">
        On {rows.length} day{rows.length === 1 ? '' : 's'}, most recently {dateTime(rows[0].last_seen)}. If real payments
        are not being marked paid, the Worker's PAYSTACK_SECRET_KEY is probably not the key of the Paystack account
        sending webhooks (a test key against live payments, or the other way round). Otherwise somebody is probing the
        address and can be ignored.
      </p>
      <ul className="mt-2 space-y-2">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface px-3 py-2 text-text">
            <span>
              {dateTime(r.first_seen)} to {dateTime(r.last_seen)}. {r.detail}
            </span>
            {isOwner ? <Resolve id={r.id} /> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Payments({ rows, isOwner }) {
  return (
    <Section
      title="Payments nobody can match"
      why="Paystack took this money, and no order, cart or plan fee has its reference. Find what it was for on Paystack, then settle it or refund it there."
      empty="Every payment matched something."
      count={rows.length}
    >
      {rows.map((p) => (
        <li key={p.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-sm">
          <div className="min-w-0">
            <p className="font-medium text-ink">
              {p.amount != null ? formatNaira(p.amount) : 'Amount unknown'}{' '}
              <span className="font-mono text-xs font-normal text-muted">{p.reference}</span>
            </p>
            <p className="mt-0.5 text-xs text-muted">{p.detail}</p>
            <p className="mt-0.5 text-[11px] text-muted">
              First seen {dateTime(p.first_seen)}
              {p.last_seen !== p.first_seen ? `, last ${dateTime(p.last_seen)}` : ''}
            </p>
          </div>
          {isOwner ? <Resolve id={p.id} /> : null}
        </li>
      ))}
    </Section>
  );
}

function Payouts({ rows, isOwner }) {
  const qc = useQueryClient();
  const toast = useToast();
  const retry = useMutation({
    mutationFn: (id) => retryPayout(id),
    onSuccess: (r) => {
      toast(r.ok ? 'Sent to Paystack again' : `Not sent: ${r.result}`, r.ok ? 'success' : 'error');
      qc.invalidateQueries({ queryKey: ['admin'] });
    },
    onError: (e) => toast(e.message, 'error'),
  });

  return (
    <Section
      title="Payouts not getting through"
      why="A store is owed this and hasn't received it: Paystack refused it, it ran out of attempts, or Paystack never confirmed it arrived."
      empty="Every payout owed is on its way."
      count={rows.length}
    >
      {rows.map((p) => (
        <li key={p.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-sm">
          <div className="min-w-0">
            <p className="font-medium text-ink">
              {formatNaira(p.amount)} to {p.tenant_name ?? 'a store'}{' '}
              <span className="font-mono text-xs font-normal text-muted">{p.reference}</span>
            </p>
            <p className="mt-0.5 text-xs text-red">
              {p.status === 'sending'
                ? `Sent to Paystack on ${dateTime(p.sent_at)} and never confirmed. Check the transfer on Paystack.`
                : p.failure_reason ?? `Tried ${p.attempts} times.`}
            </p>
          </div>
          {isOwner && p.status === 'pending' ? (
            <button
              type="button"
              disabled={retry.isPending}
              onClick={() => retry.mutate(p.id)}
              className="rounded-pill border border-line px-3 py-1 text-xs font-medium text-ink hover:bg-surface-2 disabled:opacity-60"
            >
              Retry
            </button>
          ) : null}
        </li>
      ))}
    </Section>
  );
}

function Refunds({ rows, isOwner }) {
  const qc = useQueryClient();
  const toast = useToast();
  const retry = useMutation({
    mutationFn: (id) => retryRefund(id),
    onSuccess: (r) => {
      toast(r.status === 'failed' ? `Still refused: ${r.failure_reason ?? 'Paystack said no'}` : 'Sent to Paystack again', r.status === 'failed' ? 'error' : 'success');
      qc.invalidateQueries({ queryKey: ['admin'] });
    },
    onError: (e) => toast(e.message, 'error'),
  });

  return (
    <Section
      title="Refunds that failed"
      why="A buyer is owed this back. Automatic ones are for a payment made after the item had sold; the buyer was told Vendwyze will refund them."
      empty="Every refund reached Paystack."
      count={rows.length}
    >
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-sm">
          <div className="min-w-0">
            <p className="font-medium text-ink">
              {formatNaira(r.amount)} to the buyer of {r.order?.order_code ?? 'an order'}
              <span className="font-normal text-muted"> · {r.tenant_name ?? 'a store'}</span>
              {r.requested_via === 'auto' ? <span className="font-normal text-muted"> · automatic, in full</span> : null}
            </p>
            <p className="mt-0.5 text-xs text-red">{r.failure_reason ?? 'Paystack refused it.'}</p>
            <p className="mt-0.5 text-[11px] text-muted">{dateTime(r.created_at)}</p>
          </div>
          {isOwner ? (
            <button
              type="button"
              disabled={retry.isPending}
              onClick={() => retry.mutate(r.id)}
              className="rounded-pill border border-line px-3 py-1 text-xs font-medium text-ink hover:bg-surface-2 disabled:opacity-60"
            >
              Retry
            </button>
          ) : null}
        </li>
      ))}
    </Section>
  );
}

// "Mark sorted", with a line on what was done. It goes in the audit log, and
// the problem opens again if Paystack sends it again.
function Resolve({ id }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const resolve = useMutation({
    mutationFn: () => resolveProblem(id, note),
    onSuccess: () => {
      toast('Marked sorted', 'success');
      qc.invalidateQueries({ queryKey: ['admin'] });
    },
    onError: (e) => toast(e.message, 'error'),
  });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="shrink-0 rounded-pill border border-line bg-surface px-3 py-1 text-xs font-medium text-ink hover:bg-surface-2"
      >
        Mark sorted
      </button>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        resolve.mutate();
      }}
      className="flex w-full flex-wrap items-center gap-2 sm:w-auto"
    >
      <input
        autoFocus
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={300}
        placeholder="What was done, e.g. refunded on Paystack"
        className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-ink outline-none focus:border-green/40 sm:w-64"
      />
      <button
        type="submit"
        disabled={resolve.isPending || note.trim().length < 3}
        className="rounded-pill bg-green px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
      >
        Save
      </button>
      <button type="button" onClick={() => setOpen(false)} className="text-xs text-muted">
        Cancel
      </button>
    </form>
  );
}
