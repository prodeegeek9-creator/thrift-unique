import { Link } from 'react-router-dom';
import Icon from './ui/Icon.jsx';
import StatusPill from './ui/StatusPill.jsx';
import { formatNaira } from '../lib/money.js';
import { maskPhone, shortName } from '../lib/privacy.js';
import { dateTime } from '../lib/time.js';
import { firstImage } from '../lib/images.js';

// Orders on a phone: one row each, everything a seller needs at a glance —
// what, for how much, and where it has got to — without swiping a table
// sideways to find the amount and the status. From md up the pages show
// their table instead.
export default function OrderRows({ orders, nameLength = 16 }) {
  return (
    <ul className="divide-y divide-line/60 md:hidden">
      {orders.map((o) => (
        <li key={o.id}>
          <Link to={`/dashboard/orders/${o.id}`} className="flex items-center gap-3 px-4 py-3 active:bg-surface-2/60">
            {firstImage(o.product) ? (
              <img src={firstImage(o.product)} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" />
            ) : (
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted">
                <Icon name="listings" className="h-4 w-4" />
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-ink">{o.product?.title ?? '—'}</span>
              {/* Masked here as everywhere: see lib/privacy.js */}
              <span className="block truncate text-[11px] text-muted">
                {o.order_code} · {o.buyer?.name ? shortName(o.buyer.name, nameLength) : maskPhone(o.buyer?.phone)} ·{' '}
                {dateTime(o.created_at)}
              </span>
            </span>
            <span className="flex shrink-0 flex-col items-end gap-1">
              <span className="text-sm font-semibold tabular-nums text-ink">{formatNaira(o.amount)}</span>
              <StatusPill status={o.status} className="!px-1.5 !py-0.5 !text-[10px]" />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
