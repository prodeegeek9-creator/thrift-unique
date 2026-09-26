import { db } from './supabase.js';
import { split } from './money.js';
import { sendPayout } from './transfers.js';

// The order lifecycle, server side. Everything here runs under the service
// key, so every query names its tenant explicitly — Postgres has stopped
// checking.

// How long a buyer has to confirm receipt before the hold releases on its own.
//
// Without a deadline a buyer who simply stops replying freezes the seller's
// money forever, which is the failure mode that makes sellers distrust escrow
// and go back to asking for bank transfers.
export const CONFIRM_WINDOW_DAYS = 7;

const ORDER_FIELDS =
  'id,tenant_id,order_code,product_id,buyer_id,amount,commission,status,' +
  'escrow_status,source_channel,payment_ref,paid_at,shipped_at,' +
  'confirm_deadline,confirmed_at,completed_at,created_at';

export async function byPaymentRef(cfg, reference) {
  return db(cfg).one(
    'orders',
    `payment_ref=eq.${encodeURIComponent(reference)}&select=${ORDER_FIELDS}`
  );
}

export async function byId(cfg, tenantId, orderId) {
  return db(cfg).one(
    'orders',
    `id=eq.${orderId}&tenant_id=eq.${tenantId}&select=${ORDER_FIELDS}`
  );
}

// A payment cleared. Move the order to wherever the tenant's plan puts it.
//
// Idempotent by construction: the WHERE clause only matches an order still
// waiting for payment, so a replayed webhook updates zero rows and returns the
// order unchanged. Paystack retries, and a retry that credits twice is the
// worst bug this file could have.
export async function markPaid(cfg, order, tenant, { amountNaira, reference, channel }) {
  const { commission } = split(amountNaira, tenant.commission_pct);
  const escrow = await tenantHasEscrow(cfg, tenant.id);
  const now = new Date().toISOString();

  const patch = {
    amount: amountNaira,
    commission,
    payment_ref: reference,
    paid_at: now,
    status: escrow ? 'escrow' : 'paid',
    escrow_status: escrow ? 'held' : 'none',
    confirm_deadline: escrow
      ? new Date(Date.now() + CONFIRM_WINDOW_DAYS * 86_400_000).toISOString()
      : null,
  };

  if (channel) patch.source_channel = channel;

  const rows = await db(cfg).update(
    'orders',
    `id=eq.${order.id}&status=eq.awaiting_payment&select=${ORDER_FIELDS}`,
    patch
  );

  // Zero rows means somebody got here first — a concurrent delivery of the
  // same webhook. Not an error; the work is done.
  if (!rows.length) return { order: await byPaymentRef(cfg, reference), replayed: true };

  const updated = rows[0];

  // Starter takes no hold, so the money is the seller's immediately and the
  // payout is owed now rather than after a confirmation that will never come.
  if (!escrow) await createPayout(cfg, updated);

  return { order: updated, replayed: false };
}

// Release the hold: the buyer confirmed, or the window closed.
//
// Same idempotency shape — only an order still holding funds matches.
export async function releaseEscrow(cfg, order, { reason }) {
  const now = new Date().toISOString();

  const rows = await db(cfg).update(
    'orders',
    `id=eq.${order.id}&escrow_status=eq.held&select=${ORDER_FIELDS}`,
    {
      escrow_status: 'released',
      status: 'completed',
      confirmed_at: reason === 'buyer_confirmed' ? now : order.confirmed_at,
      completed_at: now,
    }
  );

  if (!rows.length) return { order, released: false };

  const updated = rows[0];
  await createPayout(cfg, updated);
  return { order: updated, released: true };
}

// What the seller is owed for this order, and which order it was for.
//
// payout_items is a table rather than a column because one payout covers
// several orders and reconciling a dispute six weeks later means being able to
// say exactly which sale a given transfer paid for.
async function createPayout(cfg, order) {
  const { net, commission } = split(order.amount, pctFrom(order));

  const payout = await db(cfg).insert('payouts', {
    tenant_id: order.tenant_id,
    amount: net,
    commission,
    status: 'pending',
    // Derived from the order, so a retry hits the unique index instead of
    // creating a second payout for the same sale.
    reference: `PO-${order.order_code}`,
  });

  // The insert above collides on a replay; treat that as already done.
  if (!payout) return null;

  await db(cfg).insert(
    'payout_items',
    { payout_id: payout.id, order_id: order.id, amount: net },
    { returning: false }
  );

  // Straight to the store's bank, if it can go now. If not (no account yet,
  // paused, Paystack said no), it stays pending for the hourly sweep. Never
  // allowed to fail the payment that caused it.
  await sendPayout(cfg, payout).catch((err) =>
    console.error('payout not sent:', payout.reference, err?.message ?? err)
  );

  return payout;
}

// The commission actually charged on this order, recovered from the row rather
// than re-read from the tenant — a rate change must not retroactively alter
// what an older sale was worth.
function pctFrom(order) {
  const gross = Number(order.amount) || 0;
  if (!gross) return 0;
  return ((Number(order.commission) || 0) / gross) * 100;
}

async function tenantHasEscrow(cfg, tenantId) {
  const row = await db(cfg).one(
    'tenant_features',
    `tenant_id=eq.${tenantId}&flag=eq.escrow&select=enabled`
  );
  return Boolean(row?.enabled);
}
