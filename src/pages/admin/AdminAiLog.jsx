import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import PageHeader from '../../components/ui/PageHeader.jsx';
import EmptyState, { LoadingRows } from '../../components/ui/EmptyState.jsx';
import { fetchAiLog } from '../../lib/admin.js';
import { dateTime } from '../../lib/time.js';

// Every call the photo-review AI made: which store and item, how many photos,
// the tokens it took, what it cost, and exactly what it answered.
//
// Cost is the service's own figure, from the prices in its .env. Until those
// are set it is empty and the tokens are the measure — said so on the page
// rather than shown as $0, which would read as "free".

const PERIODS = { today: 'Today', '7d': 'Last 7 days', '30d': 'Last 30 days', all: 'All time' };

const tokens = (n) => Number(n ?? 0).toLocaleString('en-NG');
const usd = (n) => `$${Number(n).toFixed(Number(n) < 1 ? 4 : 2)}`;

export default function AdminAiLog() {
  const [tenant, setTenant] = useState('');

  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['admin', 'ai', tenant],
    queryFn: ({ pageParam }) => fetchAiLog({ tenant, before: pageParam }),
    initialPageParam: null,
    getNextPageParam: (last) => last.next ?? undefined,
  });

  const first = data?.pages[0];
  const calls = data?.pages.flatMap((p) => p.calls) ?? [];

  return (
    <>
      <PageHeader title="AI log" subtitle="Every photo-review call: what it was asked, what it answered, and what it used." />

      <StoreFilter stores={first?.tenants} value={tenant} onChange={setTenant} />

      {first ? <Totals totals={first.totals} /> : null}

      <div className="card mt-4 overflow-hidden">
        {isLoading ? (
          <LoadingRows rows={5} className="p-4" />
        ) : isError ? (
          <p className="p-4 text-sm text-muted">Couldn't load the AI log. Refresh to try again.</p>
        ) : !calls.length ? (
          <EmptyState icon="analytics" title="No AI calls yet" body="They appear here as sellers send photos to stores using the photo check." />
        ) : (
          <ol className="divide-y divide-line">
            {calls.map((c) => (
              <Call key={c.id} call={c} />
            ))}
          </ol>
        )}
      </div>

      {hasNextPage ? (
        <button
          type="button"
          onClick={() => fetchNextPage()}
          disabled={isFetchingNextPage}
          className="mt-3 rounded-pill border border-line px-4 py-2 text-sm text-ink disabled:opacity-60"
        >
          {isFetchingNextPage ? 'Loading…' : 'Older calls'}
        </button>
      ) : null}
    </>
  );
}

export function StoreFilter({ stores, value, onChange }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-muted">Store</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm outline-none focus:border-green/40"
      >
        <option value="">All stores</option>
        {(stores ?? []).map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function Totals({ totals }) {
  return (
    <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
      {totals.map((t) => {
        const unpriced = Number(t.unpriced_calls);
        const calls = Number(t.calls);
        return (
          <div key={t.period} className="card p-4">
            <p className="text-xs text-muted">{PERIODS[t.period] ?? t.period}</p>
            <p className="mt-1 font-display text-xl font-semibold text-ink">
              {calls ? (unpriced === calls ? '—' : usd(t.cost_usd)) : usd(0)}
            </p>
            <p className="mt-1 text-[11px] text-muted">
              {calls} call{calls === 1 ? '' : 's'} · {t.images} photo{Number(t.images) === 1 ? '' : 's'}
            </p>
            <p className="text-[11px] text-muted">
              {tokens(t.input_tokens)} in · {tokens(t.output_tokens)} out
            </p>
            {unpriced ? (
              <p className="mt-1 text-[11px] text-amber">
                {unpriced === calls ? 'No prices set on the service' : `${unpriced} without a price`}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function Call({ call }) {
  const [open, setOpen] = useState(null);
  const reply = pretty(call.response);

  return (
    <li className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">
            {call.item?.title ?? 'An item'}
            <span className="font-normal text-muted">
              {' '}
              · {call.store ?? 'Unknown store'}
              {call.item?.category ? ` · ${call.item.category}` : ''}
            </span>
          </p>
          <p className="mt-0.5 text-[11px] text-muted">
            {dateTime(call.created_at)} · {call.model} · {call.images} photo{call.images === 1 ? '' : 's'}
            {call.image_detail ? ` · ${call.image_detail} detail` : ''}
            {call.images ? ` · ≈${tokens(Math.round(call.input_tokens / call.images))} tokens a photo` : ''}
          </p>
        </div>
        <div className="text-right text-[11px] text-muted">
          <p className="font-medium text-ink">{call.cost_usd == null ? 'No price' : usd(call.cost_usd)}</p>
          <p>
            {tokens(call.input_tokens)} in{call.cached_tokens ? ` (${tokens(call.cached_tokens)} cached)` : ''} ·{' '}
            {tokens(call.output_tokens)} out
          </p>
        </div>
      </div>

      <div className="mt-2 flex gap-3 text-xs">
        <Toggle on={open === 'reply'} onClick={() => setOpen(open === 'reply' ? null : 'reply')} disabled={!call.response}>
          AI reply
        </Toggle>
        <Toggle on={open === 'prompt'} onClick={() => setOpen(open === 'prompt' ? null : 'prompt')} disabled={!call.prompt}>
          What it was asked
        </Toggle>
      </div>

      {!call.response && !call.prompt ? (
        <p className="mt-1 text-[11px] text-muted">
          The question and reply weren't recorded for this call — it was made before the photo service saved them.
        </p>
      ) : null}

      {open ? (
        <pre className="scroll-thin mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-text">
          {open === 'reply' ? reply : call.prompt}
        </pre>
      ) : null}
    </li>
  );
}

function Toggle({ on, onClick, disabled, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? 'Not recorded for this call' : undefined}
      className={`underline-offset-2 hover:underline disabled:text-muted/60 disabled:no-underline ${on ? 'font-semibold text-green' : 'text-green'}`}
    >
      {on ? '▾' : '▸'} {children}
    </button>
  );
}

// The model answers in JSON; shown indented so it can be read.
function pretty(text) {
  if (!text) return '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
