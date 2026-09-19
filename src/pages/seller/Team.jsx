import { useQuery } from '@tanstack/react-query';
import PageHeader from '../../components/ui/PageHeader.jsx';
import Icon from '../../components/ui/Icon.jsx';
import { LoadingRows } from '../../components/ui/EmptyState.jsx';
import { useAuth } from '../../lib/AuthContext.jsx';
import { useTenant } from '../../lib/TenantContext.jsx';
import { fetchStaff, roleLabel, roleScope } from '../../lib/staff.js';
import { keys } from '../../lib/queryKeys.js';

export default function Team() {
  const { user } = useAuth();
  const { tenant } = useTenant();
  const tenantId = tenant?.id;

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
          <button
            type="button"
            disabled
            title="Inviting staff needs the Worker — see the README"
            className="inline-flex items-center gap-1.5 rounded-pill bg-green px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            <Icon name="plus" className="h-4 w-4" />
            Add member
          </button>
        }
      />

      <div className="card divide-y divide-line">
        {isLoading ? (
          <LoadingRows rows={3} className="p-4" />
        ) : (
          members?.map((m) => (
            <div key={m.user_id} className="flex items-center gap-3 p-4">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-green-lt text-green">
                <Icon name="team" className="h-4 w-4" />
              </span>

              <div className="min-w-0 flex-1 leading-tight">
                <p className="text-sm font-medium text-ink">
                  {roleLabel(m.role)}
                  {m.user_id === user?.id ? (
                    <span className="ml-2 rounded-pill bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">
                      You
                    </span>
                  ) : null}
                </p>
                <p className="text-xs text-muted">{roleScope(m.role)}</p>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Names are absent on purpose rather than by oversight: auth.users is
          not in the exposed schema, and it carries the password hash and every
          recovery token. A colleague's display name belongs on the membership
          row, written by the Worker when the invitation is accepted. */}
      <p className="mt-3 text-xs text-muted">
        Staff names appear here once invitations are handled by the platform —
        see the README.
      </p>
    </>
  );
}
