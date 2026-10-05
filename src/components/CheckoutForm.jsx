import { useState } from 'react';
import { startCheckout } from '../lib/checkout.js';
import { formatNaira } from '../lib/money.js';

// The few things a store needs to deliver, then off to Paystack to pay.
//
// No account and no password: a buyer who found an item on somebody's Status
// is one form away from paying for it. The phone number is how the store and
// the receipt reach them, on WhatsApp.
export default function CheckoutForm({ code, token, price, onCancel }) {
  const [form, setForm] = useState({ name: '', phone: '', address: '', note: '', email: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { url } = await startCheckout({ ...(token ? { token } : { code }), ...form });
      window.location.assign(url);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-5 space-y-3 rounded-card border border-line bg-bg p-4">
      <Field label="Your name">
        <input value={form.name} onChange={set('name')} autoComplete="name" required className={INPUT} />
      </Field>
      <Field label="WhatsApp number" hint="Your receipt and delivery updates come here.">
        <input
          value={form.phone}
          onChange={set('phone')}
          inputMode="tel"
          autoComplete="tel"
          placeholder="0803 123 4567"
          required
          className={INPUT}
        />
      </Field>
      <Field label="Delivery address">
        <textarea
          value={form.address}
          onChange={set('address')}
          rows={2}
          autoComplete="street-address"
          placeholder="House number, street, area, city"
          required
          className={INPUT}
        />
      </Field>
      <Field label="Note for the store (optional)">
        <input value={form.note} onChange={set('note')} maxLength={300} placeholder="e.g. Call before delivery" className={INPUT} />
      </Field>
      <Field label="Email (optional)" hint="For a Paystack receipt by email too.">
        <input value={form.email} onChange={set('email')} type="email" autoComplete="email" className={INPUT} />
      </Field>

      {error ? <p className="text-sm text-red">{error}</p> : null}

      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-pill bg-green py-3 text-sm font-semibold text-white disabled:opacity-60"
      >
        {busy ? 'Opening payment…' : `Pay ${formatNaira(price)}`}
      </button>
      {onCancel ? (
        <button type="button" onClick={onCancel} className="w-full text-center text-xs text-muted">
          Cancel
        </button>
      ) : null}
      <p className="text-center text-[11px] text-muted">
        Card, bank transfer or USSD through Paystack. Your payment goes through Vendwyze, not straight to
        the store.
      </p>
    </form>
  );
}

const INPUT =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-green/40';

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-muted">{hint}</span> : null}
    </label>
  );
}
