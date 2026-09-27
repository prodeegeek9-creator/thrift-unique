import { db } from './supabase.js';
import { COLUMNS } from './columns.js';
import { initializeTransaction } from './paystack.js';
import { nairaToKobo } from './money.js';
import { formatNaira } from './bot.js';
import { chatId } from './waha.js';
import { settle } from '../routes/checkout.js';
import { confirmToken } from '../routes/confirm.js';
import { say } from '../routes/waha.js';
import { reserveItem, releaseReservation, reservedMinutes } from './reservations.js';
import { AMOUNT_MISMATCH, paidInFull, amountRefused } from './problems.js';

// A WhatsApp cart becoming a payment, and a paid cart becoming orders.
//
// At PAY the cart is written down: a carts row with the Paystack reference
// (utc_…) and one order per item, each with that reference plus its own
// suffix (utc_…_1, utc_…_2), awaiting payment. Paystack takes one payment for
// the total. When it succeeds (webhook or the return page), every order in
// the cart is settled exactly like a single purchase: marked paid, held in
// escrow or owed to the store, the item taken off sale. An item somebody else
// bought in the meantime is refunded at once and in full, automatically.
//
// Each item is held for the cart while its link is live (lib/reservations.js), so
// that last case needs a link paid after its hold ran out and somebody else
// took the item over.

const REF_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const isCartRef = (ref) => /^utc_[a-z0-9]{12,40}$/.test(String(ref ?? ''));

// The cart reference an order's own reference belongs to, if it is a cart
// order: utc_abc…_2 → utc_abc…. Paystack only knows the cart's.
export function cartRefOf(orderRef) {
  const m = /^(utc_[a-z0-9]{12,40})_\d+$/.exec(String(orderRef ?? ''));
  return m ? m[1] : null;
}

function random(n, alphabet) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

// → { url, ref, total, count, escrow, dropped: [titles], busy: [{ title, minutes, mine }] }
//   or { error } with a message for the buyer
//   or { needPhone: true } when WhatsApp hides this chat's number
//
// dropped have sold; busy are being paid for by somebody else (or, mine, by
// this buyer somewhere else), and are left out rather than paid for twice.
export async function createCartCheckout(cfg, tenant, { chat, phone, items, name, address }) {
  if (!cfg.paystackKey) return { error: "Online payment isn't switched on for this store yet. The store will reply to you here." };
  if (!phone) return { needPhone: true };

  // Still for sale, still this store's, at today's price.
  const candidates = [];
  const dropped = [];
  for (const item of items ?? []) {
    const p = await db(cfg).one(
      'products',
      `id=eq.${item.product_id}&tenant_id=eq.${tenant.id}&select=id,public_code,title,price,status`
    );
    if (p && p.status === 'active' && Number(p.price) > 0) candidates.push(p);
    else dropped.push(item.title);
  }
  if (!candidates.length) return { error: 'Sorry, everything in your cart has sold. Send *BUY* and a code to start again.', dropped };

  const buyer = await db(cfg).insert(
    'buyers',
    { tenant_id: tenant.id, phone, name },
    { onConflict: 'tenant_id,phone', merge: true }
  );
  if (!buyer?.id) throw new Error('buyer upsert returned no row');

  // Each item held for this cart, or left out and said why.
  const ref = `utc_${random(20, REF_ALPHABET)}`;
  const live = [];
  const busy = [];
  for (const p of candidates) {
    const hold = await reserveItem(cfg, { productId: p.id, tenantId: tenant.id, ref, buyerId: buyer.id });
    if (hold.ok) live.push(p);
    else if (hold.sold) dropped.push(p.title);
    else if (hold.busy) busy.push({ title: p.title, minutes: hold.busy.minutes, mine: true });
    else busy.push({ title: p.title, minutes: hold.held.minutes, mine: hold.held.mine });
  }
  if (!live.length) {
    return {
      error: busy.length
        ? `${busyLine(busy)}\n\nReply *PAY* to try again then, or send *BUY* and another code.`
        : 'Sorry, everything in your cart has sold. Send *BUY* and a code to start again.',
      dropped,
      busy,
    };
  }

  const total = live.reduce((n, p) => n + Number(p.price), 0);
  const cart = await db(cfg).insert('carts', {
    tenant_id: tenant.id,
    buyer_id: buyer.id,
    chat_id: chat,
    payment_ref: ref,
    amount: total,
    status: 'open',
    buyer_name: name,
    delivery_address: address,
  });

  let n = 0;
  for (const p of live) {
    n += 1;
    let order = null;
    for (let i = 0; i < 4 && !order; i += 1) {
      order = await db(cfg).insert(
        'orders',
        {
          tenant_id: tenant.id,
          order_code: `VW-${random(6, CODE_ALPHABET)}`,
          product_id: p.id,
          buyer_id: buyer.id,
          quantity: 1,
          amount: Number(p.price),
          commission: 0,
          status: 'awaiting_payment',
          escrow_status: 'none',
          payment_ref: `${ref}_${n}`,
          source_channel: 'whatsapp',
          delivery_address: address,
          cart_id: cart.id,
        },
        { onConflict: 'order_code' }
      );
    }
    if (!order) throw new Error('could not allocate an order code');
  }

  let checkout;
  try {
    checkout = await initializeTransaction(cfg.paystackKey, {
      email: `buyer-${phone}@${new URL(cfg.publicOrigin ?? 'https://example.com').hostname}`,
      amountKobo: nairaToKobo(total),
      reference: ref,
      callbackUrl: `${cfg.publicOrigin ?? ''}/order/${ref}`,
      metadata: { kind: 'cart', cart_ref: ref, tenant: tenant.slug, items: live.length, source_channel: 'whatsapp' },
    });
  } catch (err) {
    console.error('cart: paystack initialize failed:', err?.message ?? err);
    await abandonCart(cfg, tenant.id, ref);
    return { error: "I couldn't make the payment link just now. Reply *PAY* to try again in a minute." };
  }

  const escrow = await db(cfg).one('tenant_features', `tenant_id=eq.${tenant.id}&flag=eq.escrow&select=enabled`);
  return { url: checkout.authorization_url, ref, total, count: live.length, escrow: Boolean(escrow?.enabled), dropped, busy };
}

