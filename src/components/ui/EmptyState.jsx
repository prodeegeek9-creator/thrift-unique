import Icon from './Icon.jsx';

// What a screen shows before a seller has done the thing it is for.
//
// Worth more care than it looks: a brand-new store sees nothing but these, so
// each one should say what to do next rather than "No data". The `action` is
// usually the same button the populated screen carries in its header.
export default function EmptyState({ icon = 'listings', title, body, action }) {
  return (
    <div className="card flex flex-col items-center px-6 py-12 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-full bg-surface-2 text-muted">
        <Icon name={icon} className="h-6 w-6" />
      </span>
      <h2 className="mt-4 font-display text-base font-semibold text-ink">{title}</h2>
      {body ? <p className="mt-1 max-w-xs text-sm text-muted">{body}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

// The skeleton rows a table shows while its query is in flight. Matching the
// real row height stops the page jumping when the data lands.
export function LoadingRows({ rows = 4, className = '' }) {
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-12 animate-pulse rounded-lg bg-surface-2" />
      ))}
    </div>
  );
}
