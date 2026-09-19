import PageHeader from '../../components/ui/PageHeader.jsx';

// Scaffold. The screen is designed (see the mockups) but the data layer it
// reads from does not exist yet — src/lib/orders.js lands with phase 2.
export default function Orders() {
  return (
    <>
      <PageHeader title="Orders" subtitle="Every sale, and where it has got to." />
      <div className="card grid min-h-[240px] place-items-center p-6 text-sm text-muted">
        Not built yet.
      </div>
    </>
  );
}
