import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import PageHeader from '../../components/ui/PageHeader.jsx';
import EmptyState, { LoadingRows } from '../../components/ui/EmptyState.jsx';
import Icon from '../../components/ui/Icon.jsx';
import { fetchBotLog } from '../../lib/admin.js';
import { dateTime } from '../../lib/time.js';
import { StoreFilter } from './AdminAiLog.jsx';

// The bot's WhatsApp chats as it logged them: what came in, what it said back,
// and what the photo-review AI sent on its own. For support — "what did the
// bot tell this seller?" — so it reads like the chat did.
//
// Only messages the bot handled are here. A customer talking to a store, with
// no bot involved, was never stored and so can't be shown.

export default function AdminBotLog() {
  const [tenant, setTenant] = useState('');
  const [open, setOpen] = useState(null); // { tenant_id, chat_id }

  if (open) return <Thread chat={open} onBack={() => setOpen(null)} />;

  return <Chats tenant={tenant} setTenant={setTenant} onOpen={setOpen} />;
}

function Chats({ tenant, setTenant, onOpen }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin', 'bot', tenant],
    queryFn: () => fetchBotLog({ tenant }),
  });

  return (
    <>
      <PageHeader title="Bot chats" subtitle="Conversations the WhatsApp bot handled, newest first." />
      <StoreFilter stores={data?.tenants} value={tenant} onChange={setTenant} />

      <div className="card mt-4 overflow-hidden">
        {isLoading ? (
          <LoadingRows rows={6} className="p-4" />
        ) : isError ? (
          <p className="p-4 text-sm text-muted">Couldn't load the chats. Refresh to try again.</p>
        ) : !data?.chats?.length ? (
          <EmptyState icon="whatsapp" title="No chats yet" body="They appear here once the bot answers someone." />
        ) : (
          <ul className="divide-y divide-line">
            {data.chats.map((c) => (
              <li key={`${c.tenant_id}|${c.chat_id}`}>
                <button
                  type="button"
                  onClick={() => onOpen({ tenant_id: c.tenant_id, chat_id: c.chat_id })}
                  className="flex w-full items-start gap-3 p-4 text-left hover:bg-surface-2"
                >
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-green-lt text-green">
                    <Icon name="whatsapp" className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">
                      {c.who ?? shortId(c.chat_id)}
                      <span className="font-normal text-muted"> · {c.store ?? 'Unknown store'}</span>
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted">
                      {c.last.direction === 'out' ? (c.last.source === 'photo_review' ? 'AI: ' : 'Bot: ') : ''}
                      {preview(c.last)}
                    </p>
                  </div>
                  <div className="shrink-0 text-right text-[11px] text-muted">
                    <p>{dateTime(c.last_at)}</p>
                    <p>{c.messages}+ messages</p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function Thread({ chat, onBack }) {
  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['admin', 'bot', chat.tenant_id, chat.chat_id],
    queryFn: ({ pageParam }) => fetchBotLog({ tenant: chat.tenant_id, chat: chat.chat_id, before: pageParam }),
    initialPageParam: null,
    getNextPageParam: (last) => last.next ?? undefined,
  });

  const info = data?.pages[0]?.chat;
  // Pages come newest-first; each page is already oldest-first inside.
  const messages = [...(data?.pages ?? [])].reverse().flatMap((p) => p.messages);

  return (
    <>
      <button type="button" onClick={onBack} className="mb-3 flex items-center gap-1 text-sm text-green">
        <Icon name="back" className="h-4 w-4" /> All chats
      </button>
      <PageHeader
        title={info?.who ?? shortId(chat.chat_id)}
        subtitle={`${info?.store ?? ''}${info?.store ? ' · ' : ''}${chat.chat_id}`}
      />

      {hasNextPage ? (
        <button
          type="button"
          onClick={() => fetchNextPage()}
          disabled={isFetchingNextPage}
          className="mb-3 rounded-pill border border-line px-4 py-2 text-sm text-ink disabled:opacity-60"
        >
          {isFetchingNextPage ? 'Loading…' : 'Earlier messages'}
        </button>
      ) : null}

      <div className="card space-y-2 p-4">
        {isLoading ? (
          <LoadingRows rows={6} />
        ) : isError ? (
          <p className="text-sm text-muted">Couldn't load this chat. Refresh to try again.</p>
        ) : !messages.length ? (
          <p className="text-sm text-muted">No messages.</p>
        ) : (
          messages.map((m) => <Bubble key={m.id} message={m} />)
        )}
      </div>
    </>
  );
}

function Bubble({ message: m }) {
  const out = m.direction === 'out';
  const ai = m.source === 'photo_review';
  return (
    <div className={`flex ${out ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
          out ? (ai ? 'bg-amber-lt text-ink' : 'bg-green-lt text-ink') : 'bg-surface-2 text-ink'
        }`}
      >
        <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
          {out ? (ai ? 'Photo-review AI' : 'Bot') : 'Them'}
        </p>
        {m.has_media ? <p className="text-xs text-muted">📷 Photo</p> : null}
        {m.body ? <p className="whitespace-pre-wrap break-words">{m.body}</p> : null}
        <p className="mt-1 text-right text-[10px] text-muted">{dateTime(m.created_at)}</p>
      </div>
    </div>
  );
}

function preview(last) {
  if (last.body) return last.body.replace(/\s+/g, ' ');
  return last.has_media ? '📷 Photo' : '';
}

// WhatsApp ids are long and opaque; the digits before the @ are enough to
// tell two apart.
function shortId(chatId) {
  const head = String(chatId).split('@')[0];
  return head.length > 8 ? `…${head.slice(-6)}` : head;
}