// "Someone else is paying for *Jacket* right now…", for items left out.
export function busyLine(busy) {
  return busy
    .map((b) =>
      b.mine
        ? `You already have a payment open for *${b.title}*, so I've left it out. It frees up in about ${b.minutes} min if you don't finish it.`
        : `Someone else is paying for *${b.title}* right now, so I've left it out. If their payment doesn't go through, it'll be free again in about ${b.minutes} min.`
    )
    .join('\n');
}

// Before a cart's link is sent again: the items it no longer has, because
// they sold or somebody else took them over once its hold ran out. A hold
// that has run out but that nobody else wanted is still this cart's.
export async function cartLost(cfg, tenantId, ref) {
  if (!isCartRef(ref)) return [];
  const cart = await db(cfg).one('carts', `payment_ref=eq.${ref}&tenant_id=eq.${tenantId}&status=eq.open&select=id`);
  if (!cart) return [];
  const orders = await db(cfg).select('orders', `cart_id=eq.${cart.id}&status=eq.awaiting_payment&select=product_id`);
  const lost = [];
  for (const o of orders) {
    const p = await db(cfg).one(
      'products',
      `id=eq.${o.product_id}&tenant_id=eq.${tenantId}&select=title,status,held_by_ref,held_until`
    );
    if (!p || p.status !== 'active' || (p.held_by_ref !== ref && reservedMinutes(p))) lost.push(p?.title ?? 'An item');
  }
  return lost;
}

// An unpaid link replaced or cancelled. Only an open cart; a paid one stays.
// Its items go back on sale at once.
export async function abandonCart(cfg, tenantId, ref) {
  if (!isCartRef(ref)) return;
  await releaseReservation(cfg, { tenantId, ref });
  const rows = await db(cfg).update('carts', `payment_ref=eq.${ref}&tenant_id=eq.${tenantId}&status=eq.open`, { status: 'cancelled' });
  if (!rows.length) return;
  await db(cfg).update(
    'orders',
    `cart_id=eq.${rows[0].id}&status=eq.awaiting_payment`,
    { status: 'cancelled' },
    { returning: false }
  );
}

// Paystack says the cart's payment succeeded. Safe to run twice, and from
// both the webhook and the return page: only an unpaid cart is claimed.
//
// Only for the cart's total, as settle() is only for an order's price.
export async function settleCart(cfg, ref, { kobo, requestedKobo = null }) {
  const cart = await db(cfg).one('carts', `payment_ref=eq.${ref}&select=${COLUMNS.cart}`);
  if (!cart) return { ignored: 'no such cart' };
  if (cart.status === 'paid') return { replayed: true };

  const expectedKobo = nairaToKobo(cart.amount);
  if (!paidInFull(expectedKobo, { kobo, requestedKobo })) {
    await amountRefused(cfg, { reference: ref, kobo, expectedKobo, what: 'a WhatsApp cart' });
    return { ignored: AMOUNT_MISMATCH };
  }

  // Paid even if the link had been replaced: the money arrived.
  const claimed = await db(cfg).update(
    'carts',
    `id=eq.${cart.id}&status=in.(open,cancelled)`,
    { status: 'paid', paid_at: new Date().toISOString() }
  );
  if (!claimed.length) return { replayed: true };
  await db(cfg).update(
    'orders',
    `cart_id=eq.${cart.id}&status=eq.cancelled&paid_at=is.null`,
    { status: 'awaiting_payment' },
    { returning: false }
  );

  const orders = await db(cfg).select(
    'orders',
    `cart_id=eq.${cart.id}&status=eq.awaiting_payment&select=${COLUMNS.order}&order=payment_ref.asc`
  );

  // An item sold to somebody else first is refunded in full inside settle()
  // (lateSale), and nobody is paid for it; the messages are sent below, one
  // for the lot.
  const done = [];
  for (const order of orders) {
    const r = await settle(cfg, order, { kobo: nairaToKobo(order.amount), channel: 'whatsapp', notify: false });
    done.push({ order: r.order ?? order, doubleSale: Boolean(r.doubleSale), refundFailed: Boolean(r.refundFailed), title: r.title });
  }

  // The chat is finished with; the next BUY starts a new cart.
  await db(cfg)
    .update(
      'bot_conversations',
      `tenant_id=eq.${cart.tenant_id}&chat_id=eq.${encodeURIComponent(cart.chat_id)}`,
      { state: 'idle', draft: {} },
      { returning: false }
    )
    .catch(() => {});

  await tellCart(cfg, cart, done).catch((err) => console.error('cart notices failed:', err?.message ?? err));
  return { settled: true, orders: done.length };
}

