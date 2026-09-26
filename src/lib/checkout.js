import { callWorker } from './api.js';

// Buying, from the browser. Everything here is public except making a payment
// link: a buyer has no account, and the Worker decides what they may pay for.

async function publicCall(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(payload.error ?? `Request failed (${res.status})`);
    err.status = res.status;
    // sold, held, held_minutes: what a page needs to show instead of an error.
    err.body = payload;
    throw err;
  }
  return payload;
}

// Whether online payment is set up. Until it is, pages offer WhatsApp only.
export async function checkoutEnabled() {
  try {
    return (await publicCall('/api/checkout/enabled')).enabled === true;
  } catch {
    return false;
  }
}

// { code } for a product page, or { token } for a payment link, plus the
// buyer's details. Returns Paystack's checkout URL to send them to.
export const startCheckout = (body) => publicCall('/api/checkout', { method: 'POST', body });

export const fetchPaymentLink = (token) => publicCall(`/api/checkout/link/${token}`);

export const fetchOrderByReference = (reference) => publicCall(`/api/checkout/${reference}`);

// For the store: a link at a price agreed in chat, that only the buyer on
// `phone` can pay (worker/lib/paylinks.js).
export const createPaymentLink = (tenantId, id, price, phone) =>
  callWorker('/api/listings/payment-link', { body: { tenant: tenantId, id, price, phone } });
