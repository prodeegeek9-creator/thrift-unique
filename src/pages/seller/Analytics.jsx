import PageHeader from '../../components/ui/PageHeader.jsx';

// Scaffold. The screen is designed (see the mockups) but the data layer it
// reads from does not exist yet — src/lib/analytics.js lands with phase 2.
export default function Analytics() {
  return (
    <>
      <PageHeader title="Analytics" subtitle="What sold, and which channel it came from." />
      <div className="card grid min-h-[240px] place-items-center p-6 text-sm text-muted">
        Not built yet.
      </div>
    </>
  );
}
