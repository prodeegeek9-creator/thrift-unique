import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import BrandMark from '../../components/ui/BrandMark.jsx';
import LogoLoader from '../../components/ui/LogoLoader.jsx';
import Icon from '../../components/ui/Icon.jsx';
import { formatNaira } from '../../lib/money.js';
import { firstImage } from '../../lib/images.js';

// How escrow actually releases.
//
// The buyer has no account — there is nobody for an RLS policy to identify —
// so this page talks to the Worker, which verifies a signed token and holds
// the service key. Nothing here touches Supabase directly, and the token in
// the URL is the entire authorisation.
//
// The spec said funds are held "until the buyer confirms receipt" without
// saying how. Doing it in the bot alone is fragile exactly where it matters:
// sessions drop, the message scrolls away, and somebody is releasing tens of
// thousands of naira by typing a word with no record either side can point at.
// One link, one page, one button, and a receipt afterwards.
export default function ConfirmReceipt() {
  const { token } = useParams();
  const [state, setState] = useState('loading');
  const [order, setOrder] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/confirm/${token}`);
        const body = await res.json();
        if (!active) return;
        if (!res.ok) {
          setError(body.error ?? 'That link did not work.');
          setState('error');
          return;
        }
        setOrder(body);
        setState(body.escrow_status === 'held' ? 'ready' : 'done');
      } catch {
        if (!active) return;
        setError('Could not reach us just now. Try again in a moment.');
        setState('error');
      }
    })();
    return () => {
      active = false;
    };
  }, [token]);

  async function confirm() {
    setState('sending');
    try {
      const res = await fetch(`/api/confirm/${token}`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? 'That did not go through.');
        setState('error');
        return;
      }
      setState('done');
    } catch {
      setError('Could not reach us just now. Try again in a moment.');
      setState('error');
    }
  }

  if (state === 'loading') return <LogoLoader fullScreen label="Checking your order" />;

  return (
    <Frame>
      {state === 'error' ? (
        <Message
          tone="red"
          icon="disputes"
          title="This link didn't work"
          body={error}
        />
      ) : state === 'done' ? (
        <Message
          tone="green"
          icon="check"
          title="Thank you — that's confirmed"
          body={`We've released the payment to ${order?.seller ?? 'the seller'}. Nothing else to do.`}
        />
      ) : (
        <>
          <h1 className="font-display text-lg font-semibold text-ink">
            Did your order arrive?
          </h1>
          <p className="mt-1 text-sm text-muted">
            Confirming releases your payment to {order?.seller ?? 'the seller'}.
            Only do this once you have the item.
          </p>

          <div className="mt-4 flex items-center gap-3 rounded-lg bg-surface-2 p-3">
            {firstImage(order?.product) ? (
              <img
                src={firstImage(order?.product)}
                alt=""
                className="h-14 w-14 rounded-lg object-cover"
              />
            ) : (
              <span className="grid h-14 w-14 place-items-center rounded-lg bg-surface text-muted">
                <Icon name="listings" className="h-5 w-5" />
              </span>
            )}
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">
                {order?.product?.title ?? 'Your order'}
              </p>
              <p className="font-display text-base font-semibold text-ink">
                {formatNaira(order?.amount)}
              </p>
              <p className="text-[11px] text-muted">{order?.order_code}</p>
            </div>
          </div>

          <button
            type="button"
            onClick={confirm}
            disabled={state === 'sending'}
            className="mt-5 w-full rounded-pill bg-green py-3 text-sm font-semibold text-white disabled:opacity-60"
          >
            {state === 'sending' ? 'Confirming…' : 'Yes, I received it'}
          </button>

          {/* Not a button. A buyer who has a problem needs a person, and the
              only thing a "No" control could do here is fail to release —
              which is already what happens if they close the tab. */}
          <p className="mt-3 text-center text-xs text-muted">
            Something wrong with your order? Reply to the seller on WhatsApp and
            we'll step in.
          </p>
        </>
      )}
    </Frame>
  );
}

function Message({ tone, icon, title, body }) {
  return (
    <div className="text-center">
      <span
        className={`mx-auto grid h-12 w-12 place-items-center rounded-full ${
          tone === 'green' ? 'bg-green-lt text-green' : 'bg-red-lt text-red'
        }`}
      >
        <Icon name={icon} className="h-6 w-6" />
      </span>
      <h1 className="mt-4 font-display text-lg font-semibold text-ink">{title}</h1>
      <p className="mt-1 text-sm leading-relaxed text-muted">{body}</p>
    </div>
  );
}

function Frame({ children }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4 py-6">
      <div className="w-full max-w-sm">
        <div className="mb-4 flex justify-center">
          <BrandMark className="h-8 w-8" />
        </div>
        <div className="card p-5">{children}</div>
      </div>
    </div>
  );
}
