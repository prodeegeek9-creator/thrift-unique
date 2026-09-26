// Every status in the product, and the only place that decides which of the
// three colours one gets. Three hues carry the whole system — green for
// settled, amber for in flight, red for wrong — and a screen that invents a
// fourth is a screen that has invented a state nobody designed.
//
// The keys are the database enums, so a status arriving from a row renders
// without translation. Anything unrecognised falls back to neutral rather than
// throwing: an unknown status should look unfamiliar, not break the table.
const TONES = {
  // Orders
  awaiting_payment: { label: 'Awaiting payment', tone: 'neutral' },
  processing: { label: 'Processing', tone: 'amber' },
  escrow: { label: 'Escrow', tone: 'green-outline' },
  paid: { label: 'Paid', tone: 'green' },
  completed: { label: 'Completed', tone: 'green' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  refunded: { label: 'Refunded', tone: 'red' },

  // Listings
  active: { label: 'Active', tone: 'green' },
  pending: { label: 'Pending review', tone: 'amber' },
  sold: { label: 'Sold', tone: 'neutral' },
  rejected: { label: 'Rejected', tone: 'red' },

  // Disputes
  open: { label: 'Open', tone: 'red' },
  under_review: { label: 'Under review', tone: 'amber' },
  resolved: { label: 'Resolved', tone: 'green' },

  // Channel publishing
  posted: { label: 'Posted', tone: 'green' },
  queued: { label: 'Queued', tone: 'amber' },
  failed: { label: 'Failed', tone: 'red' },
  // Payouts: handed to Paystack, waiting for the bank.
  sending: { label: 'Sending', tone: 'amber' },
};

const CLASSES = {
  green: 'bg-green-lt text-green',
  'green-outline': 'bg-surface text-green ring-1 ring-inset ring-green/30',
  amber: 'bg-amber-lt text-amber',
  red: 'bg-red-lt text-red',
  neutral: 'bg-surface-2 text-muted',
};

export default function StatusPill({ status, label, className = '' }) {
  const known = TONES[status] ?? { label: status ?? 'Unknown', tone: 'neutral' };
  const tone = CLASSES[known.tone] ?? CLASSES.neutral;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-pill px-2 py-1 text-xs font-medium ${tone} ${className}`}
    >
      {/* The leading dot from the mockups. Decorative — the label already says
          what the dot is colouring. */}
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {label ?? known.label}
    </span>
  );
}
