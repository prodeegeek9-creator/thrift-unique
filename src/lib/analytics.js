import { supabase } from './supabase.js';
import { CHANNELS } from './features.js';

// Sales over time, and which channel the money came from. Business tier.
//
// This is the screen that justifies recording source_channel on every order
// from the very first one, long before anybody can see it — a Business-tier
// read fed by a Starter-tier write. An order that never carried its channel
// cannot be given one later, so the donut below would have had a permanent
// hole in it shaped like everything sold before the feature shipped.

// What counts as a sale. An order that is paid but sitting in escrow is
// revenue the seller has earned and has not been handed yet, and leaving it
// out would make the chart disagree with the balance on the Payouts screen.
const COUNTED = ['paid', 'completed'];

export async function fetchAnalytics(tenantId, { from, to } = {}) {
  const empty = {
    totalSales: 0,
    orderCount: 0,
    averageOrder: 0,
    trend: [],
    byChannel: [],
  };
  if (!tenantId) return empty;

  const start = from ?? startOfMonth();
  const end = to ?? new Date().toISOString();

  const { data, error } = await supabase
    .from('orders')
    .select('amount, source_channel, created_at')
    .eq('tenant_id', tenantId)
    .in('status', COUNTED)
    .gte('created_at', start)
    .lte('created_at', end)
    .order('created_at', { ascending: true });

  if (error) throw error;

  const rows = data ?? [];
  if (!rows.length) return empty;

  const totalSales = rows.reduce((n, r) => n + Number(r.amount || 0), 0);

  return {
    totalSales,
    orderCount: rows.length,
    averageOrder: Math.round(totalSales / rows.length),
    trend: dailyTrend(rows, start, end),
    byChannel: channelBreakdown(rows, totalSales),
  };
}

// One point per day across the whole window, including days with no sales.
//
// The gaps matter: a line chart that skips empty days draws a straight climb
// through a quiet week and makes it look like steady trade. Zeroes tell the
// truth.
function dailyTrend(rows, start, end) {
  const byDay = new Map();
  for (const r of rows) {
    const day = r.created_at.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + Number(r.amount || 0));
  }

  const out = [];
  const cursor = new Date(start.slice(0, 10));
  const last = new Date(end.slice(0, 10));

  while (cursor <= last) {
    const day = cursor.toISOString().slice(0, 10);
    out.push({ date: day, amount: byDay.get(day) ?? 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

// The donut: WhatsApp 42%, Instagram 30%, and so on.
//
// Every channel is returned even at zero, so the legend holds still between
// months instead of reshuffling colours as channels drop in and out. Orders
// with no channel recorded are reported as 'direct' rather than dropped —
// a slice that quietly vanishes makes the percentages lie.
function channelBreakdown(rows, totalSales) {
  const totals = new Map(CHANNELS.map((c) => [c.id, 0]));
  let direct = 0;

  for (const r of rows) {
    const amount = Number(r.amount || 0);
    if (r.source_channel && totals.has(r.source_channel)) {
      totals.set(r.source_channel, totals.get(r.source_channel) + amount);
    } else {
      direct += amount;
    }
  }

  const out = CHANNELS.map((c) => ({
    channel: c.id,
    label: c.label,
    amount: totals.get(c.id) ?? 0,
  }));

  if (direct > 0) out.push({ channel: 'direct', label: 'Direct', amount: direct });

  return out.map((row) => ({
    ...row,
    share: totalSales ? Math.round((row.amount / totalSales) * 100) : 0,
  }));
}

function startOfMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}
