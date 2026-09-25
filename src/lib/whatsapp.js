// "Add product" is a deep link into the bot, not a form.
//
// The mockups put "Open WhatsApp" as the primary green button and "Add
// manually" as a secondary outline below it, which inverts the usual
// assumption: the conversational flow is the product, and the web form is the
// fallback for when a seller is already at a desk. Every listing surface
// should lead here first.

import { checkedWhatsappNumber } from './phone.js';

const BOT_NUMBER = import.meta.env.VITE_WHATSAPP_NUMBER;

export function botConfigured() {
  return Boolean(BOT_NUMBER);
}

export function checkStoreWhatsapp(raw) {
  return checkedWhatsappNumber(raw, BOT_NUMBER);
}

// For somebody with an account but no store yet: the bot is where a store
// gets set up, so this is the way forward rather than a support ticket.
export function setupDeepLink() {
  if (!BOT_NUMBER) return null;
  return `https://wa.me/${BOT_NUMBER}?text=${encodeURIComponent('Hi! I want to set up my store.')}`;
}

// The bot answers one number for every tenant, so the opening message has to
// say which business is talking. A seller who owns two stores otherwise lists
// a jacket against whichever one the session last saw.
//
// This is a hint, not an authorisation: the Worker resolves the real tenant
// from the sender's WhatsApp number against tenants.whatsapp_number, and a
// tag that disagrees with that lookup loses. It exists so the common case —
// one seller, one number, several stores — lands in the right place without
// an extra round of questions.
export function listingDeepLink(tenant, { prefill } = {}) {
  if (!BOT_NUMBER) return null;

  const lines = ['Hi! I want to list a new item.'];
  if (tenant?.slug) lines.push(`Store: ${tenant.slug}`);
  if (prefill) lines.push(prefill);

  return `https://wa.me/${BOT_NUMBER}?text=${encodeURIComponent(lines.join('\n'))}`;
}

// The support entry point behind the Help nav item. Business tier gets a
// dedicated support bot; everyone else reaches the same number with a subject
// line that routes them.
export function supportDeepLink(tenant) {
  if (!BOT_NUMBER) return null;
  const text = tenant?.slug
    ? `Support request — store: ${tenant.slug}`
    : 'Support request';
  return `https://wa.me/${BOT_NUMBER}?text=${encodeURIComponent(text)}`;
}
