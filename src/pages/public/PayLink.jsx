import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import BrandMark from '../../components/ui/BrandMark.jsx';
import LogoLoader from '../../components/ui/LogoLoader.jsx';
import CheckoutForm from '../../components/CheckoutForm.jsx';
import { fetchPaymentLink } from '../../lib/checkout.js';
import { formatNaira } from '../../lib/money.js';
import { imageUrl } from '../../lib/images.js';

// /pay/<token>: a payment link a store sent a buyer in chat, for one item at
// the price they agreed there. The price is inside the signed token, so the
// buyer cannot change it; the item and store are read fresh, so a link for
// something that has since sold says so.
export default function PayLink() {
  const { token } = useParams();
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let active = true;
    fetchPaymentLink(token)
      .then((link) => active && setState({ link }))
      .catch((err) => active && setState({ error: err.message }));
    return () => {
      active = false;
    };
  }, [token]);

  if (state.loading) return <LogoLoader fullScreen label="Loading" />;

  return (
    <div className="min-h-dvh bg-bg px-4 py-6">
      <div className="mx-auto max-w-md">
        <div className="mb-4 flex justify-center">
          <BrandMark className="h-8 w-8" />
        </div>
        <div className="card p-5">
          {state.error ? (
            <>
              <h1 className="font-display text-lg font-semibold text-ink">This link can't be paid</h1>
              <p className="mt-2 text-sm text-muted">{state.error}</p>
              <p className="mt-2 text-sm text-muted">Ask the store to send you a new one.</p>
            </>
          ) : (
            <>
              <p className="text-xs text-muted">
                Payment to{' '}
                <Link to={`/s/${state.link.store.slug}`} className="font-medium text-green">
                  {state.link.store.name}
                </Link>
              </p>
              <div className="mt-3 flex gap-3">
                {imageUrl(state.link.images?.[0]) ? (
                  <img
                    src={imageUrl(state.link.images[0])}
                    alt=""
                    className="h-20 w-20 shrink-0 rounded-lg bg-surface-2 object-cover"
                  />
                ) : null}
                <div className="min-w-0">
                  <h1 className="font-display text-lg font-semibold text-ink">{state.link.title}</h1>
                  <p className="text-2xl font-semibold text-ink">{formatNaira(state.link.price)}</p>
                </div>
              </div>
              <CheckoutForm token={token} price={state.link.price} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
