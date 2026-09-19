import BrandMark from './BrandMark.jsx';

export default function LogoLoader({ fullScreen = false, label }) {
  const inner = (
    <div className="flex flex-col items-center gap-3">
      <BrandMark className="h-10 w-10 animate-pulse" />
      {label ? <p className="text-sm text-muted">{label}</p> : null}
    </div>
  );

  if (!fullScreen) return inner;

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg">{inner}</div>
  );
}
