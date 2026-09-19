import Icon from './Icon.jsx';
import { CHANNELS } from '../../lib/features.js';

// The row of four channel icons on every listing card.
//
// All four always render. A channel that is not posted to shows greyed rather
// than being omitted, because the row is a status display, not a list of
// successes — a seller needs to see that Instagram is missing, and a row that
// silently shortens hides exactly that.
//
// Failures are red and carry a title, since a publish that failed is the thing
// most worth knowing on this screen and the only place it ever surfaces.
const TONE = {
  posted: 'text-green',
  queued: 'text-amber',
  failed: 'text-red',
  skipped: 'text-muted/40',
};

export default function ChannelDots({ posts = {}, className = '' }) {
  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      {CHANNELS.map((c) => {
        const row = posts[c.id];
        const tone = row ? (TONE[row.status] ?? 'text-muted/40') : 'text-muted/25';
        const label = row
          ? `${c.label}: ${row.status}${row.error ? ` — ${row.error}` : ''}`
          : `${c.label}: not posted`;

        return (
          <span key={c.id} className={tone} title={label}>
            <span className="sr-only">{label}</span>
            <Icon name={c.id} className="h-4 w-4" />
          </span>
        );
      })}
    </div>
  );
}
