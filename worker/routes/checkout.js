import { config, require_, originOf } from '../lib/env.js';
import { db } from '../lib/supabase.js';
import { json } from '../lib/http.js';
import { verify } from '../lib/sign.js';
import { initializeTransaction, fetchTransaction } from '../lib/paystack.js';
import { koboToNaira, nairaToKobo } from '../lib/money.js';
import { markPaid, byPaymentRef } from '../lib/orders.js';
import { normalizeNumber } from '../lib/phone.js';
import { chatId } from '../lib/waha.js';
import { formatNaira } from '../lib/bot.js';
import { confirmToken } from './confirm.js';
import { say } from './waha.js';
import { soldConsignorMessage } from '../lib/intake.js';

// Buying on the platform.
//
//   GET  /api/checkout/enabled        whether online payment is set up at all
//   GET  /api/checkout/link/:token    a store's payment link, for its page
//   POST /api/checkout                start paying: creates the order, returns
//                                     Paystack's checkout page
//   GET  /api/checkout/:reference     the order, for the page the buyer lands
//                                     on after paying
//
// Every payment goes through the platform: that is what makes commission
// collectable and escrow possible. An order is created here, before any money
// moves, so the webhook that later confirms the payment has a decision to
// match rather than a payload to trust.

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export async function handleCheckout(request, env, path) {
  const rest = path.slice('/api/checkout'.length) || '/';
  const method = request.method;

  if (rest === '/enabled' && method === 'GET') {
    const cfg = config(env);
    return json({ enabled: Boolean(cfg.paystackKey && cfg.tokenSecret && cfg.supabaseUrl) });
  }

  const link = rest.match(/^\/link\/([A-Za-z0-9_.-]+)$/);
  if (link && method === 'GET') return readLink(env, link[1]);

  if (rest === '/' && method === 'POST') return start(request, env);

  const ref = rest.match(/^\/(utp_[A-Za-z0-9]{8,40})$/);
  if (ref && method === 'GET') return orderStatus(request, env, ref[1]);

  return json({ error: 'Not found' }, 404);
}

// ── PAYMENT LINKS ────────────────────────────────────────────────────────────

async function readLink(env, token) {
  const cfg = require_(env, 'supabaseUrl', 'serviceKey', 'tokenSecret');
  const claims = await verify(cfg.tokenSecret, token);
  if (!claims || claims.k !== 'pay') return json({ error: 'This payment link has expired or is not valid.' }, 410);

  const found = await buyable(cfg, { id: claims.p });
  if (found.error) return json({ error: found.error }, found.status);
  return json({ ...publicView(found), price: claims.a });
}

// ── STARTING A PAYMENT ───────────────────────────────────────────────────────

async function start(request, env) {
  const cfg = require_(env, 'supabaseUrl', 'serviceKey');
  if (!cfg.paystackKey || !cfg.tokenSecret) {
    return json({ error: "Online payment isn't set up yet. Message the store on WhatsApp to buy." }, 503);
  }
  cfg.publicOrigin = originOf(request, cfg);

  const body = await request.json().catch(() => ({}));

  // Which item, and at what price: the listed price for a product page, or
  // the agreed price a payment link carries.
  let price;
  let found;
  let source = 'direct';
  if (body.token) {
    const claims = await verify(cfg.tokenSecret, String(body.token));
    if (!claims || claims.k !== 'pay') return json({ error: 'This payment link has expired or is not valid.' }, 410);
    found = await buyable(cfg, { id: claims.p });
    price = Number(claims.a);
    source = 'whatsapp';
  } else {
    found = await buyable(cfg, { code: String(body.code ?? '') });
    price = Number(found.product?.price);
  }
  if (found.error) return json({ error: found.error }, found.status);
  const { product, tenant } = found;

  const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
  const phone = normalizeNumber(body.phone);
  const address = String(body.address ?? '').trim().replace(/\s+/g, ' ');
  const note = String(body.note ?? '').trim().slice(0, 300) || null;
  const email = String(body.email ?? '').trim().toLowerCase();

  if (name.length < 2 || name.length > 80) return json({ error: 'Enter your name.' }, 400);
  if (!phone) return json({ error: 'Enter a WhatsApp number we can reach you on, e.g. 08031234567.' }, 400);
  if (address.length < 5 || address.length > 300) return json({ error: 'Enter the delivery address.' }, 400);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "That email doesn't look right." }, 400);
  if (!Number.isFinite(price) || price <= 0) return json({ error: 'This item has no price.' }, 409);

  const buyer = await db(cfg).insert(
    'buyers',
    { tenant_id: tenant.id, phone, name },
    { onConflict: 'tenant_id,phone', merge: true }
  );
  if (!buyer?.id) throw new Error('buyer upsert returned no row');

  const reference = `utp_${random(20, 'abcdefghijkmnpqrstuvwxyz23456789')}`;
  let order = null;
  for (let i = 0; i < 4 && !order; i += 1) {
    order = await db(cfg).insert(
      'orders',
      {
        tenant_id: tenant.id,
        order_code: `UT-${random(6)}`,
        product_id: product.id,
        buyer_id: buyer.id,
        quantity: 1,
        amount: price,
        commission: 0,
        status: 'awaiting_payment',
        escrow_status: 'none',
        payment_ref: reference,
        source_channel: source,
        delivery_address: address,
        buyer_note: note,
      },
      // A clashing order code (1 in a billion) is retried with another.
      { onConflict: 'order_code' }
    );
  }
  if (!order) throw new Error('could not allocate an order code');

  let checkout;
  try {
    checkout = await initializeTransaction(cfg.paystackKey, {
      // Paystack insists on an email. Most buyers here have only a phone, so
      // one is made up from it when none is given: Paystack's receipt simply
      // goes nowhere, and ours goes to WhatsApp.
      email: email || `buyer-${phone}@${new URL(cfg.publicOrigin ?? 'https://uniquethrift.ng').hostname}`,
      amountKobo: nairaToKobo(price),
      reference,
      callbackUrl: `${cfg.publicOrigin ?? ''}/order/${reference}`,
      metadata: {
        order_code: order.order_code,
        tenant: tenant.slug,
        product: product.public_code,
        source_channel: source,
      },
    });
  } catch (err) {
    console.error('checkout: paystack initialize failed:', err?.message ?? err);
    await db(cfg)
      .update('orders', `id=eq.${order.id}&status=eq.awaiting_payment`, { status: 'cancelled' }, { returning: false })
      .catch(() => {});
    return json({ error: "Couldn't start the payment. Try again in a minute." }, 502);
  }

  return json({ ok: true, url: checkout.authorization_url, reference, order_code: order.order_code });
}

