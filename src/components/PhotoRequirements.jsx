import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import TierBadge from './ui/TierBadge.jsx';
import { keys } from '../lib/queryKeys.js';
import { useToast } from '../lib/ToastContext.jsx';
import {
  FLAG_HINTS,
  REQUIREMENT_LABELS,
  fetchPhotoSettings,
  setCategoryAccepted,
  setShotRequirement,
} from '../lib/photoRules.js';

// What people bringing this store items must photograph (migration 0041).
//
// Each change saves on its own, straight away: there is no form to forget to
// submit, and a change applies to items still waiting on photos as well as
// new ones (the database re-checks them). Owner-only, like the store details
// above it; everybody else sees the settings read-only.
export default function PhotoRequirements({ tenant, isOwner }) {
  const qc = useQueryClient();
  const toast = useToast();
  const queryKey = keys.photoSettings(tenant.id);

  const { data: categories, isLoading, isError } = useQuery({
    queryKey,
    queryFn: () => fetchPhotoSettings(tenant.id),
  });

  const onError = () => toast("Couldn't save that change", 'error');
  const onSuccess = () => {
    toast('Saved', 'success');
    qc.invalidateQueries({ queryKey });
  };

  const accept = useMutation({
    mutationFn: ({ category, accepted }) => setCategoryAccepted(tenant.id, category, accepted),
    onSuccess,
    onError,
  });

  const shot = useMutation({
    mutationFn: (change) => setShotRequirement(tenant.id, change),
    onSuccess,
    onError,
  });

  const busy = accept.isPending || shot.isPending;
  const takesNothing = categories?.length > 0 && categories.every((c) => !c.accepted);

  return (
    <section className="card mt-4 max-w-lg p-5">
      <h2 className="text-sm font-semibold text-ink">Photo requirements</h2>
      <p className="mt-0.5 text-sm text-muted">
        What people bringing you items have to photograph before an item reaches your review
        queue. Photos are checked as they arrive, and sellers are told what's missing.
      </p>

      {isLoading ? (
        <div className="mt-4 h-40 animate-pulse rounded-lg bg-surface-2" />
      ) : isError ? (
        <p className="mt-4 text-sm text-muted">Couldn't load these. Refresh to try again.</p>
      ) : (
        <>
          {takesNothing ? (
            <p className="mt-4 rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink">
              You're not taking any items over WhatsApp right now. Anyone who sends SELL is told so.
            </p>
          ) : null}

          <ul className="mt-4 divide-y divide-line">
            {categories.map((c) => (
              <li key={c.slug} className="py-3">
                <label className="flex items-center gap-2 text-sm font-medium text-ink">
                  <input
                    type="checkbox"
                    checked={c.accepted}
                    disabled={!isOwner || busy}
                    onChange={(e) => accept.mutate({ category: c.slug, accepted: e.target.checked })}
                    className="h-4 w-4 accent-green"
                  />
                  {c.name}
                  {!c.accepted ? <span className="text-xs font-normal text-muted">· not taking these</span> : null}
                </label>

                {c.accepted ? (
                  <ul className="ml-6 mt-2 space-y-1.5">
                    {c.shots.map((s) => (
                      <li key={s.shotType} className="flex items-center justify-between gap-3 text-sm">
                        <span className="min-w-0 text-ink">
                          {s.label}
                          {s.requirement === 'conditional' && FLAG_HINTS[s.conditionFlag] ? (
                            <span className="block text-[11px] text-muted">{FLAG_HINTS[s.conditionFlag]}</span>
                          ) : null}
                        </span>
                        {s.isMain ? (
                          <span className="shrink-0 text-xs text-muted">Always required</span>
                        ) : (
                          <select
                            aria-label={`${c.name}: ${s.label}`}
                            value={s.requirement}
                            disabled={!isOwner || busy}
                            onChange={(e) =>
                              shot.mutate({
                                category: c.slug,
                                shotType: s.shotType,
                                base: s.base,
                                requirement: e.target.value,
                              })
                            }
                            className="shrink-0 rounded-lg border border-line bg-surface px-2 py-1 text-xs outline-none focus:border-green/40 disabled:bg-surface-2 disabled:text-muted"
                          >
                            {s.choices.map((choice) => (
                              <option key={choice} value={choice}>
                                {REQUIREMENT_LABELS[choice]}
                                {choice === s.base ? ' (default)' : ''}
                              </option>
                            ))}
                          </select>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>

          {!isOwner ? <p className="mt-2 text-xs text-muted">Only the store owner can change these.</p> : null}
        </>
      )}
    </section>
  );
}

// What a Starter store sees in its place: the plain intake has no photo
// checks to configure, so say what Growth adds rather than show dead controls.
export function PhotoRequirementsLocked() {
  return (
    <section className="card mt-4 max-w-lg p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
        Photo requirements <TierBadge flag="photo_review" />
      </h2>
      <p className="mt-0.5 text-sm text-muted">
        On Growth, every photo people send with an item is checked as it arrives: blurry, dark
        or wrong photos are sent back, and sellers are told exactly which shots are missing
        before the item reaches your review queue. You choose which categories you take and
        which shots each one needs.
      </p>
      <Link
        to="/dashboard/billing?plan=growth"
        className="mt-3 inline-block text-sm font-semibold text-green underline-offset-2 hover:underline"
      >
        See Growth
      </Link>
    </section>
  );
}
