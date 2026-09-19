import { badgeFor } from '../../lib/features.js';

// The "Growth+" / "Business" pill. Renders nothing for a flag everyone has,
// and nothing once the tenant holds the flag — a badge on a feature you have
// already paid for is just noise.
export default function TierBadge({ flag, unlocked = false, className = '' }) {
  const label = badgeFor(flag);
  if (!label || unlocked) return null;

  const growth = label === 'Growth+';

  return (
    <span
      className={`rounded-pill px-1.5 py-0.5 text-[10px] font-semibold leading-none ${
        growth
          ? 'bg-tier-growth-lt text-tier-growth'
          : 'bg-tier-business-lt text-tier-business'
      } ${className}`}
    >
      {label}
    </span>
  );
}
