import { NIGERIAN_STATES } from '../lib/profile.js';

// Name, phone and address: on the sign-up form, and on the onboarding page for
// an account that came in without them (lib/profile.js).
export default function ProfileFields({ value, onChange }) {
  const set = (key) => (e) => onChange({ ...value, [key]: e.target.value });

  return (
    <>
      <Field label="Full name">
        <input required autoComplete="name" value={value.full_name} onChange={set('full_name')} className={INPUT} />
      </Field>

      <Field label="Phone number" hint="Ideally the WhatsApp number your store will use.">
        <input
          type="tel"
          required
          inputMode="tel"
          autoComplete="tel"
          placeholder="0803 123 4567"
          value={value.phone}
          onChange={set('phone')}
          className={INPUT}
        />
      </Field>

      <Field label="Address">
        <input
          required
          autoComplete="street-address"
          placeholder="House number and street"
          value={value.address}
          onChange={set('address')}
          className={INPUT}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Town or city">
          <input required autoComplete="address-level2" value={value.city} onChange={set('city')} className={INPUT} />
        </Field>
        <Field label="State">
          <select required autoComplete="address-level1" value={value.state} onChange={set('state')} className={INPUT}>
            <option value="" disabled>
              Choose…
            </option>
            {NIGERIAN_STATES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-muted">{hint}</span> : null}
    </label>
  );
}

export const INPUT =
  'h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm outline-none focus:border-green/40';
