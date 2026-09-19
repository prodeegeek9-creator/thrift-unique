import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import PageHeader from '../../components/ui/PageHeader.jsx';
import Icon from '../../components/ui/Icon.jsx';
import EmptyState, { LoadingRows } from '../../components/ui/EmptyState.jsx';
import { useTenant } from '../../lib/TenantContext.jsx';
import { fetchContacts, fetchContactStats } from '../../lib/contacts.js';
import { formatNaira } from '../../lib/money.js';
import { maskPhone, initialsOf } from '../../lib/privacy.js';
import { relative } from '../../lib/time.js';
import { keys } from '../../lib/queryKeys.js';

export default function Contacts() {
  const { tenant } = useTenant();
  const tenantId = tenant?.id;
  const [search, setSearch] = useState('');

  const { data: stats } = useQuery({
    queryKey: [...keys.contacts(tenantId), 'stats'],
    queryFn: () => fetchContactStats(tenantId),
    enabled: Boolean(tenantId),
  });

  const { data: contacts, isLoading } = useQuery({
    queryKey: keys.contacts(tenantId, search),
    queryFn: () => fetchContacts(tenantId, { search }),
    enabled: Boolean(tenantId),
  });

  return (
    <>
      <PageHeader
        title="Contacts"
        subtitle={
          stats
            ? `${stats.buyers} buyer${stats.buyers === 1 ? '' : 's'} · ${stats.repeat} repeat`
            : 'The buyers who have paid you.'
        }
      />

      <label className="relative mb-4 block max-w-sm">
        <Icon
          name="search"
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
        />
        <span className="sr-only">Search contacts</span>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search contacts…"
          className="w-full rounded-pill border border-line bg-surface py-2 pl-9 pr-4 text-sm outline-none placeholder:text-muted focus:border-green/40"
        />
      </label>

      <div className="card overflow-hidden">
        {isLoading ? (
          <LoadingRows rows={5} className="p-4" />
        ) : !contacts?.length ? (
          <EmptyState
            icon="contacts"
            title={search ? 'Nobody matches that' : 'No buyers yet'}
            body={
              search
                ? 'Try a name or a phone number.'
                : 'Everyone who pays through your store is added here automatically, with what they bought and what they spent.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-muted">
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-4 py-2.5 font-medium">Orders</th>
                  <th className="px-4 py-2.5 font-medium">Total spent</th>
                  <th className="px-4 py-2.5 font-medium">Last purchase</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((c) => (
                  <tr key={c.id} className="border-b border-line/60 last:border-0">
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2.5">
                        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-green-lt text-[11px] font-semibold text-green">
                          {initialsOf(c.name)}
                        </span>
                        <span className="min-w-0 leading-tight">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate font-medium text-ink">
                              {c.name || 'Unnamed buyer'}
                            </span>
                            {c.is_repeat ? (
                              <span className="shrink-0 rounded-pill bg-green-lt px-1.5 py-0.5 text-[10px] font-semibold text-green">
                                Repeat
                              </span>
                            ) : null}
                          </span>
                          <span className="block text-[11px] text-muted">
                            {maskPhone(c.phone)}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td className="px-4 py-3">{c.order_count}</td>
                    <td className="whitespace-nowrap px-4 py-3 font-medium">
                      {formatNaira(c.total_spent)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted">
                      {relative(c.last_purchase_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
