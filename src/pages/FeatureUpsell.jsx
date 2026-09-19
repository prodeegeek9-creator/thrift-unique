import { Link } from 'react-router-dom';
import Icon from '../components/ui/Icon.jsx';
import TierBadge from '../components/ui/TierBadge.jsx';
import { minTierFor } from '../lib/features.js';

// What a locked route renders instead of redirecting.
//
// One page rather than one per feature, because the shape is always the same:
// name the thing, say what it does in the seller's own terms, say which plan
// carries it. The copy below is the part worth arguing about — it is the only
// pitch most Starter sellers will ever read, and "Upgrade to unlock" is not a
// pitch.
const COPY = {
  contacts: {
    title: 'Know who keeps buying from you',
    body: 'Every buyer who pays through your store, in one list — what they bought, what they spent, and who has come back more than once. Message your repeat buyers first when new stock lands.',
  },
  disputes: {
    title: 'Buyer protection, handled for you',
    body: "When a buyer says an item never arrived or isn't what they expected, it comes here instead of to your personal chat. We hold the money until it's sorted, and our team handles the back-and-forth.",
  },
  escrow: {
    title: "Get paid without the 'send it first' argument",
    body: 'Buyers pay upfront into escrow. You ship, they confirm, the money lands in your account minus commission. Neither side has to trust the other first.',
  },
  publish_instagram: {
    title: 'Post to your own Instagram automatically',
    body: 'List an item on WhatsApp and it goes to your Instagram Business account the same minute — your account, your followers, your captions. Not a platform page nobody follows.',
  },
  publish_facebook: {
    title: 'Post to your own Facebook Page automatically',
    body: 'Same listing, posted to your Page as you, the moment you send it to the bot. Nothing to copy, paste or re-upload.',
  },
  analytics: {
    title: 'See which channel actually sells',
    body: 'Sales over time, average order value, and a breakdown of which channel the money came from — WhatsApp, Instagram, Facebook or TikTok. Stop guessing which posting is worth the effort.',
  },
  team: {
    title: 'Let your staff help without handing over everything',
    body: 'Add managers and staff with their own logins. A manager handles listings, orders and customers; staff can list items and nothing else. Your payouts and bank details stay yours.',
  },
  publish_tiktok: {
    title: 'Reach TikTok too',
    body: 'Listings posted straight to your TikTok business account alongside everything else. Available on Business.',
  },
  catalog_sync: {
    title: 'Sync an existing catalogue',
    body: 'Already running a WooCommerce store? Keep both in step instead of listing everything twice.',
  },
  ai_match: {
    title: 'Answer "is this still in stock?" instantly',
    body: 'A buyer sends a photo, and we match it against your listings automatically — no scrolling back through your own catalogue to find it.',
  },
  priority_support: {
    title: 'Support that answers first',
    body: 'A dedicated support line for your store, with your questions escalated ahead of the queue.',
  },
};

const TIER_NAME = { growth: 'Growth', business: 'Business' };

export default function FeatureUpsell({ flag, title, body }) {
  const copy = COPY[flag] ?? {};
  const heading = title ?? copy.title ?? 'Not included on your plan';
  const text =
    body ??
    copy.body ??
    'This feature is part of a higher plan. Take a look at what else comes with it.';

  const min = flag ? minTierFor(flag) : null;

  return (
    <div className="mx-auto max-w-xl py-8">
      <div className="card overflow-hidden">
        <div className="bg-sidebar px-6 py-8 text-center">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-white/10">
            <Icon name="lock" className="h-6 w-6 text-gold" />
          </span>
          <h1 className="mt-4 font-display text-xl font-semibold text-white">
            {heading}
          </h1>
          {min ? (
            <p className="mt-2 text-sm text-white/60">
              Included on {TIER_NAME[min] ?? min}
            </p>
          ) : null}
        </div>

        <div className="px-6 py-6 text-center">
          <p className="text-sm leading-relaxed text-text">{text}</p>

          {min ? (
            <>
              <div className="mt-5 flex items-center justify-center gap-2">
                <span className="text-xs text-muted">Unlocks with</span>
                <TierBadge flag={flag} />
              </div>
              <Link
                to="/dashboard/billing"
                className="mt-5 inline-block rounded-pill bg-green px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90"
              >
                See {TIER_NAME[min] ?? min} plan
              </Link>
              <p className="mt-3">
                <Link to="/dashboard" className="text-xs text-muted hover:text-ink">
                  Not now
                </Link>
              </p>
            </>
          ) : (
            <Link
              to="/dashboard"
              className="mt-5 inline-block rounded-pill bg-sidebar px-5 py-2.5 text-sm font-semibold text-white"
            >
              Back to Overview
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
