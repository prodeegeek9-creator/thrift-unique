import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import PageHeader from '../../components/ui/PageHeader.jsx';
import StatTile from '../../components/ui/StatTile.jsx';
import Icon from '../../components/ui/Icon.jsx';
import { fetchOverview } from '../../lib/admin.js';
import { formatNaira } from '../../lib/money.js';

export default function AdminOverview() {
  const { data, isLoading } = useQuery({ queryKey: ['admin', 'overview'], queryFn: fetchOverview });

  return (
    <>
      <PageHeader title="Platform" subtitle="Every store, every order." />

      {/* An overdue hold means the escrow sweep is not running. That failure is
          otherwise completely silent — money simply stops reaching sellers —
          so it gets the loudest thing on the page rather than a number in a
          row of five. */}
      {data?.escrow?.overdue > 0 ? (
        <Link
          to="/admin/escrow"
          className="mb-4 flex items-center gap-3 rounded-card border border-red/30 bg-red-lt p-4"
        >
          <Icon name="disputes" className="h-5 w-5 shrink-0 text-red" />
          <span className="text-sm text-red">
            <strong>{data.escrow.overdue}</strong>{' '}
            {data.escrow.overdue === 1
              ? 'hold is past its deadline and has not released'
              : 'holds are past their deadline and have not released'}
            . The hourly sweep may not be running.
          </span>
        </Link>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          icon="team"
          label="Stores"
          value={isLoading ? '—' : data?.tenants?.total ?? 0}
          note={data ? `${data.tenants.active} active` : null}
        />
        <StatTile
          icon="analytics"
          label="GMV settled"
          value={isLoading ? '—' : formatNaira(data?.gmv ?? 0)}
          note={data ? `${data.orders} orders` : null}
        />
        <StatTile
          icon="payouts"
          label="Commission earned"
          value={isLoading ? '—' : formatNaira(data?.commission ?? 0)}
          note={
            data?.escrow?.commissionPending
              ? `${formatNaira(data.escrow.commissionPending)} pending`
              : 'Settled only'
          }
        />
        <StatTile
          icon="orders"
          label="Held in escrow"
          value={isLoading ? '—' : formatNaira(data?.escrow?.amount ?? 0)}
          note={data ? `${data.escrow.held} orders` : null}
          tone="amber"
        />
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <section className="card p-4">
          <h2 className="text-sm font-semibold text-ink">Stores by plan</h2>
          <dl className="mt-3 space-y-2">
            {['starter', 'growth', 'business'].map((tier) => (
              <div key={tier} className="flex items-center justify-between text-sm">
                <dt className="capitalize text-text">{tier}</dt>
                <dd className="font-medium tabular-nums text-ink">
                  {data?.tenants?.byTier?.[tier] ?? 0}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="card p-4">
          <h2 className="text-sm font-semibold text-ink">Needs attention</h2>
          <div className="mt-3 space-y-2">
            <Attention
              to="/admin/disputes"
              label="Open disputes"
              value={data?.openDisputes ?? 0}
              tone={data?.openDisputes ? 'red' : 'ok'}
            />
            <Attention
              to="/admin/escrow"
              label="Holds past deadline"
              value={data?.escrow?.overdue ?? 0}
              tone={data?.escrow?.overdue ? 'red' : 'ok'}
            />
            {/* A store whose WhatsApp has dropped is silently not selling.
                They will not report it as an outage — they will report, weeks
                later, that things went quiet. */}
            <Attention
              to="/admin/tenants"
              label="WhatsApp disconnected"
              value={data?.whatsapp?.broken ?? 0}
              tone={data?.whatsapp?.broken ? 'red' : 'ok'}
            />
          </div>
        </section>
      </div>
    </>
  );
}

function Attention({ to, label, value, tone }) {
  return (
    <Link
      to={to}
      className="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2 text-sm hover:bg-overlay"
    >
      <span className="text-text">{label}</span>
      <span
        className={`rounded-pill px-2 py-0.5 text-xs font-semibold tabular-nums ${
          tone === 'red' ? 'bg-red-lt text-red' : 'bg-green-lt text-green'
        }`}
      >
        {value}
      </span>
    </Link>
  );
}
