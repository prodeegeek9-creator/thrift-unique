import { sign } from './sign.js';

// A price a store agreed with a buyer in chat, for one item, signed so the
// buyer cannot edit it. Made by the dashboard (routes/listings.js) and by the
// bot's LINK command; paid through routes/checkout.js.

// How long a payment link stays payable.
export const LINK_TTL_SECONDS = 3 * 24 * 3600;

export async function makePaymentLink(cfg, product, price) {
  const token = await sign(cfg.tokenSecret, { k: 'pay', p: product.id, a: price }, LINK_TTL_SECONDS);
  return `${cfg.publicOrigin ?? ''}/pay/${token}`;
}
