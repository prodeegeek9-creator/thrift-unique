import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Icon from './ui/Icon.jsx';
import { useTenant } from '../lib/TenantContext.jsx';
import { useToast } from '../lib/ToastContext.jsx';
import {
  fetchWhatsappSession,
  linkWhatsapp,
  unlinkWhatsapp,
  SESSION_COPY,
  QR_POLL_MS,
} from '../lib/waha.js';

// Linking the store's own WhatsApp, by scanning a QR code once.
//
// This is the only channel a seller connects without an OAuth screen, and the
// only one that has to keep working afterwards without anybody watching: a
// phone that gets unlinked from WhatsApp's own Linked Devices list takes the
// session down silently, and the first symptom is listings quietly not
// reaching anybody's Status. So this panel shows live state rather than a
// stored boolean.

const TONE = {
  good: 'bg-green-lt text-green',
  pending: 'bg-amber-lt text-amber',
  bad: 'bg-red-lt text-red',
  idle: 'bg-surface-2 text-muted',
};

export default function WhatsappLink() {
  const { tenant, role } = useTenant();
  const qc = useQueryClient();
  const toast = useToast();

  const tenantId = tenant?.id;
  const isOwner = role === 'owner';

  const { data, isLoading } = useQuery({
    queryKey: ['tenant', tenantId, 'whatsapp-session'],
    queryFn: () => fetchWhatsappSession(tenantId),
    enabled: Boolean(tenantId),
    // Only while there is a code on screen. WAHA rotates it every twenty
    // seconds or so, and a stale QR fails to scan with no explanation — which
    // reads as broken rather than as "wait a moment".
    refetchInterval: (query) =>
      ['SCAN_QR_CODE', 'STARTING'].includes(query.state.data?.status) ? QR_POLL_MS : false,
  });

  const link = useMutation({
    mutationFn: () => linkWhatsapp(tenantId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tenant', tenantId, 'whatsapp-session'] }),
    onError: (e) => toast(e.message, 'error'),
  });

  const unlink = useMutation({
    mutationFn: () => unlinkWhatsapp(tenantId),
    onSuccess: () => {
      toast('WhatsApp unlinked', 'success');
      qc.invalidateQueries({ queryKey: ['tenant', tenantId, 'whatsapp-session'] });
    },
    onError: (e) => toast(e.message, 'error'),
  });

  const status = data?.status ?? null;
  const pairing = status === 'SCAN_QR_CODE' || status === 'STARTING';
  const copy = SESSION_COPY[status] ?? {
    label: 'Not linked',
    tone: 'idle',
    body: 'Link your WhatsApp and every item you list goes straight to your Status.',
  };

  return (
    <section className="card p-4">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-ink">
          <Icon name="whatsapp" className="h-4 w-4" />
        </span>

        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-ink">Your WhatsApp</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">{copy.body}</p>
        </div>

        <span className={`shrink-0 rounded-pill px-2 py-1 text-[11px] font-medium ${TONE[copy.tone]}`}>
          {isLoading ? 'Checking…' : copy.label}
        </span>
      </div>

      {/* WAHA answered nothing at all. Worth its own line: the difference
          between "your WhatsApp is disconnected" and "we cannot see your
          WhatsApp right now" is the difference between the seller acting and
          the seller waiting. */}
      {data?.unreachable ? (
        <p className="mt-3 flex gap-2 rounded-lg bg-amber-lt p-3 text-[11px] leading-relaxed text-amber">
          <Icon name="disputes" className="mt-px h-3.5 w-3.5 shrink-0" />
          We could not reach WhatsApp just now, so this may be out of date. Nothing
          on your side needs fixing yet.
        </p>
      ) : null}

      {data?.qr ? (
        <div className="mt-4 flex flex-col items-center gap-2 rounded-card bg-surface-2 p-4">
          <img
            src={data.qr}
            alt="QR code to link WhatsApp"
            className="h-44 w-44 rounded-lg bg-white p-2"
          />
          <p className="text-center text-[11px] leading-relaxed text-muted">
            The code refreshes every few seconds. Keep this open while you scan.
          </p>
        </div>
      ) : null}

      {isOwner ? (
        <div className="mt-4 flex gap-2">
          {status === 'WORKING' ? (
            <button
              type="button"
              onClick={() => unlink.mutate()}
              disabled={unlink.isPending}
              className="rounded-pill border border-line px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-2 disabled:opacity-50"
            >
              {unlink.isPending ? 'Unlinking…' : 'Unlink'}
            </button>
          ) : pairing ? (
            // The QR is the call to action while one is on screen, so the
            // primary button would be competing with it. What is actually
            // needed here is an escape hatch for a pairing that has stalled.
            <button
              type="button"
              onClick={() => unlink.mutate()}
              disabled={unlink.isPending}
              className="rounded-pill border border-line px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 disabled:opacity-50"
            >
              {unlink.isPending ? 'Stopping…' : 'Start over'}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => link.mutate()}
              disabled={link.isPending}
              className="rounded-pill bg-green px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              {link.isPending ? 'Starting…' : status ? 'Link again' : 'Link WhatsApp'}
            </button>
          )}
        </div>
      ) : (
        // Not an upsell — no plan fixes this, only the store owner can.
        <p className="mt-4 text-[11px] text-muted">
          Only the store owner can link or unlink WhatsApp.
        </p>
      )}
    </section>
  );
}
