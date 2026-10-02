// The platform's own pages: About, Contact and the three legal documents, and
// the facts they share.
//
// The numbers here (the trial, the escrow window, the grace period) are the
// same as worker/lib/plans.js, which is what the bot quotes and the Worker
// enforces. The homepage's pricing already copies them by hand; these do too.
// Change them together.
//
// The legal pages are a plain-language draft written from what the code does.
// Have them read by a lawyer before live money, and bump LEGAL_UPDATED when
// the wording changes.

import { botNumberDisplay, supportDeepLink } from './whatsapp.js';

export const LEGAL_UPDATED = '2 October 2026';

export const TRIAL_DAYS = 14;
export const CONFIRM_WINDOW_DAYS = 7;
export const GRACE_DAYS = 7;

// Optional, set at build time like the WhatsApp number. Without it the pages
// send people to WhatsApp alone, which is where support happens anyway.
export const SUPPORT_EMAIL = import.meta.env.VITE_SUPPORT_EMAIL || null;

export function supportContact() {
  return {
    whatsapp: supportDeepLink(),
    number: botNumberDisplay(),
    email: SUPPORT_EMAIL,
  };
}

// The footer's link groups, as data. A page is added here once and shows up
// in every footer that carries it.
export const FOOTER_LINKS = [
  {
    title: 'Product',
    links: [
      { label: 'How it works', href: '/#how-it-works' },
      { label: 'Plans', href: '/#plans' },
      { label: 'Open a store', to: '/signup' },
      { label: 'Sign in', to: '/login' },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'About', to: '/about' },
      { label: 'Contact', to: '/contact' },
    ],
  },
  {
    title: 'Legal',
    links: [
      { label: 'Terms of service', to: '/terms' },
      { label: 'Privacy policy', to: '/privacy' },
      { label: 'Refunds & buyer protection', to: '/refunds' },
    ],
  },
];

// The short row under a store or product page: the documents a buyer paying
// on that page may want, without the platform's marketing around them.
export const COMPACT_LINKS = [
  { label: 'Terms', to: '/terms' },
  { label: 'Privacy', to: '/privacy' },
  { label: 'Refunds', to: '/refunds' },
  { label: 'Contact', to: '/contact' },
];
