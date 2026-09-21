import { supabase } from './supabase.js';
import { hasFeature } from './features.js';
import { formatNaira } from './money.js';

// What the bell is for.
//
// It rang for nothing before this: a button with no handler and an amber dot
// that was always on, which trains a seller to ignore the one place the app
// has to tell them something urgent.
//
// So there is no notifications table, and deliberately not. Everything worth
// interrupting somebody about is already a row in a table they own — an order
// nobody has posted, a dispute waiting on them, money they can withdraw, a
// WhatsApp session that has died. Deriving the list means it cannot go stale,
// cannot be missed because a write failed, and needs no backfill for stores
// that existed before the bell worked.
//
// Everything here reads through RLS as the seller, so a notification can only
// ever be about their own store.

export async function fetchNotifications(tenantId, tenant) {
  if (!tenantId) return [];

  const [unshipped, disputes, payable, awaitingBuyer] = await Promise.all([
    // Paid for and not yet sent. The one thing on this list where the seller
    // is holding somebody else's money and owes them an item.
    count('orders', tenantId, (q) =>
      q.in('status', ['paid', 'escrow']).is('shipped_at', null)
    ),

    hasFeature(tenant, 'disputes')
      ? count('disputes', tenantId, (q) => q.in('status', ['open', 'under_review']))
      : 0,

    sum('payouts', tenantId, 'amount', (q) => q.eq('status', 'pending')),

    hasFeature(tenant, 'escrow')
      ? count('orders', tenantId, (q) => q.eq('escrow_status', 'held'))
      : 0,
  ]);

  const items = [];

  // Ordered by how much it costs to ignore, not by recency. A dispute left
  // alone becomes a refund; an unposted order becomes one.
  if (disputes > 0) {
    items.push({
      id: 'disputes',
      tone: 'bad',
      icon: 'disputes',
      title: `${disputes} dispute${disputes === 1 ? '' : 's'} waiting on you`,
      body: 'A buyer has raised a problem. Unanswered disputes are usually refunded.',
      to: '/dashboard/disputes',
    });
  }

  if (unshipped > 0) {
    items.push({
      id: 'unshipped',
      tone: 'warn',
      icon: 'orders',
      title: `${unshipped} order${unshipped === 1 ? '' : 's'} to send`,
      body: 'Paid for and not marked as sent yet.',
      to: '/dashboard/orders',
    });
  }

  // A seller whose WhatsApp has dropped is silently not selling. They will not
  // read it as an outage — they will notice, weeks later, that things went
  // quiet. This is the whole reason the bell is worth wiring up.
  if (tenant?.waha_status && tenant.waha_status !== 'WORKING') {
    const pairing = tenant.waha_status === 'STARTING' || tenant.waha_status === 'SCAN_QR_CODE';

    items.push({
      id: 'whatsapp',
      tone: pairing ? 'warn' : 'bad',
      icon: 'whatsapp',
      title: pairing ? 'Finish linking WhatsApp' : 'WhatsApp is disconnected',
      body: pairing
        ? 'Scan the code to start posting listings to your Status.'
        : 'Your listings are not reaching your Status. Link it again.',
      to: '/dashboard/channels',
    });
  }

  if (payable > 0) {
    items.push({
      id: 'payout',
      tone: 'good',
      icon: 'payouts',
      title: `${formatNaira(payable)} ready to withdraw`,
      body: 'Cleared and waiting on your next payout.',
      to: '/dashboard/payouts',
    });
  }

  if (awaitingBuyer > 0) {
    items.push({
      id: 'escrow',
      tone: 'info',
      icon: 'payouts',
      title: `${awaitingBuyer} order${awaitingBuyer === 1 ? '' : 's'} awaiting confirmation`,
      body: 'Funds release once the buyer confirms, or when the deadline passes.',
      to: '/dashboard/orders',
    });
  }

  return items;
}

// Only the ones a seller should act on now. The dot exists to mean "something
// is wrong", so a payout waiting to be collected must not light it — that is
// good news, and good news that nags is noise.
export function unreadCount(items) {
  return (items ?? []).filter((i) => i.tone === 'bad' || i.tone === 'warn').length;
}

async function count(table, tenantId, build) {
  let q = supabase
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);

  if (build) q = build(q);

  const { count: n, error } = await q;
  // A count that fails must not take the whole bell down with it — a seller
  // losing their dispute notification because the payouts query errored is a
  // worse outcome than one missing line.
  if (error) return 0;
  return n ?? 0;
}

async function sum(table, tenantId, column, build) {
  let q = supabase.from(table).select(column).eq('tenant_id', tenantId);
  if (build) q = build(q);

  const { data, error } = await q;
  if (error) return 0;
  return (data ?? []).reduce((n, r) => n + Number(r[column] || 0), 0);
}
