// HMAC signing, for the links that have to work without a session.
//
// A buyer confirming receipt has no account — there is nobody for an RLS
// policy to identify — so the signature is the only thing between a guessed
// URL and somebody else's money. It therefore carries what it authorises, when
// it expires, and nothing else.

const enc = new TextEncoder();

async function key(secret, usage) {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage]
  );
}

// base64url, because these end up in a URL path.
function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(str) {
  const pad = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// `<payload>.<signature>`, where payload is base64url JSON carrying its own
// expiry. Self-contained on purpose: verifying needs no database round trip,
// so a flood of guessed tokens costs a hash rather than a query.
export async function sign(secret, claims, ttlSeconds) {
  const body = { ...claims, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const payload = b64url(enc.encode(JSON.stringify(body)));
  const sig = await crypto.subtle.sign('HMAC', await key(secret, 'sign'), enc.encode(payload));
  return `${payload}.${b64url(sig)}`;
}

// Returns the claims, or null. Never throws on malformed input — a bad token
// is an ordinary thing to receive, not an exception.
export async function verify(secret, token) {
  if (typeof token !== 'string') return null;

  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;

  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let sigBytes;
  try {
    sigBytes = unb64url(sig);
  } catch {
    return null;
  }

  // crypto.subtle.verify is constant-time, which is the reason to use it here
  // rather than re-signing and comparing strings: a byte-by-byte `===` on a
  // signature leaks how much of a forgery was correct.
  const ok = await crypto.subtle.verify(
    'HMAC',
    await key(secret, 'verify'),
    sigBytes,
    enc.encode(payload)
  );
  if (!ok) return null;

  let claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(unb64url(payload)));
  } catch {
    return null;
  }

  // Expiry is checked after the signature, so an expired token and a forged
  // one take the same path and reveal nothing by timing.
  if (!claims?.exp || claims.exp < Math.floor(Date.now() / 1000)) return null;

  return claims;
}
