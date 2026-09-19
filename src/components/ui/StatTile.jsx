import Icon from './Icon.jsx';

// The four numbers across the top of Overview, and the three on Analytics.
//
// `delta` is nullable on purpose and renders nothing when absent. A store in
// its first month has no previous month to compare against, and "+0%" there is
// a made-up number dressed as a measurement.
export default function StatTile({ icon, label, value, delta, note, tone = 'green' }) {
  const positive = typeof delta === 'number' ? delta > 0 : String(delta ?? '').startsWith('+');

  return (
    <div className="card p-4">
      <div className="flex items-center gap-2">
        {icon ? (
          <span
            className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg ${
              tone === 'amber' ? 'bg-amber-lt text-amber' : 'bg-green-lt text-green'
            }`}
          >
            <Icon name={icon} className="h-4 w-4" />
          </span>
        ) : null}
        <span className="text-xs text-muted">{label}</span>
      </div>

      <p className="mt-2 font-display text-2xl font-semibold text-ink">{value}</p>

      {delta != null ? (
        <p className={`mt-1 text-xs font-medium ${positive ? 'text-green' : 'text-muted'}`}>
          {delta}
        </p>
      ) : note ? (
        <p className="mt-1 text-xs text-muted">{note}</p>
      ) : null}
    </div>
  );
}
