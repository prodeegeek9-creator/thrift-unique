// Vendwyze brand assets are kept as repository files so the exact approved lockup
// and cart mark are reused everywhere instead of being redrawn per component.

export default function BrandMark({ className = 'h-8 w-8' }) {
  return (
    <img
      src="/favicon.svg"
      alt="Vendwyze"
      className={className}
      aria-hidden="true"
    />
  );
}

export function BrandLockup({ className = '', tone = 'light' }) {
  return (
    <div className={`flex items-center ${className}`}>
      <div className="rounded-xl bg-white px-3 py-2 shadow-sm">
        <img
          src="/logo.svg"
          alt="Vendwyze - Sell Smarter. Grow Easier."
          className="h-auto w-[190px]"
        />
      </div>
    </div>
  );
}
