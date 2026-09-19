// The leaf mark, carried as literals rather than tokens.
//
// Same reasoning as Automate Naija's BrandMark: these are the logo's own
// colours, not the theme's. They have to read the same against the cream page
// and against the dark green sidebar, so they must not follow a token that
// changes underneath them.
//
// Tenant branding replaces this component wherever a seller has uploaded a
// logo — see TenantBrandMark. This is Unique Thrift's own mark, for the
// platform chrome and the login screen.
export default function BrandMark({ className = 'h-8 w-8' }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#12301E" />
      <path
        d="M16 7c-4.5 0-8 3.2-8 7.6 0 4 2.9 7.2 7 7.9V25h2v-2.5c4.1-.7 7-3.9 7-7.9C24 10.2 20.5 7 16 7Z"
        fill="#C89A4A"
      />
      <path
        d="M16 10.5c-2.6 0-4.6 1.9-4.6 4.3 0 2.1 1.4 3.8 3.4 4.2v-4.6h2.4v4.6c2-.4 3.4-2.1 3.4-4.2 0-2.4-2-4.3-4.6-4.3Z"
        fill="#5C7A3E"
      />
    </svg>
  );
}

// The wordmark beside the mark: "UNIQUE THRIFT" over "Sell. Grow. Together."
export function BrandLockup({ className = '', tone = 'light' }) {
  const primary = tone === 'light' ? 'text-white' : 'text-ink';
  const secondary = tone === 'light' ? 'text-white/55' : 'text-muted';

  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <BrandMark className="h-8 w-8 shrink-0" />
      <div className="leading-tight">
        <div className={`font-display text-sm font-bold tracking-wide ${primary}`}>
          UNIQUE THRIFT
        </div>
        <div className={`text-[10px] italic ${secondary}`}>Sell. Grow. Together.</div>
      </div>
    </div>
  );
}