// The item, if it can be bought right now: live, in a live store, not sold.
async function buyable(cfg, { id, code }) {
  const filter = id ? `id=eq.${id}` : `public_code=eq.${encodeURIComponent(code.toUpperCase())}`;
  const product = await db(cfg).one(
    'products',
    `${filter}&select=id,tenant_id,public_code,title,price,condition,images,status`
  );
  if (!product) return { error: 'That item no longer exists.', status: 404 };
  if (product.status !== 'active') return { error: 'Sorry, this item has sold.', status: 409 };

  const tenant = await db(cfg).one(
    'tenants',
    `id=eq.${product.tenant_id}&select=id,slug,name,status,whatsapp_number,waha_session,waha_status`
  );
  if (!tenant || tenant.status !== 'active') return { error: "This store isn't taking orders right now.", status: 409 };
  return { product, tenant };
}

function publicView({ product, tenant }) {
  return {
    public_code: product.public_code,
    title: product.title,
    price: Number(product.price),
    condition: product.condition,
    images: product.images ?? [],
    store: { name: tenant.name, slug: tenant.slug, whatsapp: tenant.whatsapp_number },
  };
}

// ── AFTER PAYING ─────────────────────────────────────────────────────────────

// The page Paystack returns the buyer to. If the webhook has not landed yet,
// Paystack is asked directly, so a buyer is not left looking at "waiting"
// because a webhook is slow; settle() makes the two paths meet exactly once.
async function orderStatus(request, env, reference) {
  const cfg = require_(env, 'supabaseUrl', 'serviceKey');
  cfg.publicOrigin = originOf(request, cfg);

  let order = await byPaymentRef(cfg, reference);
  if (!order) return json({ error: 'No such order.' }, 404);

  if (order.status === 'awaiting_payment' && cfg.paystackKey) {
    const verified = await fetchTransaction(cfg.paystackKey, reference).catch(() => null);
    if (verified?.status === 'success') {
      const settled = await settle(cfg, order, { kobo: verified.amount, channel: null });
      order = settled.order ?? order;
    }
  }

  const [product, tenant] = await Promise.all([
    db(cfg).one('products', `id=eq.${order.product_id}&select=title,images,public_code`),
    db(cfg).one('tenants', `id=eq.${order.tenant_id}&select=name,slug,whatsapp_number`),
  ]);

  return json({
    order_code: order.order_code,
    status: order.status,
    escrow: order.escrow_status === 'held',
    amount: Number(order.amount),
    product: product ?? null,
    store: tenant ? { name: tenant.name, slug: tenant.slug, whatsapp: tenant.whatsapp_number } : null,
  });
}

