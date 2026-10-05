// Paystack: verifying what it sends, and calling what it offers.

const enc = new TextEncoder();

// Paystack signs the webhook body with your SECRET KEY — there is no separate
// webhook secret, whatever the dashboard's wording implies. HMAC SHA512, hex,
// in `x-paystack-signature`.
//
// The RAW body must be hashed. Parsing the JSON and re-serialising it changes
// key order and whitespace and the signature stops matching, which is the
// classic way this check gets quietly disabled for being "broken".
export async function verifyWebhook(secretKey, rawBody, signature) {
  if (!signature || typeof signature !== 'string') return false;

  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secretKey),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign']
  );

  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  const expected = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return timingSafeEqual(expected, signature.trim().toLowerCase());
}

// Constant time in the length-equal case, which is the one that matters: a
// byte-by-byte `===` returns early on the first wrong character and leaks how
// much of a forged signature was right.
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Re-reading the transaction from Paystack rather than trusting the webhook
// body's amount.
//
// The signature proves the body came from Paystack, so this is belt and
// braces — but it is cheap, it runs once per payment, and it closes the gap
// where a replayed-but-valid older event carries a stale amount.
export async function fetchTransaction(secretKey, reference) {
  const res = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    { headers: { Authorization: `Bearer ${secretKey}` } }
  );

  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  return body?.status ? body.data : null;
}

// Starting a payment. Paystack hands back a checkout page to send the buyer
// to; the payment itself is confirmed later, by webhook, against `reference`.
export async function initializeTransaction(secretKey, { email, amountKobo, reference, callbackUrl, metadata }) {
  const res = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      amount: amountKobo,
      reference,
      currency: 'NGN',
      callback_url: callbackUrl,
      metadata,
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.status || !body?.data?.authorization_url) {
    throw new Error(`Paystack initialize ${res.status}: ${body?.message ?? 'no checkout URL'}`);
  }
  return body.data;
}
