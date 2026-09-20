import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import Icon from '../../components/ui/Icon.jsx';
import StatusPill from '../../components/ui/StatusPill.jsx';
import { useTenant } from '../../lib/TenantContext.jsx';
import { fetchOrder, escrowTimeline, escrowSummary } from '../../lib/orders.js';
import { formatNaira, sellerProceeds } from '../../lib/money.js';
import { maskPhone } from '../../lib/privacy.js';
import { dateTime } from '../../lib/time.js';
import { keys } from '../../lib/queryKeys.js';
import { firstImage } from '../../lib/images.js';

const CONDITION = {
  brand_new: 'Brand new',
  excellent: 'Excellent condition',
  good: 'Good condition',
  fair: 'Fair condition',
};

export default function OrderDetail() {
  const { orderId } = useParams();
  const { tenant } = useTenant();
  const tenantId = tenant?.id;

  const { data: order, isLoading } = useQuery({
    queryKey: keys.order(tenantId, orderId),
    queryFn: () => fetchOrder(tenantId, orderId),
    enabled: Boolean(tenantId && orderId),
  });

  if (isLoading) {
    return <div className="h-64 animate-pulse rounded-card bg-surface-2" />;
  }

  if (!order) {
    return (
      <div className="card p-8 text-center">
        <h1 className="font-display text-lg font-semibold">Order not found</h1>
        <p className="mt-2 text-sm text-muted">
          That order does not belong to this store, or it no longer exists.
        </p>
        <Link to="/dashboard/orders" className="mt-4 inline-block text-sm font-medium text-green">
          Back to Orders
        </Link>
      </div>
    );
  }

  const timeline = escrowTimeline(order);
  const summary = escrowSummary(order);
  const money = sellerProceeds(order.amount, tenant?.commission_pct);

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        to="/dashboard/orders"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink"
      >
        <Icon name="back" className="h-4 w-4" />
        Back
      </Link>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-xl font-semibold text-ink">
          Order {order.order_code}
        </h1>
        <StatusPill status={order.status} />
      </div>

      <div className="grid gap-4 md:grid-cols-5">
        <div className="space-y-4 md:col-span-3">
          <div className="card p-4">
            <div className="flex items-center gap-3">
              {firstImage(order.product) ? (
                <img src={firstImage(order.product)} alt="" className="h-16 w-16 rounded-lg object-cover" />
              ) : (
                <span className="grid h-16 w-16 place-items-center rounded-lg bg-surface-2 text-muted">
                  <Icon name="listings" className="h-5 w-5" />
                </span>
              )}
              <div className="min-w-0">
                <p className="truncate font-medium text-ink">{order.product?.title ?? '—'}</p>
                <p className="font-display text-lg font-semibold text-ink">
                  {formatNaira(order.amount)}
                </p>
                <p className="text-xs text-muted">
                  {CONDITION[order.product?.condition] ?? order.product?.condition}
                  {order.quantity > 1 ? ` · ×${order.quantity}` : ''}
                </p>
              </div>
            </div>

            {/* What the seller actually receives. Commission is per tenant,
                so this is their rate, not a tier's. */}
            <dl className="mt-4 space-y-1 border-t border-line pt-3 text-sm">
              <Row label="Sale price" value={formatNaira(money.gross)} />
              {money.commission > 0 ? (
                <Row label={`Commission (${tenant.commission_pct}%)`} value={`−${formatNaira(money.commission)}`} />
              ) : null}
              <Row label="You receive" value={formatNaira(money.net)} strong />
            </dl>
          </div>

          <div className="card p-4">
            <h2 className="mb-2 text-sm font-semibold text-ink">Buyer</h2>
            <p className="text-sm text-ink">{order.buyer?.name || 'Unnamed buyer'}</p>
            <p className="text-sm text-muted">{maskPhone(order.buyer?.phone)}</p>
            {order.source_channel ? (
              <p className="mt-2 text-xs text-muted">
                Found this item on <span className="capitalize">{order.source_channel}</span>
              </p>
            ) : null}
          </div>
        </div>

        <div className="md:col-span-2">
          <div className="card p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-ink">Progress</h2>
              {order.escrow_status !== 'none' ? <StatusPill status="escrow" /> : null}
            </div>

            {summary ? (
              <p
                className={`mb-3 rounded-lg px-3 py-2 text-xs ${
                  summary.tone === 'done'
                    ? 'bg-green-lt text-green'
                    : summary.tone === 'warn'
                      ? 'bg-red-lt text-red'
                      : 'bg-amber-lt text-amber'
                }`}
              >
                {summary.text}
              </p>
            ) : null}

            <ol className="relative space-y-4">
              {timeline.map((step, i) => (
                <li key={step.id} className="flex gap-3">
                  <span className="relative flex flex-col items-center">
                    <span
                      className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 ${
                        step.state === 'done'
                          ? 'border-green bg-green text-white'
                          : step.state === 'current'
                            ? 'border-green bg-surface'
                            : 'border-line bg-surface'
                      }`}
                    >
                      {step.state === 'done' ? <Icon name="check" className="h-3 w-3" /> : null}
                    </span>
                    {i < timeline.length - 1 ? (
                      <span
                        className={`absolute top-5 h-[calc(100%+0.5rem)] w-px ${
                          step.state === 'done' ? 'bg-green/40' : 'bg-line'
                        }`}
                      />
                    ) : null}
                  </span>

                  <span className="pb-1 leading-tight">
                    <span
                      className={`block text-[13px] ${
                        step.state === 'pending' ? 'text-muted' : 'font-medium text-ink'
                      }`}
                    >
                      {step.label}
                    </span>
                    {step.at ? (
                      <span className="block text-[11px] text-muted">{dateTime(step.at)}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, strong }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted">{label}</dt>
      <dd className={strong ? 'font-semibold text-ink' : 'text-ink'}>{value}</dd>
    </div>
  );
}
