import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import PageHeader from '../../components/ui/PageHeader.jsx';
import StatusPill from '../../components/ui/StatusPill.jsx';
import EmptyState, { LoadingRows } from '../../components/ui/EmptyState.jsx';
import { useTenant } from '../../lib/TenantContext.jsx';
import { fetchDisputes } from '../../lib/disputes.js';
import { formatNaira } from '../../lib/money.js';
import { dateOnly } from '../../lib/time.js';
import { keys } from '../../lib/queryKeys.js';

export default function Disputes() {
  const { tenant } = useTenant();
  const tenantId = tenant?.id;

  const { data: disputes, isLoading } = useQuery({
    queryKey: keys.disputes(tenantId),
    queryFn: () => fetchDisputes(tenantId),
    enabled: Boolean(tenantId),
  });

  const open = (disputes ?? []).filter((d) => d.status !== 'resolved').length;

  return (
    <>
      <PageHeader
        title="Disputes"
        subtitle={
          disputes?.length
            ? `${open} open`
            : 'Orders a buyer has raised a problem with.'
        }
      />

      {isLoading ? (
        <LoadingRows rows={3} />
      ) : !disputes?.length ? (
        <EmptyState
          icon="disputes"
          title="No disputes"
          body="When a buyer says an item never arrived or isn't what they expected, it lands here and our team handles the back-and-forth."
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {disputes.map((d) => (
            <article key={d.id} className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    to={`/dashboard/orders/${d.order?.id}`}
                    className="text-sm font-medium text-ink hover:underline"
                  >
                    {d.order?.order_code ?? 'Order'}
                  </Link>
                  <p className="mt-1 text-sm leading-snug text-text">{d.reason}</p>
                </div>
                <StatusPill status={d.status} />
              </div>

              <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
                <span className="font-display text-base font-semibold text-ink">
                  {formatNaira(d.order?.amount ?? 0)}
                </span>
                <span className="text-xs text-muted">Raised {dateOnly(d.created_at)}</span>
              </div>

              {d.resolution ? (
                <p className="mt-3 rounded-lg bg-green-lt px-3 py-2 text-xs text-green">
                  {d.resolution}
                </p>
              ) : (
                /* Deliberately not a "resolve" button. A tenant closing a
                   dispute raised against them would be marking their own
                   homework — the policies allow insert only, and resolution
                   belongs to the platform console. */
                <p className="mt-3 text-xs text-muted">
                  Our team is reviewing this. We'll message you on WhatsApp.
                </p>
              )}
            </article>
          ))}
        </div>
      )}
    </>
  );
}
