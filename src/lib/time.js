// Dates, in the one place, so every screen renders them the same way.
//
// en-NG throughout. The alternative is the browser's locale, which puts an
// American date on a Nigerian seller's screen whenever their phone is set to
// US English — and "3/9" meaning the ninth of March rather than the third of
// September is the kind of bug nobody reports, they just get the day wrong.

const NG = 'en-NG';

// "12 Sep, 10:24" — the orders table.
export function dateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(NG, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// "12 Sep 2026" — payouts, contacts.
export function dateOnly(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(NG, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

// "12 days ago" — the Contacts table's last-purchase column, which is read as
// "is this person still around" rather than as a date.
export function relative(iso) {
  if (!iso) return 'Never';

  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86_400_000);

  if (days < 0) return dateOnly(iso);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  if (days < 365) {
    const months = Math.floor(days / 30);
    return `${months} month${months === 1 ? '' : 's'} ago`;
  }
  return dateOnly(iso);
}

// The current month, for the Analytics header.
export function monthLabel(d = new Date()) {
  return d.toLocaleDateString(NG, { month: 'long', year: 'numeric' });
}
