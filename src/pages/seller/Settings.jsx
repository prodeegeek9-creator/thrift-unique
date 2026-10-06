import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import PageHeader from '../../components/ui/PageHeader.jsx';
import { useTenant } from '../../lib/TenantContext.jsx';
import { useToast } from '../../lib/ToastContext.jsx';
import { storeUrl, updateTenant } from '../../lib/tenants.js';
import { InputError } from '../../lib/phone.js';
import { tenantScope } from '../../lib/queryKeys.js';
import { useAuth } from '../../lib/AuthContext.jsx';
import { useMyProfile } from '../../lib/profile.js';
import DetailsForm from '../../components/DetailsForm.jsx';
import PhotoRequirements from '../../components/PhotoRequirements.jsx';

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

      {/* Only where the photo-review intake runs: a thrift store with the
          photo_review flag on. Explicitly true — hasFeature() treats a flag
          with no tier as on by default, which is wrong for a rollout switch. */}
      {tenant && tenant.store_type !== 'brand' && tenant.features?.photo_review === true ? (
        <PhotoRequirements tenant={tenant} isOwner={isOwner} />
      ) : null}

      <YourDetails />
    </>
  );
}

// The signed-in person's own name, phone and address (migration 0037): their
// account's, not the store's, so everybody on the team can change their own.
function YourDetails() {
  const { user } = useAuth();
  const toast = useToast();
  const { data: profile, isSuccess, isError } = useMyProfile(user);

  return (
    <section className="card mt-4 max-w-lg p-5">
      <h2 className="text-sm font-semibold text-ink">Your details</h2>
      <p className="mb-4 mt-0.5 text-sm text-muted">
        Who you are and how to reach you. Only you and the platform team can see these.
      </p>
      {isSuccess ? (
        <DetailsForm user={user} profile={profile} onSaved={() => toast('Saved', 'success')} />
      ) : isError ? (
        <p className="text-sm text-muted">Couldn't load your details. Refresh to try again.</p>
      ) : (
        <div className="h-40 animate-pulse rounded-lg bg-surface-2" />
      )}
    </section>
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
