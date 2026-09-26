import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import BrandMark from '../../components/ui/BrandMark.jsx';
import LogoLoader from '../../components/ui/LogoLoader.jsx';
import Icon from '../../components/ui/Icon.jsx';
import { fetchOrderByReference } from '../../lib/checkout.js';
import { formatNaira } from '../../lib/money.js';

// /order/<reference>: where Paystack sends a buyer back after paying.
//
// The Worker checks with Paystack itself if its webhook has not landed yet,
// so most buyers see "paid" straight away. For the rest, a few more tries.
const POLL_MS = 3000;
const MAX_POLLS = 20;

export default function OrderStatus() {
  const { reference } = useParams();
  const [order, setOrder] = useState(null);
  const [error, setError] = useState(null);
  const [polls, setPolls] = useState(0);

  useEffect(() => {
    let active = true;
    let timer;
    const load = async (n) => {
      try {
        const row = await fetchOrderByReference(reference);
        if (!active) return;
        setOrder(row);
        setPolls(n);
        if (row.status === 'awaiting_payment' && n < MAX_POLLS) {
          timer = setTimeout(() => load(n + 1), POLL_MS);
        }
      } catch (err) {
        if (active) setError(err.message);
      }
    };
    load(0);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [reference]);

  if (!order && !error) return <LogoLoader fullScreen label="Checking your payment" />;

  const waiting = order?.status === 'awaiting_payment';
  const gaveUp = waiting && polls >= MAX_POLLS;
  const cancelled = order?.status === 'cancelled';

  return (
    <div className="min-h-dvh bg-bg px-4 py-6">
      <div className="mx-auto max-w-sm">
        <div className="mb-4 flex justify-center">
          <BrandMark className="h-8 w-8" />
        </div>
        <div className="card p-5 text-center">
          {error ? (
            <>
              <h1 className="font-display text-lg font-semibold text-ink">Order not found</h1>
              <p className="mt-2 text-sm text-muted">{error}</p>
            </>
          ) : waiting ? (
            <>
              <h1 className="font-display text-lg font-semibold text-ink">
                {gaveUp ? "We haven't seen your payment yet" : 'Confirming your payment…'}
              </h1>
              <p className="mt-2 text-sm text-muted">
                {gaveUp
                  ? "If you paid, it can take a few minutes to come through. You'll get a WhatsApp message as soon as it does."
                  : 'This usually takes a few seconds.'}
              </p>
            </>
          ) : cancelled ? (
            <>
              <h1 className="font-display text-lg font-semibold text-ink">This order was cancelled</h1>
              <p className="mt-2 text-sm text-muted">No payment was taken. You can try again from the item's page.</p>
            </>
          ) : (
            <>
              <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-green-lt text-green">
                <Icon name="check" className="h-6 w-6" />
              </span>
              <h1 className="mt-3 font-display text-lg font-semibold text-ink">Payment received</h1>
              {order.cart ? (
                // A WhatsApp cart: one payment, an order per item.
                <ul className="mt-3 space-y-1 text-left text-sm">
                  {order.items.map((i) => (
                    <li key={i.order_code} className="flex justify-between gap-3">
                      <span className="min-w-0 truncate text-ink">{i.title}</span>
                      <span className="shrink-0 text-muted">{formatNaira(i.amount)}</span>
                    </li>
                  ))}
                  <li className="flex justify-between gap-3 border-t border-line pt-1 font-semibold text-ink">
                    <span>Total</span>
                    <span>{formatNaira(order.amount)}</span>
                  </li>
                </ul>
              ) : (
                <>
                  <p className="mt-1 text-sm text-muted">
                    {order.product?.title} · {formatNaira(order.amount)}
                  </p>
                  <p className="mt-1 text-xs text-muted">Order {order.order_code}</p>
                </>
              )}
              <p className="mt-4 text-sm leading-relaxed text-text">
                {order.store?.name} will contact you on WhatsApp about delivery.
                {order.escrow
                  ? ` Your payment is held safely until you confirm ${order.cart ? 'each item' : 'the item'} arrived; we've sent you the link to do that.`
                  : ''}
              </p>
            </>
          )}

          {order?.store?.slug ? (
            <Link to={`/s/${order.store.slug}`} className="mt-5 inline-block text-sm font-semibold text-green">
              Back to {order.store.name}
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}
