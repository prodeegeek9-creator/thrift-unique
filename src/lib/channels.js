import { supabase } from './supabase.js';
import { CHANNELS, hasFeature } from './features.js';

// Where listings get posted, and whether each channel is actually wired up.
//
// Read through channel_status(), never from channel_connections directly. That
// table has RLS enabled with no policy at all, because every column on it that
// matters is a credential — a long-lived token that posts as the seller until
// it is revoked. The function returns four safe columns and checks the tenant
// itself, and it is the only way in from the browser.

export async function fetchChannels(tenantId, tenant) {
  if (!tenantId) return [];

  const { data, error } = await supabase.rpc('channel_status', { target: tenantId });
  if (error) throw error;

  const connected = new Map((data ?? []).map((row) => [row.channel, row]));

  // Every channel is returned, in the order the mockups list them, whether it
  // is connected or not. The Channels screen is as much about what is missing
  // as what is working — an Instagram that silently is not linked is the
  // failure this screen exists to make visible.
  return CHANNELS.map((c) => {
    const row = connected.get(c.id);
    const unlocked = !c.flag || hasFeature(tenant, c.flag);

    return {
      id: c.id,
      label: c.label,
      flag: c.flag,
      unlocked,
      connected: Boolean(row),
      accountName: row?.account_name ?? null,
      connectedAt: row?.connected_at ?? null,
      // A token that has expired is worse than one that was never added: the
      // seller believes they are posting to Instagram and nothing is arriving.
      healthy: row ? row.healthy : null,
      state: !unlocked
        ? 'locked'
        : !row
          ? 'disconnected'
          : row.healthy
            ? 'connected'
            : 'expired',
    };
  });
}

// WhatsApp is never "connected" in the OAuth sense — the seller scanned a QR
// code once and the platform routes their session through WAHA. It shows as
// live when the tenant has a session assigned.
export function whatsappState(tenant) {
  if (!tenant) return 'disconnected';
  return tenant.waha_session ? 'connected' : 'disconnected';
}

// Where the OAuth dance starts. The Worker owns both ends of it: the browser
// never sees an app secret, and the token that comes back is written under the
// service key into a table the browser cannot read.
//
// Instagram needs a Business or Creator account linked to a Facebook Page —
// a personal account cannot be published to at all, and finding that out after
// somebody has upgraded to Growth is the wrong moment.
export function connectUrl(channel) {
  return `/api/oauth/${channel}/start`;
}

export async function disconnectChannel(channel) {
  const res = await fetch(`/api/oauth/${channel}/disconnect`, { method: 'POST' });
  if (!res.ok) throw new Error('Could not disconnect that channel');
  return res.json();
}
