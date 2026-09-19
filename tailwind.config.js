/** @type {import('tailwindcss').Config} */

// Every colour resolves to a CSS variable rather than a literal, and
// src/index.css supplies the values. The indirection is what lets a theme —
// or a tenant's own branding, which is the reason it matters here — re-point a
// token without touching the components that use it.
//
// Channel triplets (`250 248 245`) rather than hex keep Tailwind's
// slash-opacity syntax alive: `bg-green/10` still compiles, because the value
// is spliced into rgb() with <alpha-value> in the alpha slot. The tokens that
// are themselves translucent (line, overlay) are written as whole colours,
// since an alpha they already carry cannot also be parameterised.
//
// Only one theme is defined. The mockups are light-only, and inventing a dark
// palette nobody designed is worse than not having one — see the README.
const channel = (name) => `rgb(var(${name}) / <alpha-value>)`;

export default {
  content: ['./app.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      // One breakpoint below Tailwind's smallest. sm is 640px, which is a
      // large phone in landscape; it says nothing about whether the two stat
      // tiles on the mobile home screen fit side by side at 360px.
      screens: {
        xs: '400px',
      },
      colors: {
        // Surfaces. The page is cream, cards are white — carried over from the
        // live site, which already ships this palette.
        bg: channel('--c-bg'),
        surface: channel('--c-surface'),
        'surface-2': channel('--c-surface-2'),
        line: 'var(--c-line)',
        overlay: 'var(--c-overlay)',

        // The sidebar and the dark hero cards. This is the one real departure
        // from the live site, which uses a dark brown (#2C1810) for its nav —
        // the dashboard mockups are a dark forest green throughout.
        sidebar: channel('--c-sidebar'),
        'sidebar-2': channel('--c-sidebar-2'),
        'sidebar-text': channel('--c-sidebar-text'),

        // The active nav pill: a warm gold, not the amber used for order
        // status. Two different signals, two different tokens, however close
        // they look at a glance.
        gold: channel('--c-gold'),

        ink: channel('--c-ink'),
        text: channel('--c-text'),
        muted: channel('--c-muted'),

        // Status. green = active/paid/released, amber = processing/under
        // review, red = open dispute. The whole status system is these three
        // plus their tint, and StatusPill is the only component that should
        // be choosing between them.
        green: channel('--c-green'),
        'green-lt': channel('--c-green-lt'),
        amber: channel('--c-amber'),
        'amber-lt': channel('--c-amber-lt'),
        red: channel('--c-red'),
        'red-lt': channel('--c-red-lt'),

        // Chart series. A separate ramp from status — see index.css for why,
        // and for the validation numbers.
        'series-whatsapp': channel('--c-series-whatsapp'),
        'series-instagram': channel('--c-series-instagram'),
        'series-facebook': channel('--c-series-facebook'),
        'series-tiktok': channel('--c-series-tiktok'),
        'series-direct': channel('--c-series-direct'),

        // Tier badges. Distinct from status on purpose: "Growth+" next to a
        // locked nav item must not read as "this succeeded".
        'tier-growth': channel('--c-tier-growth'),
        'tier-growth-lt': channel('--c-tier-growth-lt'),
        'tier-business': channel('--c-tier-business'),
        'tier-business-lt': channel('--c-tier-business-lt'),
      },
      fontFamily: {
        // Fraunces is the wordmark and the page headings; Inter is everything
        // else. Both are already loaded by the live site.
        display: ['Fraunces', 'Georgia', 'serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        card: '12px',
        pill: '999px',
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        pop: 'var(--shadow-pop)',
      },
      keyframes: {
        'toast-in': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
      },
      animation: {
        'toast-in': 'toast-in 180ms ease-out',
        'fade-in': 'fade-in 300ms ease-out',
      },
    },
  },
  plugins: [],
};
