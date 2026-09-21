import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import PageHeader from '../../components/ui/PageHeader.jsx';
import Icon from '../../components/ui/Icon.jsx';
import { LoadingRows } from '../../components/ui/EmptyState.jsx';
import { useAuth } from '../../lib/AuthContext.jsx';
import { useTenant } from '../../lib/TenantContext.jsx';
import { useToast } from '../../lib/ToastContext.jsx';
import { fetchStaff, inviteStaff, isPending, roleLabel, roleScope, ROLES } from '../../lib/staff.js';
import { keys } from '../../lib/queryKeys.js';

export default function Team() {
  const { user } = useAuth();
  const { tenant, role } = useTenant();
  const tenantId = tenant?.id;
  const isOwner = role === 'owner';

  const [adding, setAdding] = useState(false);
  // What the owner has to pass on. Held after the dialog closes, because an
  // invitation link that vanishes the moment you dismiss the dialog is an
  // invitation nobody can send.
  const [invited, setInvited] = useState(null);

  const { data: members, isLoading } = useQuery({
    queryKey: keys.staff(tenantId),
    queryFn: () => fetchStaff(tenantId),
    enabled: Boolean(tenantId),
  });

  return (
    <>
      <PageHeader
        title="Team"
        subtitle={
          members?.length
            ? `${members.length} member${members.length === 1 ? '' : 's'}`
            : 'Who can sign in to this store.'
        }
        actions={
          isOwner ? (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="inline-flex items-center gap-1.5 rounded-pill bg-green px-4 py-2 text-sm font-semibold text-white"
            >
              <Icon name="plus" className="h-4 w-4" />
              Add member
            </button>
          ) : null
        }
      />

      {invited ? <InviteLink invited={invited} onDismiss={() => setInvited(null)} /> : null}

      <div className="card divide-y divide-line">
        {isLoading ? (
          <LoadingRows rows={3} className="p-4" />
        ) : (
          members?.map((m) => {
            const pending = isPending(m);

            return (
              <div key={m.user_id} className="flex items-center gap-3 p-4">
                <span
                  className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${
                    pending ? 'bg-surface-2 text-muted' : 'bg-green-lt text-green'
                  }`}
                >
                  <Icon name="team" className="h-4 w-4" />
                </span>

                <div className="min-w-0 flex-1 leading-tight">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                    {m.display_name || m.email || roleLabel(m.role)}
                    {m.user_id === user?.id ? (
                      <span className="rounded-pill bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">
                        You
                      </span>
                    ) : null}
                    {/* Said plainly. An owner who cannot tell an invitation
                        from a colleague will assume they have access, and
                        find out otherwise at the worst moment. */}
                    {pending ? (
                      <span className="rounded-pill bg-amber-lt px-1.5 py-0.5 text-[10px] font-medium text-amber">
                        Invite not accepted
                      </span>
                    ) : null}
                  </p>
                  <p className="truncate text-xs text-muted">
                    {m.display_name && m.email ? `${m.email} · ` : ''}
                    {roleLabel(m.role)} — {roleScope(m.role)}
                  </p>
                </div>
              </div>
            );
          })
        )}
      </div>

      {adding ? (
        <AddMemberDialog
          tenantId={tenantId}
          onClose={() => setAdding(false)}
          onDone={(result) => {
            setAdding(false);
            if (result.status === 'invited') setInvited(result);
          }}
        />
      ) : null}
    </>
  );
}

// The link, after the fact.
//
// generate_link does not send an email, which is deliberate — this platform's
// users talk on WhatsApp, and an invitation that depends on a project's SMTP
// being configured is one that fails silently. So the owner is handed the link
// and sends it the way they already talk to their staff.
function InviteLink({ invited, onDismiss }) {
  const toast = useToast();

  const share = `You've been added to our store on Unique Thrift. Set your password here:\n${invited.link}`;

  return (
    <div className="mb-4 rounded-card border border-green/30 bg-green-lt p-4">
      <div className="flex items-start gap-2">
        <Icon name="team" className="mt-0.5 h-4 w-4 shrink-0 text-green" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-green">
            {invited.email} has been added. Send them this link to finish setting up.
          </p>
          <p className="mt-1 break-all rounded-lg bg-surface p-2 text-[11px] text-muted">
            {invited.link}
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            <a
              href={`https://wa.me/?text=${encodeURIComponent(share)}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-pill bg-green px-3 py-1.5 text-xs font-semibold text-white"
            >
              Send on WhatsApp
            </a>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(invited.link);
                  toast('Link copied', 'success');
                } catch {
                  // Clipboard access is refused outside a secure context and
                  // in some in-app browsers. The link is on screen either way.
                  toast('Copy it from above', 'error');
                }
              }}
              className="rounded-pill border border-green/30 px-3 py-1.5 text-xs font-medium text-green"
            >
              Copy link
            </button>
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-pill px-3 py-1.5 text-xs font-medium text-muted"
            >
              Done
            </button>
          </div>

          <p className="mt-2 text-[11px] text-green/80">
            Keep this somewhere until you have sent it — it is not shown again.
          </p>
        </div>
      </div>
    </div>
  );
}

function AddMemberDialog({ tenantId, onClose, onDone }) {
  const toast = useToast();
  const qc = useQueryClient();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('staff');

  const add = useMutation({
    mutationFn: () => inviteStaff(tenantId, { email: email.trim(), role, name: name.trim() }),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: keys.staff(tenantId) });
      toast(
        result.status === 'added'
          ? `${result.email} can sign in now`
          : `${result.email} added — send them the link`,
        'success'
      );
      onDone(result);
    },
    onError: (e) => toast(e.message, 'error'),
  });

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-4">
      <form
        className="card w-full max-w-sm p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!add.isPending) add.mutate();
        }}
      >
        <h2 className="font-display text-base font-semibold text-ink">Add a team member</h2>
        <p className="mt-1 text-sm text-muted">
          They get their own sign-in. You can change what they can reach at any time.
        </p>

        <label className="mt-4 block">
          <span className="mb-1 block text-xs font-medium text-muted">Their name</span>
          <input
            type="text"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            placeholder="Ada Obi"
            className="w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-green/40"
          />
        </label>

        <label className="mt-3 block">
          <span className="mb-1 block text-xs font-medium text-muted">Their email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="ada@example.com"
            className="w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-green/40"
          />
        </label>

        <fieldset className="mt-4">
          <legend className="mb-1.5 text-xs font-medium text-muted">What can they do?</legend>
          <div className="space-y-2">
            {ROLES.map((r) => (
              <label
                key={r.id}
                className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 transition-colors ${
                  role === r.id ? 'border-green bg-green-lt' : 'border-line hover:bg-surface-2'
                }`}
              >
                <input
                  type="radio"
                  name="role"
                  value={r.id}
                  checked={role === r.id}
                  onChange={() => setRole(r.id)}
                  className="mt-0.5 accent-green"
                />
                <span className="leading-tight">
                  <span className="block text-sm font-medium text-ink">{r.label}</span>
                  <span className="block text-xs text-muted">{r.scope}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {/* Not hidden in a tooltip. Making somebody an owner hands them the
            ability to remove you, change the bank details and unlink the
            store's WhatsApp. */}
        {role === 'owner' ? (
          <p className="mt-2 rounded-lg bg-amber-lt p-2 text-[11px] leading-relaxed text-amber">
            An owner can do everything you can, including adding and removing
            people — and removing you.
          </p>
        ) : null}

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-pill border border-line py-2 text-sm font-medium text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!email.trim() || add.isPending}
            className="flex-1 rounded-pill bg-green py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {add.isPending ? 'Adding…' : 'Add them'}
          </button>
        </div>
      </form>
    </div>
  );
}
