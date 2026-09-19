import PageHeader from '../../components/ui/PageHeader.jsx';

// Scaffold. The screen is designed (see the mockups) but the data layer it
// reads from does not exist yet — src/lib/navItems.js lands with phase 2.
export default function More() {
  return (
    <>
      <PageHeader title="More" subtitle="Everything that does not fit the tab bar." />
      <div className="card grid min-h-[240px] place-items-center p-6 text-sm text-muted">
        Not built yet.
      </div>
    </>
  );
}
