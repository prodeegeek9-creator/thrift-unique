// Buyer phone numbers are masked wherever they appear — the Overview table,
// Orders, the order detail, Contacts. The mockups show +234 80••••21 in every
// one of them, so this is a platform rule rather than a formatting choice made
// per screen.
//
// Masking here is presentation, not protection: the unmasked number is in the
// row the client already has. What actually keeps a Starter tenant from
// reading their buyers' contact details is the column grant in the RLS policy
// — see the tenancy migration. This function exists so that a screen which is
// allowed the number still does not casually put it on a shared laptop.

// +2348012345621 → +234 80••••21
export function maskPhone(raw) {
  const digits = String(raw ?? '').replace(/[^\d]/g, '');
  if (digits.length < 7) return raw ? '••••' : '—';

  // Nigerian numbers arrive as both 0801... and 234801..., sometimes with the
  // + and sometimes without. Normalise to the international form so the mask
  // lands in the same place either way.
  const intl = digits.startsWith('234')
    ? digits
    : `234${digits.replace(/^0/, '')}`;

  const cc = intl.slice(0, 3);
  const head = intl.slice(3, 5);
  const tail = intl.slice(-2);
  return `+${cc} ${head}••••${tail}`;
}

// Buyer names are shown in full to the tenant that sold to them — they are the
// seller's own customer. This trims a pasted WhatsApp display name down to
// something a table column can hold.
export function shortName(name, max = 22) {
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'Buyer';
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

export function initialsOf(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}
