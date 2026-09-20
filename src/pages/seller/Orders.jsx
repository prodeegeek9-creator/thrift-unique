import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import PageHeader from '../../components/ui/PageHeader.jsx';
import Icon from '../../components/ui/Icon.jsx';
import StatusPill from '../../components/ui/StatusPill.jsx';
import EmptyState, { LoadingRows } from '../../components/ui/EmptyState.jsx';
import { useTenant } from '../../lib/TenantContext.jsx';
import { fetchOrders } from '../../lib/orders.js';
import { formatNaira } from '../../lib/money.js';
import { maskPhone, shortName } from '../../lib/privacy.js';
import { dateTime } from '../../lib/time.js';
import { keys } from '../../lib/queryKeys.js';
import { firstImage } from '../../lib/images.js';

const CHIPS = [
  { id: 'all', label: 'All' },
  { id: 'awaiting_payment', label: 'Awaiting payment' },
  { id: 'processing', label: 'Processing' },
  { id: 'escrow', label: 'Escrow' },
  { id: 'completed', label: 'Completed' },
];

export default function Orders() {
  const { tenant } = useTenant();
  const tenantId = tenant?.id;
  const [filter, setFilter] = useState('all');

  const { data: orders, isLoading } = useQuery({
    queryKey: keys.orders(tenantId, filter),
    queryFn: () => fetchOrders(tenantId, { filter }),
    enabled: Boolean(tenantId),
  });

  return (
    <>
      <PageHeader title="Orders" subtitle="Every sale, and where it has got to." />

      <div className="mb-4 flex flex-wrap gap-2">
        {CHIPS.map((chip) => (
          <button
            key={chip.id}
            type="button"
            onClick={() => setFilter(chip.id)}
            className={`rounded-pill border px-3 py-1.5 text-xs font-medium transition-colors ${
              filter === chip.id
                ? 'border-sidebar bg-sidebar text-white'
                : 'border-line bg-surface text-muted hover:text-ink'
            }`}
          >
            {chip.label}
          </button>
        ))}
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <LoadingRows rows={6} className="p-4" />
        ) : !orders?.length ? (
          <EmptyState
            icon="orders"
            title={filter === 'all' ? 'No orders yet' : 'Nothing in this state'}
            body={
              filter === 'all'
                ? "Orders appear here as buyers pay. Every one records the channel it came from, so your analytics fill in from the first sale."
                : 'Try another filter to see the rest of your orders.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-muted">
                  <th className="px-4 py-2.5 font-medium">Order</th>
                  <th className="px-4 py-2.5 font-medium">Product</th>
                  <th className="px-4 py-2.5 font-medium">Buyer</th>
                  <th className="px-4 py-2.5 font-medium">Amount</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Date</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} className="border-b border-line/60 last:border-0 hover:bg-surface-2/60">
                    <td className="whitespace-nowrap px-4 py-3 font-medium text-ink">
                      <Link to={`/dashboard/orders/${o.id}`} className="hover:underline">
                        {o.order_code}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2">
                        {firstImage(o.product) ? (
                          <img src={firstImage(o.product)} alt="" className="h-8 w-8 rounded object-cover" />
                        ) : (
                          <span className="grid h-8 w-8 place-items-center rounded bg-surface-2 text-muted">
                            <Icon name="listings" className="h-3.5 w-3.5" />
                          </span>
                        )}
                        <span className="truncate">{o.product?.title ?? '—'}</span>
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted">
                      {o.buyer?.name ? shortName(o.buyer.name, 16) : maskPhone(o.buyer?.phone)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-medium">{formatNaira(o.amount)}</td>
                    <td className="px-4 py-3"><StatusPill status={o.status} /></td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted">{dateTime(o.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
