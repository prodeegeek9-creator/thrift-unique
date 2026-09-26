import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import BrandMark from '../../components/ui/BrandMark.jsx';
import LogoLoader from '../../components/ui/LogoLoader.jsx';
import Icon from '../../components/ui/Icon.jsx';
import { fetchPlanInvoice, startPlanPayment } from '../../lib/billing.js';
import { formatNaira } from '../../lib/money.js';
import { dateOnly } from '../../lib/time.js';

// /billing/pay/<ref>: paying a store's monthly plan fee.
//
// Reached from the WhatsApp reminder or the Billing page, and needs no login:
// the reference is unguessable and all it allows is paying this invoice.
// Paystack sends the owner back here with ?reference=, and the Worker checks
// the payment itself if its webhook has not arrived yet.
export default function PlanPay() {
  const { ref } = useParams();
  const [params] = useSearchParams();
  const returned = params.get('reference');
  const [invoice, setInvoice] = useState(null);
  const [error, setError] = useState(null);
  const [autoRenew, setAutoRenew] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    let tries = 0;
    let timer;
    const load = async () => {
      try {
        const row = await fetchPlanInvoice(ref, returned);
        if (!active) return;
        setInvoice(row);
        // Just back from Paystack and not settled yet: a few more looks.
        if (returned && row.status === 'open' && tries < 10) {
          tries += 1;
          timer = setTimeout(load, 3000);
        }
      } catch (err) {
        if (active) setError(err.message);
      }
    };
    load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [ref, returned]);

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await startPlanPayment(ref, autoRenew);
      window.location.assign(url);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  if (!invoice && !error) return <LogoLoader fullScreen label="Loading" />;

  const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : '');
  const plan = cap(invoice?.tier);
  const fromPlan = cap(invoice?.from_tier);
  const upgrade = invoice?.kind === 'upgrade';

  return (
    <div className="min-h-dvh bg-bg px-4 py-6">
      <div className="mx-auto max-w-sm">
        <div className="mb-4 flex justify-center">
          <BrandMark className="h-8 w-8" />
        </div>
        <div className="card p-5">
          {!invoice ? (
            <>
              <h1 className="font-display text-lg font-semibold text-ink">Invoice not found</h1>
              <p className="mt-2 text-sm text-muted">{error}</p>
            </>
          ) : invoice.status === 'paid' ? (
            <div className="text-center">
              <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-green-lt text-green">
                <Icon name="check" className="h-6 w-6" />
              </span>
              <h1 className="mt-3 font-display text-lg font-semibold text-ink">Paid, thank you</h1>
              <p className="mt-1 text-sm text-muted">
                {invoice.store} · {plan} plan · {formatNaira(invoice.amount)}
              </p>
              <p className="mt-3 text-sm text-text">
                {upgrade ? `You're on ${plan} now.` : 'Your store is all set.'} We've sent the details on WhatsApp.
              </p>
              <a href="/dashboard/billing" className="mt-4 inline-block text-sm font-semibold text-green">
                Go to Billing
              </a>
            </div>
          ) : (
            <>
              <p className="text-xs text-muted">Vendwyze plan fee</p>
              <h1 className="mt-1 font-display text-lg font-semibold text-ink">{invoice.store}</h1>
              {invoice.paused ? (
                <p className="mt-2 rounded-lg bg-red-lt px-3 py-2 text-xs text-red">
                  Your store is paused. It comes back as soon as this is paid.
                </p>
              ) : null}
              <div className="mt-4 flex items-baseline justify-between border-y border-line py-3">
                <div>
                  {upgrade ? (
                    <>
                      <p className="text-sm font-medium text-ink">
                        Upgrade{fromPlan ? ` from ${fromPlan}` : ''} to {plan}
                      </p>
                      <p className="text-xs text-muted">
                        The difference for the rest of this month, to {dateOnly(invoice.period_end)}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-sm font-medium text-ink">{plan} plan, one month</p>
                      <p className="text-xs text-muted">
                        {dateOnly(invoice.period_start)} – {dateOnly(invoice.period_end)}
                      </p>
                    </>
                  )}
                </div>
                <p className="font-display text-xl font-semibold text-ink">{formatNaira(invoice.amount)}</p>
              </div>

              {upgrade ? null : (
              <label className="mt-4 flex items-start gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={autoRenew}
                  onChange={(e) => setAutoRenew(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-green"
                />
                <span>
                  Renew automatically with this card each month
                  <span className="block text-[11px] text-muted">
                    Only if you pay by card. Turn it off any time under Billing.
                  </span>
                </span>
              </label>
              )}

              {error ? <p className="mt-3 text-sm text-red">{error}</p> : null}
              {returned && invoice.status === 'open' ? (
                <p className="mt-3 text-xs text-muted">Checking your payment… this can take a minute.</p>
              ) : null}

              <button
                type="button"
                disabled={busy}
                onClick={pay}
                className="mt-4 w-full rounded-pill bg-green py-3 text-sm font-semibold text-white disabled:opacity-60"
              >
                {busy ? 'Opening payment…' : `Pay ${formatNaira(invoice.amount)}`}
              </button>
              <p className="mt-2 text-center text-[11px] text-muted">Card, bank transfer or USSD through Paystack.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
