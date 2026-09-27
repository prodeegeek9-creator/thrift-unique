export default function BrandMark({ className = 'h-8 w-8' }) {
  return (
    <img
      src="/vendwyze-logo.png"
      alt="Vendwyze"
      className={className}
      aria-hidden="true"
    />
  );
}

export function BrandLockup({ className = '', tone = 'light' }) {
  return (
    <div className={`flex items-center ${className}`}>
      <img
        src="/vendwyze-logo.png"
        alt="Vendwyze - Sell Smarter. Grow Easier."
        className="h-auto w-[190px]"
      />
    </div>
  );
}
