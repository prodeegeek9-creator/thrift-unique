import { Link, Navigate } from 'react-router-dom';
import { BrandLockup } from '../../components/ui/BrandMark.jsx';
import Icon from '../../components/ui/Icon.jsx';
import { useAuth } from '../../lib/AuthContext.jsx';
import { botNumberDisplay, setupDeepLink } from '../../lib/whatsapp.js';

// The front door: Vendwyze's own homepage.
//
// Businesses open a store by messaging the platform's WhatsApp number, so the
// whole page leads to that one button, with the number printed beside it for
// anybody who would rather save it. Each store's own page is /s/<name>; this
// one is about the platform, not about any store.
//
// Plans and commission match the sign-up conversation (COMMISSION and the plan
// copy in worker/lib/bot.js). Change them together.

const PLANS = [
  {
    name: 'Starter',
    price: '₦10,000',
    commission: '8% per sale',
    points: ['List items on WhatsApp or the dashboard', 'Auto-posts to your WhatsApp Status', 'Your own store page', 'Paid out the same day'],
  },
  {
    name: 'Growth',
    price: '₦25,000',
    commission: '7% per sale',
    featured: true,
    points: ['Everything in Starter', 'Instagram & Facebook posting', 'Buyer protection (escrow)', 'Checkout inside WhatsApp', 'Customer list & disputes'],
  },
  {
    name: 'Business',
    price: '₦75,000',
    commission: 'Commission agreed with you',
    points: ['Everything in Growth', 'TikTok posting', 'Staff logins', 'Analytics', 'Dedicated support'],
  },
];

const STEPS = [
  {
    title: 'Message us on WhatsApp',
    body: "Tell us your business name, whether you're a thrift store or a brand, and pick a plan. Takes two minutes.",
  },
  {
    title: 'List your items',
    body: 'Send a photo, name and price to the bot, or add them from your dashboard. People bringing you items to sell message your own number with SELL, and you approve them.',
  },
  {
    title: 'Sell',
    body: 'Items go out to your WhatsApp Status and your own store page. Buyers pay through us, so every payment is protected, and you get paid minus a small commission.',
  },
];

export default function Home() {
  const { user, recovering } = useAuth();
  const open = setupDeepLink();
  const number = botNumberDisplay();

  // Somebody arriving from an invite or password link lands on the set-password
  // screen, whichever page the link pointed at.
  if (user && recovering) return <Navigate to="/dashboard" replace />;

  return (
    <div className="min-h-dvh bg-bg text-text">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
        <BrandLockup tone="dark" />
        <Link
          to={user ? '/dashboard' : '/login'}
          className="rounded-pill border border-line bg-surface px-4 py-2 text-sm font-semibold text-ink hover:bg-surface-2"
        >
          {user ? 'Dashboard' : 'Sign in'}
        </Link>
      </header>

      <main>
        <section className="mx-auto max-w-5xl px-4 pb-14 pt-10 text-center sm:pt-16">
          <h1 className="mx-auto max-w-2xl font-display text-3xl font-semibold leading-tight text-ink sm:text-5xl">
            Run your thrift store or brand from WhatsApp
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-muted sm:text-lg">
            Keep selling the way you already do. We take item details for you, post them to your Status, give
            your store its own web page, and make sure every payment is protected.
          </p>
          <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
            {open ? (
              <a
                href={open}
                className="inline-flex items-center gap-2 rounded-pill bg-green px-6 py-3 text-sm font-semibold text-white hover:opacity-90"
              >
                <Icon name="whatsapp" className="h-5 w-5" />
                Open your store on WhatsApp
              </a>
            ) : null}
            <Link
              to={user ? '/dashboard' : '/login'}
              className="inline-flex items-center rounded-pill border border-line bg-surface px-6 py-3 text-sm font-semibold text-ink hover:bg-surface-2"
            >
              {user ? 'Go to your dashboard' : 'I already have a store'}
            </Link>
          </div>
          {number ? (
            <p className="mt-4 text-sm text-muted">
              Or save our number: <span className="font-semibold text-ink">{number}</span>
            </p>
          ) : null}
        </section>

        <section className="border-y border-line bg-surface py-12">
          <div className="mx-auto max-w-5xl px-4">
            <h2 className="text-center font-display text-2xl font-semibold text-ink">How it works</h2>
            <ol className="mt-8 grid gap-4 sm:grid-cols-3">
              {STEPS.map((step, i) => (
                <li key={step.title} className="rounded-card border border-line bg-bg p-5">
                  <span className="grid h-8 w-8 place-items-center rounded-full bg-green text-sm font-semibold text-white">
                    {i + 1}
                  </span>
                  <h3 className="mt-3 font-display text-base font-semibold text-ink">{step.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-4 py-12">
          <h2 className="text-center font-display text-2xl font-semibold text-ink">For thrift stores and brands</h2>
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            <div className="card p-5">
              <h3 className="font-display text-base font-semibold text-ink">Thrift stores</h3>
              <p className="mt-1 text-sm leading-relaxed text-muted">
                People bring you items to sell for them. Share your “Sell with us” link: they send photos and
                their price to your own WhatsApp, you set your selling price and approve, and it's listed.
              </p>
            </div>
            <div className="card p-5">
              <h3 className="font-display text-base font-semibold text-ink">Brands</h3>
              <p className="mt-1 text-sm leading-relaxed text-muted">
                You sell your own stock. Snap it, send it to the bot, and it's on your Status and your store
                page in a minute, with a link you can drop in any chat or bio.
              </p>
            </div>
          </div>
        </section>

        <section className="border-t border-line bg-surface py-12">
          <div className="mx-auto max-w-5xl px-4">
            <h2 className="text-center font-display text-2xl font-semibold text-ink">Plans</h2>
            <p className="mt-2 text-center text-sm text-muted">
              Free for your first 14 days. Then monthly, plus a commission on each sale paid through us.
            </p>
            <div className="mt-8 grid gap-4 md:grid-cols-3">
              {PLANS.map((plan) => (
                <div
                  key={plan.name}
                  className={`rounded-card border bg-bg p-5 ${plan.featured ? 'border-green' : 'border-line'}`}
                >
                  <div className="flex items-center justify-between">
                    <h3 className="font-display text-lg font-semibold text-ink">{plan.name}</h3>
                    {plan.featured ? (
                      <span className="rounded-pill bg-green-lt px-2 py-0.5 text-[11px] font-semibold text-green">
                        Most popular
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-2 text-xl font-semibold text-ink">
                    {plan.price}
                    <span className="text-sm font-normal text-muted">/mo</span>
                  </p>
                  <p className="text-xs text-muted">{plan.commission}</p>
                  <ul className="mt-4 space-y-2 text-sm text-text">
                    {plan.points.map((p) => (
                      <li key={p} className="flex gap-2">
                        <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-green" />
                        {p}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-4 py-14 text-center">
          <h2 className="font-display text-2xl font-semibold text-ink">Ready to open your store?</h2>
          <p className="mt-2 text-sm text-muted">Say hi on WhatsApp and we'll set you up.</p>
          {open ? (
            <a
              href={open}
              className="mt-5 inline-flex items-center gap-2 rounded-pill bg-green px-6 py-3 text-sm font-semibold text-white hover:opacity-90"
            >
              <Icon name="whatsapp" className="h-5 w-5" />
              {number ? `Message ${number}` : 'Open your store on WhatsApp'}
            </a>
          ) : null}
        </section>
      </main>

      <footer className="border-t border-line py-6 text-center text-xs text-muted">
        © {new Date().getFullYear()} Vendwyze · Payments protected by Vendwyze
      </footer>
    </div>
  );
}
