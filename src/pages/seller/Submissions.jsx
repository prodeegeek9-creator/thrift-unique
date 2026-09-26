import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import PageHeader from '../../components/ui/PageHeader.jsx';
import Icon from '../../components/ui/Icon.jsx';
import EmptyState from '../../components/ui/EmptyState.jsx';
import { useTenant } from '../../lib/TenantContext.jsx';
import { useToast } from '../../lib/ToastContext.jsx';
import {
  markConsignorPaid,
  decideSubmission,
  fetchSubmissionCounts,
  fetchSubmissions,
  sellLink,
} from '../../lib/submissions.js';
import { formatNaira } from '../../lib/money.js';
import { imageUrl } from '../../lib/images.js';
import { relative } from '../../lib/time.js';
import { keys, tenantScope } from '../../lib/queryKeys.js';

// Items people have brought to the store, waiting for a yes or a no.
//
// People message the store's own WhatsApp with SELL (the link below types it
// for them); the bot takes photos, a name, their price and the condition, and
// the item lands here. Approving lists it — at the store's price, which can be
// above what they asked — posts it to Status and sends them the link.
// Declining tells them, with the reason if one is given.

const CONDITION = {
  brand_new: 'Brand new',
  excellent: 'Excellent',
  good: 'Good',
  fair: 'Fair',
};

const TABS = [
  { id: 'pending', label: 'To review' },
  { id: 'listed', label: 'Listed' },
  { id: 'topay', label: 'Sold · to pay' },
  { id: 'paid', label: 'Paid' },
  { id: 'declined', label: 'Declined' },
];

const EMPTY = {
  pending: ['Nothing to review', 'When somebody sends you an item on WhatsApp, it shows up here for you to approve.'],
  listed: ['Nothing listed yet', null],
  topay: ['Nobody to pay', "When a seller's item sells, it shows here with what you owe them."],
  paid: ['No payments yet', null],
  declined: ['Nothing declined', null],
};

export default function Submissions() {
  const { tenant } = useTenant();
  const tenantId = tenant?.id;
  const [tab, setTab] = useState('pending');

  const { data: counts } = useQuery({
    queryKey: keys.submissionCounts(tenantId),
    queryFn: () => fetchSubmissionCounts(tenantId),
    enabled: Boolean(tenantId),
  });

  const { data: items, isLoading } = useQuery({
    queryKey: keys.submissions(tenantId, tab),
    queryFn: () => fetchSubmissions(tenantId, tab),
    enabled: Boolean(tenantId),
  });

  return (
    <>
      <PageHeader
        title="Items to review"
        subtitle="Items people have sent you to sell for them."
      />

      <InviteCard tenant={tenant} />

      {counts?.topay ? (
        <button
          type="button"
          onClick={() => setTab('topay')}
          className="mb-4 flex w-full items-center justify-between rounded-card bg-amber-lt px-4 py-3 text-left text-sm text-amber"
        >
          <span>
            You owe <b>{counts.topay}</b> seller{counts.topay === 1 ? '' : 's'} for items that sold
          </span>
          <span className="font-display text-base font-semibold">{formatNaira(counts.owed)}</span>
        </button>
      ) : null}

      <div className="mb-4 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded-pill border px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === t.id
                ? 'border-sidebar bg-sidebar text-white'
                : 'border-line bg-surface text-muted hover:text-ink'
            }`}
          >
            {t.label}
            {counts ? ` (${counts[t.id]})` : ''}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="grid gap-3 md:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-72 animate-pulse rounded-card bg-surface-2" />
          ))}
        </div>
      ) : !items?.length ? (
        <EmptyState
          icon="inbox"
          title={EMPTY[tab][0]}
          body={EMPTY[tab][1]}
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {items.map((item) => (
            <SubmissionCard key={item.id} item={item} tenantId={tenantId} />
          ))}
        </div>
      )}
    </>
  );
}

// The link that starts it all, and whether anybody will answer it.
function InviteCard({ tenant }) {
  const toast = useToast();
  const link = sellLink(tenant);
  const linked = tenant?.waha_status === 'WORKING';

  if (!linked) {
    return (
      <section className="mb-4 rounded-card bg-amber-lt p-4 text-sm text-amber">
        <p className="font-semibold">Link your WhatsApp to receive items</p>
        <p className="mt-1 leading-relaxed">
          People send items to your own WhatsApp number, so it has to be linked first.{' '}
          <Link to="/dashboard/channels#whatsapp" className="font-semibold underline">
            Link it in Channels
          </Link>
          .
        </p>
      </section>
    );
  }

  return (
    <section className="card mb-4 p-4">
      <p className="text-sm font-semibold text-ink">Your “Sell with us” link</p>
      <p className="mt-1 text-sm leading-relaxed text-muted">
        Share it on your Status, Instagram bio or anywhere people ask how to sell through you. It
        opens a chat with your number and the bot takes their item details. Your normal chats are
        left alone: the bot only answers messages that start with <b>SELL</b>.
      </p>
      {link ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink">
            {link}
          </code>
          <button
            type="button"
            onClick={() =>
              navigator.clipboard
                ?.writeText(link)
                .then(() => toast('Link copied', 'success'))
                .catch(() => toast('Could not copy that link', 'error'))
            }
            className="rounded-pill bg-green px-4 py-2 text-xs font-semibold text-white"
          >
            Copy link
          </button>
        </div>
      ) : null}
    </section>
  );
}

function SubmissionCard({ item, tenantId }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [price, setPrice] = useState(String(Number(item.asking_price)));
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');

  const decide = useMutation({
    mutationFn: (decision) => decideSubmission(tenantId, item.id, decision),
    onSuccess: (result) => {
      qc.invalidateQueries(tenantScope(tenantId));
      const told = result.notified
        ? 'The seller has been told on WhatsApp.'
        : "Your WhatsApp isn't linked, so the seller wasn't told.";
      toast(result.status === 'approved' ? `Listed. ${told}` : `Declined. ${told}`, 'success');
    },
    onError: (err) => toast(err.message ?? 'Something went wrong', 'error'),
  });

  const pending = item.status === 'pending';
  const markup = Number(String(price).replace(/[₦,\s]/g, '')) - Number(item.asking_price);

  return (
    <article className="card overflow-hidden">
      <div className="flex gap-1 overflow-x-auto bg-surface-2">
        {(item.images ?? []).map((path) => (
          <a
            key={path}
            href={imageUrl(path)}
            target="_blank"
            rel="noreferrer"
            className={item.images.length === 1 ? 'w-full' : 'shrink-0'}
          >
            <img
              src={imageUrl(path)}
              alt=""
              className={`h-44 object-cover ${item.images.length === 1 ? 'w-full' : 'w-44'}`}
            />
          </a>
        ))}
      </div>

      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-ink">{item.title}</h3>
            <p className="mt-0.5 text-xs text-muted">
              {CONDITION[item.condition] ?? item.condition} · {relative(item.created_at)}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[11px] text-muted">They want</p>
            <p className="font-display text-base font-semibold text-ink">
              {formatNaira(item.asking_price)}
            </p>
          </div>
        </div>

        <p className="mt-2 text-xs text-muted">
          From <span className="font-medium text-ink">{item.seller_name ?? 'someone'}</span>
          {item.seller_phone ? (
            <>
              {' · '}
              <a href={`https://wa.me/${item.seller_phone}`} className="text-green">
                +{item.seller_phone}
              </a>
            </>
          ) : null}
        </p>

        {item.status === 'declined' && item.decline_reason ? (
          <p className="mt-2 text-xs text-muted">Reason: {item.decline_reason}</p>
        ) : null}

        {item.sold_at ? <ConsignorPayment item={item} tenantId={tenantId} /> : null}

        {pending && !declining ? (
          <div className="mt-4 border-t border-line pt-4">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Your selling price</span>
              <input
                inputMode="numeric"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-green/40"
              />
              <span className="mt-1 block text-[11px] text-muted">
                {markup > 0
                  ? `${formatNaira(markup)} above what they asked.`
                  : 'Same as what they asked. Set it higher to keep a margin.'}
              </span>
            </label>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={decide.isPending}
                onClick={() => decide.mutate({ decision: 'approve', price })}
                className="flex-1 rounded-pill bg-green py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                <Icon name="check" className="mr-1 inline h-4 w-4" />
                Approve &amp; list
              </button>
              <button
                type="button"
                disabled={decide.isPending}
                onClick={() => setDeclining(true)}
                className="rounded-pill border border-line px-4 py-2 text-sm font-medium text-ink hover:bg-surface-2 disabled:opacity-60"
              >
                Decline
              </button>
            </div>
          </div>
        ) : null}

        {pending && declining ? (
          <div className="mt-4 border-t border-line pt-4">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">
                Reason (optional, sent to them)
              </span>
              <textarea
                value={reason}
                maxLength={300}
                rows={2}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. We're not taking shoes right now."
                className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-green/40"
              />
            </label>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={decide.isPending}
                onClick={() => decide.mutate({ decision: 'decline', reason })}
                className="flex-1 rounded-pill bg-red py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                Decline item
              </button>
              <button
                type="button"
                onClick={() => setDeclining(false)}
                className="rounded-pill border border-line px-4 py-2 text-sm font-medium text-ink hover:bg-surface-2"
              >
                Back
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </article>
  );
}

