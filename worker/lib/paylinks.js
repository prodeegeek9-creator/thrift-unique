import { sign } from './sign.js';
import { normalizeNumber } from './phone.js';

// A price a store agreed with a buyer in chat, for one item, signed so the
// buyer cannot edit it. Made by the dashboard (routes/listings.js) and by the
// bot's LINK command; paid through routes/checkout.js.
//
// For one buyer only. The link carries a fingerprint of the buyer's WhatsApp
// number, and checkout refuses any other number, so a discount agreed with
// one person can't be forwarded and paid by another. A fingerprint rather than
// the number because a link's claims are readable by whoever has it: an HMAC
// under the token secret, which can't be reversed by trying every number the
// way a plain hash could. The last four digits are kept to show on the page,
// so the right buyer can see it's theirs.

// How long a payment link stays payable.
export const LINK_TTL_SECONDS = 3 * 24 * 3600;

export async function makePaymentLink(cfg, product, price, { phone }) {
  const number = normalizeNumber(phone);
  if (!number) throw new Error('A payment link needs the buyer’s number');
  const token = await sign(
    cfg.tokenSecret,
    { k: 'pay', p: product.id, a: price, b: await buyerKey(cfg, number), l: number.slice(-4) },
    LINK_TTL_SECONDS
  );
  return `${cfg.publicOrigin ?? ''}/pay/${token}`;
}

// Whether this number may pay the link. A link made before links named their
// buyer (no b claim) is anybody's, until it expires.
export async function linkIsFor(cfg, claims, phone) {
  if (!claims?.b) return true;
  const number = normalizeNumber(phone);
  return Boolean(number) && (await buyerKey(cfg, number)) === claims.b;
}

async function buyerKey(cfg, number) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(cfg.tokenSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`paylink-buyer:${number}`));
  return [...new Uint8Array(mac)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}