// One message to the buyer (from the store's number, in the chat they
// bought in) and one to the owner (on the platform number), for the lot.
async function tellCart(cfg, cart, done) {
  const tenant = await db(cfg).one(
    'tenants',
    `id=eq.${cart.tenant_id}&select=id,name,whatsapp_number,waha_session,waha_status`
  );
  if (!tenant) return;

  const kept = done.filter((d) => !d.doubleSale);
  const lost = done.filter((d) => d.doubleSale);
  const escrow = kept.some((d) => d.order.escrow_status === 'held');
  const sum = kept.reduce((n, d) => n + Number(d.order.amount), 0);

  const buyer = [`✅ Payment received — thank you, ${String(cart.buyer_name ?? '').split(' ')[0] || 'and welcome'}!`, ''];
  for (const d of kept) buyer.push(`• ${d.title ?? 'Item'} · ${formatNaira(d.order.amount)} · Order ${d.order.order_code}`);
  if (lost.length) {
    buyer.push('');
    for (const d of lost) {
      buyer.push(
        d.refundFailed
          ? `⚠️ *${d.title}* was sold to someone else just before you paid. Vendwyze will refund you in full for it and message you here when it's on its way.`
          : `↩️ *${d.title}* was sold to someone else just before you paid, so its full ${formatNaira(d.order.amount)} is being refunded to you. Banks usually take 3 to 10 working days to show it.`
      );
    }
  }
  if (kept.length) {
    buyer.push('', `${tenant.name} will contact you about delivery to: ${cart.delivery_address}`);
    if (escrow && cfg.tokenSecret) {
      buyer.push('', "Your payment is protected: the store is only paid once you confirm each item arrived. When it does, tap its link:");
      for (const d of kept.filter((x) => x.order.escrow_status === 'held')) {
        const token = await confirmToken(cfg, d.order);
        buyer.push(`${d.title ?? d.order.order_code}: ${cfg.publicOrigin ?? ''}/confirm/${token}`);
      }
    }
  }
  const own = tenant.waha_session && tenant.waha_status === 'WORKING' ? { session: tenant.waha_session } : {};
  await say(cfg, tenant, cart.chat_id, buyer.join('\n'), own);

  const owner = chatId(tenant.whatsapp_number);
  if (owner && kept.length) {
    const lines = [
      `💰 *New WhatsApp order* — ${kept.length} item${kept.length === 1 ? '' : 's'}, ${formatNaira(sum)} paid`,
      '',
      ...kept.map((d) => `• ${d.title ?? 'Item'} · ${formatNaira(d.order.amount)} · ${d.order.order_code}`),
      '',
      `Buyer: ${cart.buyer_name ?? 'Unknown'}`,
      `Deliver to: ${cart.delivery_address ?? 'not given'}`,
      '',
      escrow
        ? "The payment is held until the buyer confirms each item arrived, then it's released to you."
        : 'Your payout is on its way.',
    ];
    if (lost.length) {
      lines.push('', `${lost.map((d) => d.title).join(', ')} had already sold, so Vendwyze is refunding the buyer in full for ${lost.length === 1 ? 'it' : 'them'}. Nothing for you to do.`);
    }
    await say(cfg, tenant, owner, lines.join('\n'));
  }
}

// For the page Paystack returns the buyer to: /order/<cart ref>.
export async function cartView(cfg, ref) {
  const cart = await db(cfg).one('carts', `payment_ref=eq.${ref}&select=${COLUMNS.cart}`);
  if (!cart) return null;
  const [orders, tenant] = await Promise.all([
    db(cfg).select('orders', `cart_id=eq.${cart.id}&select=order_code,amount,status,escrow_status,product_id&order=payment_ref.asc`),
    db(cfg).one('tenants', `id=eq.${cart.tenant_id}&select=name,slug,whatsapp_number`),
  ]);
  const items = [];
  for (const o of orders) {
    const p = await db(cfg).one('products', `id=eq.${o.product_id}&select=title,images,public_code`);
    items.push({ order_code: o.order_code, amount: Number(o.amount), status: o.status, title: p?.title ?? null, images: p?.images ?? [] });
  }
  return {
    cart: true,
    status: cart.status === 'paid' ? 'paid' : 'awaiting_payment',
    amount: Number(cart.amount),
    escrow: orders.some((o) => o.escrow_status === 'held'),
    items,
    store: tenant ? { name: tenant.name, slug: tenant.slug, whatsapp: tenant.whatsapp_number } : null,
  };
}
