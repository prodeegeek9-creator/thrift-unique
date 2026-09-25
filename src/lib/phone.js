// A WhatsApp number the way both the bot and wa.me links need it: digits
// only, country code first. The bot finds a store by matching the sender's
// number against tenants.whatsapp_number exactly, so "+234 803 …" or
// "0803…" stored as typed would never match anything.
//
// No build-time env here, so node:test can import it directly.

export class InputError extends Error {}

export function normalizeWhatsappNumber(raw) {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  // Nigerian local format, which is what most sellers type from memory.
  if (digits.length === 11 && digits.startsWith('0')) digits = `234${digits.slice(1)}`;
  return digits;
}

// E.164: at most 15 digits, and no country code starts with 0.
export function isValidWhatsappNumber(digits) {
  return /^[1-9]\d{9,14}$/.test(String(digits ?? ''));
}

// What gets saved, or an InputError worded for the seller. `botNumber` is the
// platform's own number: a store registered under it could never be
// recognised, because WhatsApp marks messages from that account as the bot's
// own and the Worker ignores those on purpose.
export function checkedWhatsappNumber(raw, botNumber) {
  const number = normalizeWhatsappNumber(raw);
  if (number === null) return null;

  if (!isValidWhatsappNumber(number)) {
    throw new InputError(
      'That WhatsApp number does not look right. Use digits with the country code, like 2348012345678.'
    );
  }
  if (botNumber && number === normalizeWhatsappNumber(botNumber)) {
    throw new InputError(
      "That's the platform bot's number. Use the WhatsApp number you'll message the bot from."
    );
  }
  return number;
}
