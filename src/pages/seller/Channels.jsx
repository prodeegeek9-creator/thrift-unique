import { useQuery } from '@tanstack/react-query';
import PageHeader from '../../components/ui/PageHeader.jsx';
import Icon from '../../components/ui/Icon.jsx';
import TierBadge from '../../components/ui/TierBadge.jsx';
import WhatsappLink from '../../components/WhatsappLink.jsx';
import BotHolds from '../../components/BotHolds.jsx';
import { useTenant } from '../../lib/TenantContext.jsx';
import { fetchChannels, whatsappState } from '../../lib/channels.js';
import { keys } from '../../lib/queryKeys.js';

const STATE_COPY = {
  connected: { label: 'Connected', cls: 'bg-green-lt text-green' },
  disconnected: { label: 'Not connected', cls: 'bg-surface-2 text-muted' },
  expired: { label: 'Reconnect needed', cls: 'bg-amber-lt text-amber' },
  locked: { label: 'Not on your plan', cls: 'bg-surface-2 text-muted' },
};

export default function Channels() {
  const { tenant } = useTenant();
  const tenantId = tenant?.id;

  const { data: channels, isLoading } = useQuery({
    queryKey: keys.channels(tenantId),
    queryFn: () => fetchChannels(tenantId, tenant),
    enabled: Boolean(tenantId),
  });

  const waState = whatsappState(tenant);

  return (
    <>
      <PageHeader title="Channels" subtitle="Where your listings get posted." />

      {/* First, above everything: on Starter this is the only channel there
          is, and on every tier it is the one that can break silently. */}
      <div className="mb-4 space-y-4">
        <WhatsappLink />
        <BotHolds />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card divide-y divide-line">
          <h2 className="px-4 py-3 text-sm font-semibold text-ink">Your connected channels</h2>

          {isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-12 animate-pulse rounded-lg bg-surface-2" />
              ))}
            </div>
          ) : (
            channels?.map((c) => {
              // WhatsApp is never "connected" in the OAuth sense — the seller
              // scanned a QR code once and the platform routes their session.
              const state = c.id === 'whatsapp' ? waState : c.state;
              const copy = STATE_COPY[state] ?? STATE_COPY.disconnected;

              return (
                <div key={c.id} className="flex items-center gap-3 p-4">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-ink">
                    <Icon name={c.id} className="h-4 w-4" />
                  </span>

                  <div className="min-w-0 flex-1 leading-tight">
                    <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
                      {c.label}
                      <TierBadge flag={c.flag} unlocked={c.unlocked} />
                    </p>
                    {c.accountName ? (
                      <p className="truncate text-xs text-muted">{c.accountName}</p>
                    ) : null}
                  </div>

                  <span className={`shrink-0 rounded-pill px-2 py-1 text-[11px] font-medium ${copy.cls}`}>
                    {copy.label}
                  </span>
                </div>
              );
            })
          )}
        </section>

        <section className="card h-fit p-4">
          <h2 className="text-sm font-semibold text-ink">Automatic publishing</h2>
          <p className="mt-1 text-xs text-muted">
            When you list an item, we post it to these straight away.
          </p>

          <div className="mt-4 space-y-3">
            {channels?.map((c) => {
              const state = c.id === 'whatsapp' ? waState : c.state;
              const on = state === 'connected';

              return (
                <div key={c.id} className="flex items-center gap-3">
                  <Icon name={c.id} className="h-4 w-4 shrink-0 text-muted" />
                  <span className="flex-1 text-[13px] text-text">{c.label}</span>
                  {/* Presentational: it reflects whether the channel is wired
                      up, and cannot be toggled until the Worker owns
                      publishing. A switch that looks live and changes nothing
                      is worse than one that is visibly not ready. */}
                  <span
                    role="img"
                    aria-label={`${c.label}: ${on ? 'on' : 'off'}`}
                    className={`h-5 w-9 rounded-pill p-0.5 transition-colors ${
                      on ? 'bg-green' : 'bg-line'
                    }`}
                  >
                    <span
                      className={`block h-4 w-4 rounded-full bg-white transition-transform ${
                        on ? 'translate-x-4' : ''
                      }`}
                    />
                  </span>
                </div>
              );
            })}
          </div>

          <p className="mt-4 flex gap-2 rounded-lg bg-surface-2 p-3 text-[11px] leading-relaxed text-muted">
            <Icon name="help" className="mt-px h-3.5 w-3.5 shrink-0" />
            Instagram needs a Business or Creator account linked to a Facebook
            Page. A personal account cannot be posted to.
          </p>
        </section>
      </div>
    </>
  );
}
