import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import PageHeader from '../../components/ui/PageHeader.jsx';
import { useTenant } from '../../lib/TenantContext.jsx';
import { useToast } from '../../lib/ToastContext.jsx';
import { storeUrl, updateTenant } from '../../lib/tenants.js';
import { InputError } from '../../lib/phone.js';
import { tenantScope } from '../../lib/queryKeys.js';

export default function Settings() {
  const { tenant, role } = useTenant();
  const toast = useToast();
  const qc = useQueryClient();
  const isOwner = role === 'owner';

  const [form, setForm] = useState({ name: '', whatsapp_number: '', brand_color: '' });

  useEffect(() => {
    if (!tenant) return;
    setForm({
      name: tenant.name ?? '',
      whatsapp_number: tenant.whatsapp_number ?? '',
      brand_color: tenant.brand_color ?? '',
    });
  }, [tenant]);

  const save = useMutation({
    mutationFn: () => updateTenant(tenant.id, form),
    onSuccess: () => {
      toast('Saved', 'success');
      qc.invalidateQueries(tenantScope(tenant.id));
    },
    onError: (e) =>
      toast(
        e instanceof InputError
          ? e.message
          : e?.code === '23505'
            ? 'That WhatsApp number is already registered to another store.'
            : 'Could not save those changes',
        'error'
      ),
  });

  return (
    <>
      <PageHeader title="Settings" subtitle="Your store's details." />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="card max-w-lg space-y-4 p-5"
      >
        <Field
          label="Store name"
          value={form.name}
          onChange={(v) => setForm((f) => ({ ...f, name: v }))}
          disabled={!isOwner}
        />

        <Field
          label="WhatsApp number"
          value={form.whatsapp_number}
          onChange={(v) => setForm((f) => ({ ...f, whatsapp_number: v }))}
          disabled={!isOwner}
          hint="The number you'll message the bot from, e.g. 2348012345678 or 0801 234 5678. This is how we know an incoming message is yours."
        />

        <Field
          label="Brand colour"
          value={form.brand_color}
          onChange={(v) => setForm((f) => ({ ...f, brand_color: v }))}
          disabled={!isOwner}
          hint="A hex value like #5C7A3E. Used for accents in your dashboard and on your store page."
        />

        {/* Read-only on purpose. The slug is already inside every product link
            a seller has shared, and the plan and commission are set by
            billing, not by the customer. */}
        <div className="space-y-1 border-t border-line pt-4 text-sm">
          <ReadOnly
            label="Store page"
            value={
              tenant?.status === 'active' ? (
                <a
                  href={storeUrl(tenant.slug)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-green underline-offset-2 hover:underline"
                >
                  /s/{tenant.slug}
                </a>
              ) : (
                `/s/${tenant?.slug ?? ''} · live once approved`
              )
            }
          />
          <ReadOnly label="Plan" value={tenant?.tier ?? '—'} />
          <ReadOnly
            label="Commission"
            value={Number(tenant?.commission_pct) > 0 ? `${tenant.commission_pct}%` : 'None'}
          />
        </div>

        {isOwner ? (
          <button
            type="submit"
            disabled={save.isPending}
            className="rounded-pill bg-green px-5 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {save.isPending ? 'Saving…' : 'Save changes'}
          </button>
        ) : (
          <p className="text-xs text-muted">
            Only the store owner can change these.
          </p>
        )}
      </form>
    </>
  );
}

function Field({ label, value, onChange, hint, disabled }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      <input
        type="text"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-green/40 disabled:bg-surface-2 disabled:text-muted"
      />
      {hint ? <span className="mt-1 block text-[11px] text-muted">{hint}</span> : null}
    </label>
  );
}

function ReadOnly({ label, value }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted">{label}</span>
      <span className="font-medium text-ink">{value}</span>
    </div>
  );
}
