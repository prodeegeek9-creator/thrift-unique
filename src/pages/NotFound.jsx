import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4">
      <div className="card max-w-sm p-6 text-center">
        <h1 className="font-display text-lg font-semibold">Nothing here</h1>
        <p className="mt-2 text-sm text-muted">
          That link doesn't lead anywhere in the dashboard.
        </p>
        <Link
          to="/dashboard"
          className="mt-4 inline-block rounded-pill bg-sidebar px-4 py-2 text-sm font-medium text-white"
        >
          Back to Overview
        </Link>
      </div>
    </div>
  );
}