// A payment Paystack says succeeded, applied to its order: mark it paid (and
// owe the seller, via markPaid), take the item off sale, and tell both sides.
// Shared by the webhook and the return page; markPaid only matches an order
// still awaiting payment, so whichever arrives second does nothing.
export async function settle(cfg, order, { kobo, channel }) {
  let amountNaira;
  try {
    amountNaira = koboToNaira(kobo);
  } catch (err) {
    console.error('paystack: bad amount', kobo, err.message);
    return { order, replayed: true, ignored: 'bad amount' };
  }

  const tenant = await db(cfg).one(
    'tenants',
    `id=eq.${order.tenant_id}&select=id,slug,name,commission_pct,whatsapp_number,waha_session,waha_status`
  );
  if (!tenant) {
    console.error('paystack: order has no tenant', order.id);
    return { order, replayed: true, ignored: 'no tenant' };
  }

  const result = await markPaid(cfg, order, tenant, {
    amountNaira,
    reference: order.payment_ref,
    channel: channel ?? order.source_channel,
  });
  if (!result.replayed) await afterPayment(cfg, result.order, tenant).catch((err) => {
    // The money is recorded; a failed notice is not worth failing the webhook.
    console.error('after-payment notices failed:', err?.message ?? err);
  });
  return result;
}

async function afterPayment(cfg, order, tenant) {
  // Off sale. Only an item still listed matches: a second buyer who paid for
  // something already sold is the store's to refund, and it is told so below.
  const sold = await db(cfg).update(
    'products',
    `id=eq.${order.product_id}&tenant_id=eq.${tenant.id}&status=eq.active`,
    { status: 'sold', sold_at: new Date().toISOString(), quantity_available: 0 }
  );
  const doubleSale = sold.length === 0;

  const [product, buyer, account] = await Promise.all([
    db(cfg).one('products', `id=eq.${order.product_id}&select=title,public_code`),
    db(cfg).one('buyers', `id=eq.${order.buyer_id}&select=name,phone`),
    db(cfg).one('payout_accounts', `tenant_id=eq.${tenant.id}&select=bank_name,account_last4`),
  ]);
  const title = product?.title ?? 'your item';
  const amount = formatNaira(order.amount);
  const escrow = order.escrow_status === 'held';

  // The store, on the platform number, where the owner already talks to us.
  const owner = chatId(tenant.whatsapp_number);
  if (owner) {
    const lines = [
      `💰 *New order ${order.order_code}* — paid`,
      '',
      `*${title}* · ${amount}`,
      `Buyer: ${buyer?.name ?? 'Unknown'}${buyer?.phone ? ` (+${buyer.phone})` : ''}`,
      `Deliver to: ${order.delivery_address ?? 'not given'}`,
    ];
    if (order.buyer_note) lines.push(`Note: ${order.buyer_note}`);
    lines.push(
      '',
      escrow
        ? "The payment is held until the buyer confirms it arrived, then it's released to you."
        : account
          ? `Your payout is on its way to your ${account.bank_name} account ending ${account.account_last4}.`
          : `Add your bank account under Payouts in your dashboard to receive it: ${cfg.publicOrigin ?? ''}/dashboard/payouts`
    );
    if (doubleSale) {
      lines.push('', '⚠️ This item was already sold to someone else. Contact the buyer to arrange a refund or a swap.');
    }
    await say(cfg, tenant, owner, lines.join('\n'));
  }

  // The consignor, if a person brought the store this item: it sold, and the
  // store owes them their asking price. From the store's own number, where
  // they offered it.
  const brought = await db(cfg).one(
    'submissions',
    `product_id=eq.${order.product_id}&tenant_id=eq.${tenant.id}&select=seller_chat_id,title,asking_price,owed_amount`
  );
  if (brought?.seller_chat_id && !doubleSale && tenant.waha_session && tenant.waha_status === 'WORKING') {
    await say(
      cfg,
      tenant,
      brought.seller_chat_id,
      soldConsignorMessage({ store: tenant.name, title: brought.title, owed: brought.owed_amount ?? brought.asking_price }),
      { session: tenant.waha_session }
    );
  }

  // The buyer, from the store's own number when it is linked — that is who
  // they bought from — or the platform's.
  const to = chatId(buyer?.phone);
  if (to) {
    const lines = [
      `✅ Payment received — thank you${buyer?.name ? `, ${buyer.name.split(' ')[0]}` : ''}!`,
      '',
      `*${title}* from ${tenant.name}`,
      `${amount} · Order ${order.order_code}`,
      '',
      `${tenant.name} will contact you about delivery.`,
    ];
    if (escrow && cfg.tokenSecret) {
      const token = await confirmToken(cfg, order);
      lines.push(
        '',
        'Your payment is protected: the store is only paid once you confirm the item arrived. When it does, tap here:',
        `${cfg.publicOrigin ?? ''}/confirm/${token}`
      );
    }
    const own = tenant.waha_session && tenant.waha_status === 'WORKING' ? { session: tenant.waha_session } : {};
    await say(cfg, tenant, to, lines.join('\n'), own);
  }
}

function random(length, alphabet = CODE_ALPHABET) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
