// Vendwyze platform mark: a shopping cart carrying a stylised V.
// The cart communicates commerce; the V makes the mark ownable to Vendwyze.
// The lime/forest palette is fixed here because this is platform branding,
// not tenant theming.

export default function BrandMark({ className = 'h-8 w-8' }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="vendwyzeMark" x1="8" y1="8" x2="40" y2="40" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#A8E600" />
          <stop offset="0.55" stopColor="#63C51A" />
          <stop offset="1" stopColor="#0B2E1F" />
        </linearGradient>
      </defs>
      <path
        d="M9 10h4l2.8 18.1a4 4 0 0 0 4 3.4h14.8a4 4 0 0 0 3.8-2.7L42 16H17"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15.8 18.1 22.2 29 28.3 18.1 34.4 29 40.7 18.1"
        fill="none"
        stroke="url(#vendwyzeMark)"
        strokeWidth="4.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="21" cy="37.2" r="2.8" fill="#0B2E1F" />
      <circle cx="35" cy="37.2" r="2.8" fill="#0B2E1F" />
      <path d="M29 7v4.5M26.75 9.25h4.5" stroke="#A8E600" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

export function BrandLockup({ className = '', tone = 'light' }) {
  const primary = tone === 'light' ? 'text-white' : 'text-ink';
  const secondary = tone === 'light' ? 'text-white/60' : 'text-muted';

  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <BrandMark className="h-8 w-8 shrink-0" />
      <div className="leading-tight">
        <div className={`font-sans text-sm font-extrabold tracking-[0.12em] ${primary}`}>
          VENDWYZE
        </div>
        <div className={`text-[10px] font-medium tracking-wide ${secondary}`}>
          Sell smarter. Grow easier.
        </div>
      </div>
    </div>
  );
}
