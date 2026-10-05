import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Icon from './ui/Icon.jsx';
import { useTenant } from '../lib/TenantContext.jsx';
import { useToast } from '../lib/ToastContext.jsx';
import { fetchBotHolds, resumeBot } from '../lib/waha.js';
import { dateTime } from '../lib/time.js';

// When the owner types in a chat on the store's number, the bot steps back
// from that chat for a while so it never talks over them. This shows which
// chats it is holding off in, and hands the chat back to the bot on request.
//
// With nothing on hold, the button is there but greyed out: the bot is
// already answering everyone.

export default function BotHolds() {
  const { tenant } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();
  const tenantId = tenant?.id;
  const key = ['tenant', tenantId, 'bot-holds'];

  const { data, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => fetchBotHolds(tenantId),
    enabled: Boolean(tenantId && tenant?.waha_status),
    refetchInterval: 60_000,
  });

  const resume = useMutation({
    mutationFn: (chat) => resumeBot(tenantId, chat),
    onSuccess: (r, chat) => {
      toast(chat ? 'The bot is answering in that chat again.' : 'The bot is answering in every chat again.', 'success');
      qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast(e.message, 'error'),
  });

  if (!tenant?.waha_status) return null;

  const holds = data?.holds ?? [];
  const held = holds.length > 0;

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-ink">
          <Icon name="whatsapp" className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">
            Your WhatsApp bot
            {isLoading ? null : (
              <span
                className={`rounded-pill px-2 py-0.5 text-[11px] font-medium ${
                  held ? 'bg-amber-lt text-amber' : 'bg-green-lt text-green'
                }`}
              >
                {held ? `On hold in ${holds.length} chat${holds.length === 1 ? '' : 's'}` : 'Active'}
              </span>
            )}
          </h2>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">
            {held
              ? "When you type in a chat, the bot stays out of it for 12 hours so it doesn't talk over you. Resume it to let it answer there again."
              : 'The bot is answering in every chat. If you type in a chat yourself, it steps back from that chat for 12 hours.'}
          </p>
        </div>
        <button
          type="button"
          disabled={!held || resume.isPending}
          onClick={() => resume.mutate(null)}
          className="shrink-0 rounded-pill bg-green px-4 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-line disabled:text-muted"
        >
          {resume.isPending && resume.variables == null ? 'One moment…' : holds.length > 1 ? 'Resume bot in all' : 'Resume bot'}
        </button>
      </div>

      {holds.length > 1 ? (
        <ul className="mt-3 divide-y divide-line rounded-lg border border-line">
          {holds.map((h) => (
            <li key={h.chat_id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate text-[13px] font-medium text-ink">{who(h)}</p>
                <p className="truncate text-[11px] text-muted">
                  {h.note ? `You: “${h.note}” · ` : ''}until {dateTime(h.until)}
                </p>
              </div>
              <button
                type="button"
                disabled={resume.isPending}
                onClick={() => resume.mutate(h.chat_id)}
                className="shrink-0 rounded-pill border border-line px-3 py-1.5 text-[11px] font-semibold text-ink hover:bg-surface-2 disabled:opacity-60"
              >
                Resume bot
              </button>
            </li>
          ))}
        </ul>
      ) : held ? (
        <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-[12px] text-text">
          <span className="font-medium text-ink">{who(holds[0])}</span>
          {holds[0].note ? <> · You: “{holds[0].note}”</> : null} · until {dateTime(holds[0].until)}
        </p>
      ) : null}
    </section>
  );
}

function who(h) {
  const phone = h.phone ? `+${h.phone}` : null;
  if (h.name && phone) return `${h.name} (${phone})`;
  return h.name ?? phone ?? 'A chat on your number';
}
