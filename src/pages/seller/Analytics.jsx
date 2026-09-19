import { useQuery } from '@tanstack/react-query';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import PageHeader from '../../components/ui/PageHeader.jsx';
import StatTile from '../../components/ui/StatTile.jsx';
import EmptyState from '../../components/ui/EmptyState.jsx';
import { useTenant } from '../../lib/TenantContext.jsx';
import { fetchAnalytics } from '../../lib/analytics.js';
import { formatNaira, formatCompact, formatDelta } from '../../lib/money.js';
import { monthLabel } from '../../lib/time.js';
import { keys } from '../../lib/queryKeys.js';

// Series colours come from the tokens in index.css, never as hex here. They
// are a separate ramp from the status colours because green/amber/red already
// mean settled / in flight / wrong everywhere else, and a channel wearing red
// would read as a failure.
const SERIES = {
  whatsapp: 'var(--c-series-whatsapp)',
  instagram: 'var(--c-series-instagram)',
  facebook: 'var(--c-series-facebook)',
  tiktok: 'var(--c-series-tiktok)',
  direct: 'var(--c-series-direct)',
};

export default function Analytics() {
  const { tenant } = useTenant();
  const tenantId = tenant?.id;

  const { data, isLoading } = useQuery({
    queryKey: keys.analytics(tenantId, 'month', 'now'),
    queryFn: () => fetchAnalytics(tenantId),
    enabled: Boolean(tenantId),
  });

  const hasSales = Boolean(data?.orderCount);

  return (
    <>
      <PageHeader
        title="Analytics"
        subtitle={`${monthLabel()} · what sold, and where it came from.`}
      />

      {isLoading ? (
        <div className="h-96 animate-pulse rounded-card bg-surface-2" />
      ) : !hasSales ? (
        <EmptyState
          icon="analytics"
          title="No sales this month"
          body="Once orders come in, this shows how sales moved through the month and which channel brought them."
        />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <StatTile label="Total sales" value={formatNaira(data.totalSales)} />
            <StatTile label="Orders" value={data.orderCount} />
            <StatTile label="Average order" value={formatNaira(data.averageOrder)} />
          </div>

          <div className="grid gap-4 lg:grid-cols-5">
            <SalesTrend points={data.trend} />
            <ChannelShare rows={data.byChannel} total={data.totalSales} />
          </div>
        </div>
      )}
    </>
  );
}

// One series, so no legend — the heading names it. 2px line, no dot on every
// point (a number on every point is noise), an 8px marker only where the
// crosshair lands.
function SalesTrend({ points }) {
  return (
    <section className="card p-4 lg:col-span-3">
      <h2 className="text-sm font-semibold text-ink">Sales trend</h2>
      <p className="mb-3 text-xs text-muted">Daily, this month</p>

      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
            {/* Recessive grid: horizontal only, one hairline, no vertical
                rules competing with the line itself. */}
            <CartesianGrid stroke="var(--c-line)" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={(d) => new Date(d).getDate()}
              tick={{ fontSize: 11, fill: 'rgb(var(--c-muted))' }}
              axisLine={false}
              tickLine={false}
              minTickGap={16}
            />
            <YAxis
              tickFormatter={(v) => formatCompact(v)}
              tick={{ fontSize: 11, fill: 'rgb(var(--c-muted))' }}
              axisLine={false}
              tickLine={false}
              width={56}
            />
            <Tooltip
              cursor={{ stroke: 'var(--c-line)', strokeWidth: 1 }}
              content={<TrendTooltip />}
            />
            <Line
              type="monotone"
              dataKey="amount"
              stroke="rgb(var(--c-green))"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: 'rgb(var(--c-surface))' }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function TrendTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 shadow-pop">
      <p className="text-[11px] text-muted">
        {new Date(label).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}
      </p>
      <p className="text-sm font-semibold text-ink">{formatNaira(payload[0].value)}</p>
    </div>
  );
}

// Part-to-whole, as a stacked bar rather than the donut in the mockups.
//
// A donut makes the reader compare arc lengths around a circle, which is the
// one comparison people are worst at — and with Instagram at 30% and Facebook
// at 19% those arcs are close enough to be a coin flip. A single stacked bar
// puts every share on one straight axis, fits the narrow column better, and
// carries its numbers directly.
//
// 2px of surface between segments, so adjacent fills never touch and two
// similar hues cannot appear to merge into one.
function ChannelShare({ rows, total }) {
  const present = rows.filter((r) => r.amount > 0);

  return (
    <section className="card p-4 lg:col-span-2">
      <h2 className="text-sm font-semibold text-ink">Where your sales came from</h2>
      <p className="mb-3 text-xs text-muted">Share of {formatNaira(total)}</p>

      <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-pill">
        {present.map((r) => (
          <span
            key={r.channel}
            className="h-full first:rounded-l-pill last:rounded-r-pill"
            style={{ width: `${r.share}%`, background: SERIES[r.channel] ?? SERIES.direct }}
          />
        ))}
      </div>

      {/* The legend is also the table: every channel named, its colour beside
          it, and the number written out — so identity never rests on colour
          alone, and a screen reader gets the same content the chart shows. */}
      <dl className="mt-4 space-y-2">
        {rows.map((r) => (
          <div key={r.channel} className="flex items-center gap-2 text-sm">
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: SERIES[r.channel] ?? SERIES.direct }}
            />
            <dt className="flex-1 text-text">{r.label}</dt>
            <dd className="tabular-nums text-muted">{formatNaira(r.amount)}</dd>
            <dd className="w-10 text-right font-medium tabular-nums text-ink">{r.share}%</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