// Sold: what the store owes this seller, and "Mark paid" once it has paid them
// (by transfer, cash, however it always has). The seller is told on WhatsApp.
function ConsignorPayment({ item, tenantId }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { role } = useTenant();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const owed = item.owed_amount ?? item.asking_price;

  const pay = useMutation({
    mutationFn: () => markConsignorPaid(tenantId, item.id, note),
    onSuccess: (r) => {
      qc.invalidateQueries(tenantScope(tenantId));
      toast(
        r.notified ? 'Marked paid. They have been told on WhatsApp.' : "Marked paid. Your WhatsApp isn't linked, so they weren't told.",
        'success'
      );
    },
    onError: (e) => toast(e.message, 'error'),
  });

  if (item.consignor_paid_at) {
    return (
      <p className="mt-3 rounded-lg bg-green-lt px-3 py-2 text-xs text-green">
        Paid {formatNaira(owed)} on {new Date(item.consignor_paid_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}
        {item.consignor_paid_note ? ` · ${item.consignor_paid_note}` : ''}
      </p>
    );
  }

  const canPay = role === 'owner' || role === 'manager';

  return (
    <div className="mt-3 border-t border-line pt-3">
      <p className="text-sm text-ink">
        Sold {relative(item.sold_at).toLowerCase()} · you owe {item.seller_name ?? 'them'}{' '}
        <b>{formatNaira(owed)}</b>
      </p>
      {!canPay ? null : open ? (
        <div className="mt-2 space-y-2">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={200}
            placeholder="Optional note for them, e.g. Sent to your GTBank"
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-green/40"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pay.isPending}
              onClick={() => pay.mutate()}
              className="flex-1 rounded-pill bg-green py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {pay.isPending ? 'Saving…' : `I've paid ${formatNaira(owed)}`}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="rounded-pill border border-line px-4 text-sm text-ink">
              Back
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-2 w-full rounded-pill border border-green py-2 text-sm font-semibold text-green hover:bg-green-lt"
        >
          Mark paid
        </button>
      )}
    </div>
  );
}
