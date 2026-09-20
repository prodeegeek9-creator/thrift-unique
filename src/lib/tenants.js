import { supabase } from './supabase.js';

// The store itself: the Settings screen, and the branding the dashboard chrome
// reads.

// What an owner may change from the dashboard. Everything absent is absent on
// purpose:
//
//   tier, status        the plan is changed by billing, not by the customer
//   commission_pct      a seller editing their own commission is the whole
//                       business model going out of the window
//   waha_session        platform-managed; the seller only scans a QR code
//   paystack_subaccount written when the bank details are verified
//   slug                it is in every shared product link already out there
//
// The RLS policy allows an owner to UPDATE the row, so these are the columns
// the UI is willing to send. The policy stops somebody else's store being
// edited; this stops the wrong columns on their own.
const EDITABLE = ['name', 'logo_url', 'brand_color', 'whatsapp_number'];

const COLUMNS =
  'id, slug, name, tier, status, logo_url, brand_color, whatsapp_number, ' +
  'commission_pct, waha_session, waha_status, disclaimer_accepted_at, created_at';

export async function fetchTenant(tenantId) {
  if (!tenantId) return null;

  const { data, error } = await supabase
    .from('tenants')
    .select(COLUMNS)
    .eq('id', tenantId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function updateTenant(tenantId, patch) {
  const clean = {};
  for (const key of EDITABLE) {
    if (key in patch) clean[key] = patch[key];
  }

  if (!Object.keys(clean).length) return fetchTenant(tenantId);

  const { data, error } = await supabase
    .from('tenants')
    .update(clean)
    .eq('id', tenantId)
    .select(COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

// The public link for one listing, which is the thing a seller copies into a
// caption or a DM. Built here rather than in a component so every screen that
// offers a share button produces the same URL.
export function productUrl(publicCode) {
  if (!publicCode) return null;
  return `${window.location.origin}/p/${publicCode}`;
}

// A tenant's branding, as the CSS variables index.css already defines.
//
// Returned as a style object rather than written to document.documentElement,
// so the dashboard chrome can carry a seller's colour without a global side
// effect that outlives the component — and so switching stores in the sidebar
// cannot leave the previous store's colour behind.
export function brandStyle(tenant) {
  if (!tenant?.brand_color) return undefined;

  const rgb = hexToChannels(tenant.brand_color);
  if (!rgb) return undefined;

  // Only the accent moves. The surfaces, the type scale and the status colours
  // are the product's, not the tenant's: a seller who picked a pale yellow
  // should not be able to make their own "paid" pill unreadable.
  return { '--c-green': rgb };
}

// '#5C7A3E' -> '92 122 62', the channel-triplet form every token uses so
// Tailwind's slash-opacity syntax keeps working.
function hexToChannels(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}
