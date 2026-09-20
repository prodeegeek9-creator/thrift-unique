import { useQuery } from '@tanstack/react-query';
import PageHeader from '../../components/ui/PageHeader.jsx';
import EmptyState, { LoadingRows } from '../../components/ui/EmptyState.jsx';
import { fetchAudit, AUDIT_LABELS } from '../../lib/admin.js';
import { dateTime } from '../../lib/time.js';

// Read-only, and that is enforced at the database rather than here: the
// operator_audit table has a trigger that rejects UPDATE and DELETE outright,
// even under the service key. A record that can be tidied afterwards is not
// evidence of anything.
export default function AdminAudit() {
  const { data: entries, isLoading } = useQuery({
    queryKey: ['admin', 'audit'],
    queryFn: fetchAudit,
  });

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Every operator action. Append-only — nothing here can be edited or removed."
      />

      <div className="card overflow-hidden">
        {isLoading ? (
          <LoadingRows rows={6} className="p-4" />
        ) : !entries?.length ? (
          <EmptyState icon="listings" title="Nothing yet" body="Operator actions appear here as they happen." />
        ) : (
          <ol className="divide-y divide-line">
            {entries.map((e) => (
              <li key={e.id} className="flex gap-3 p-4">
                <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-gold" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink">
                    {/* An action nobody wrote a label for still renders, by its
                        raw name. Hiding it would make the log quietly
                        incomplete, which is the one thing it must not be. */}
                    {AUDIT_LABELS[e.action] ?? e.action}
                    {e.subject ? <span className="text-muted"> · {e.subject}</span> : null}
                  </p>

                  {Object.keys(e.detail ?? {}).length ? (
                    <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
                      {Object.entries(e.detail).map(([k, v]) =>
                        v == null ? null : (
                          <div key={k} className="flex gap-1 text-[11px]">
                            <dt className="text-muted">{k}:</dt>
                            <dd className="text-text">{String(v)}</dd>
                          </div>
                        )
                      )}
                    </dl>
                  ) : null}
                </div>

                <span className="shrink-0 text-[11px] text-muted">{dateTime(e.created_at)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </>
  );
}
