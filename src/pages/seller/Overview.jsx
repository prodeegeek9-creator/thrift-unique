import PageHeader from '../../components/ui/PageHeader.jsx';

// Scaffold. The screen is designed (see the mockups) but the data layer it
// reads from does not exist yet — src/lib/dashboard.js lands with phase 2.
export default function Overview() {
  return (
    <>
      <PageHeader title="Overview" subtitle="Here's what's happening with your store today." />
      <div className="card grid min-h-[240px] place-items-center p-6 text-sm text-muted">
        Not built yet.
      </div>
    </>
  );
}
