// A small, deliberately closed icon set: 24×24, 1.6px stroke, round caps —
// matching the line weight in the mockups. Closed because a dashboard that
// pulls an icon library ends up shipping 300 glyphs to render eleven, and
// because a named set is a design decision somebody can review.
const PATHS = {
  overview: 'M4 13h6V4H4v9Zm0 7h6v-5H4v5Zm10 0h6v-9h-6v9Zm0-16v5h6V4h-6Z',
  listings: 'M4 7h16M4 12h16M4 17h10',
  inbox: 'M4 13h4.5l1.5 3h4l1.5-3H20M5.5 5h13L20 13v6H4v-6l1.5-8Z',
  orders: 'M6 2h12l2 6H4l2-6Zm-2 6v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M9 12h6',
  payouts: 'M3 7h18v12H3V7Zm0 4h18M7 15h3',
  contacts: 'M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM19 11h3m-1.5-1.5v3',
  disputes: 'M12 3 2 20h20L12 3Zm0 6v5m0 3v.5',
  analytics: 'M4 20V10m5 10V4m5 16v-7m5 7V8',
  team: 'M15 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M8.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM17 4.5a3.5 3.5 0 0 1 0 7M22 19v-1a4 4 0 0 0-3-3.87',
  billing: 'M3 7h18v12H3V7Zm3-4h12v4H6V3Zm10 12h2',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8.4-3a8.4 8.4 0 0 0-.1-1.3l2-1.5-2-3.4-2.3 1a8.3 8.3 0 0 0-2.3-1.3L15.3 2h-4l-.4 2.5a8.3 8.3 0 0 0-2.3 1.3l-2.3-1-2 3.4 2 1.5a8.4 8.4 0 0 0 0 2.6l-2 1.5 2 3.4 2.3-1a8.3 8.3 0 0 0 2.3 1.3l.4 2.5h4l.4-2.5a8.3 8.3 0 0 0 2.3-1.3l2.3 1 2-3.4-2-1.5c.07-.43.1-.86.1-1.3Z',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-2-11a2 2 0 1 1 3 1.7c-.6.4-1 .8-1 1.6M12 17v.5',
  more: 'M5 12h.5M12 12h.5M19 12h.5',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 5 5',
  bell: 'M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6ZM10.5 20a1.8 1.8 0 0 0 3 0',
  chevron: 'm7 10 5 5 5-5',
  back: 'M15 6l-6 6 6 6',
  lock: 'M6 11h12v9H6v-9Zm3 0V7.5a3 3 0 1 1 6 0V11',
  check: 'm5 13 4 4L19 7',
  whatsapp: 'M12 3a9 9 0 0 0-7.7 13.6L3 21l4.5-1.2A9 9 0 1 0 12 3Zm4.2 12.1c-.2.5-1 1-1.5 1-.4 0-.9.2-3-.7-2.5-1-4.1-3.6-4.2-3.8-.1-.2-1-1.3-1-2.5s.6-1.7.8-2c.2-.2.5-.3.6-.3h.5c.2 0 .4 0 .5.4l.7 1.7c.1.2 0 .4 0 .5l-.4.5c-.1.2-.3.3-.1.6.1.3.6 1.1 1.4 1.8 1 .9 1.8 1.1 2 1.2.3.1.4.1.6-.1l.7-.8c.2-.2.4-.2.6-.1l1.6.8c.2.1.4.2.4.3v.5Z',
  instagram: 'M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4Zm5 5.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM17.5 6.5v.5',
  facebook: 'M14 8.5V7a1.5 1.5 0 0 1 1.5-1.5H17V3h-2.5A4 4 0 0 0 10.5 7v1.5H8V11h2.5v10H14V11h2.5l.5-2.5H14Z',
  tiktok: 'M15 3v10.5a3.5 3.5 0 1 1-3-3.46M15 3c0 2.2 1.8 4 4 4M15 3h.5',
};

export default function Icon({ name, className = 'h-5 w-5', filled = false }) {
  const d = PATHS[name];
  if (!d) return null;

  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}
