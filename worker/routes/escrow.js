import { config } from '../lib/env.js';
import { db } from '../lib/supabase.js';
import { releaseEscrow } from '../lib/orders.js';
import { sendAllPending } from '../lib/transfers.js';
import { billingSweep } from '../lib/billing.js';
import { ownerSay } from './billing.js';

// The sweep that makes escrow safe to sell.
//
// A buyer who simply stops replying would otherwise freeze the seller's money
// indefinitely, and a seller who has experienced that once goes back to asking
// for bank transfers — which is the behaviour this whole platform exists to
// replace. So the hold has a deadline, and this is what enforces it.
//
// Runs from the scheduled handler. The partial index on
// (confirm_deadline) WHERE escrow_status = 'held' is what keeps this cheap as
// the orders table grows.
export async function releaseExpiredHolds(env, { limit = 100 } = {}) {
  const cfg = config(env);
  if (!cfg.supabaseUrl || !cfg.serviceKey) {
    console.error('escrow sweep: not configured');
    return { checked: 0, released: 0 };
  }

  const now = new Date().toISOString();

  const due = await db(cfg).select(
    'orders',
    `escrow_status=eq.held&confirm_deadline=lt.${now}` +
      `&select=id,tenant_id,order_code,amount,commission,confirmed_at` +
      `&order=confirm_deadline.asc&limit=${limit}`
  );

  let released = 0;

  for (const order of due ?? []) {
    try {
      const result = await releaseEscrow(cfg, order, { reason: 'deadline_passed' });
      if (result.released) released += 1;
    } catch (err) {
      // One bad order must not strand the rest of the batch. The next run
      // picks it up again, because nothing was written for it.
      console.error('escrow sweep: failed on', order.order_code, err.message);
    }
  }

  return { checked: due?.length ?? 0, released };
}

// Payouts that could not go when they were created. See lib/transfers.js.
export async function sendOwedPayouts(env) {
  const cfg = config(env);
  if (!cfg.supabaseUrl || !cfg.serviceKey || !cfg.paystackKey) return null;
  return sendAllPending(cfg);
}

// Plan fees. See lib/billing.js.
export async function runBilling(env, { now } = {}) {
  const cfg = config(env);
  if (!cfg.supabaseUrl || !cfg.serviceKey) return null;
  return billingSweep(cfg, { now: now ?? new Date(), say: ownerSay(cfg) });
}
