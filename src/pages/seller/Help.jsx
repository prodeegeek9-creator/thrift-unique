import PageHeader from '../../components/ui/PageHeader.jsx';
import Icon from '../../components/ui/Icon.jsx';
import { useTenant } from '../../lib/TenantContext.jsx';
import { supportDeepLink, botConfigured } from '../../lib/whatsapp.js';

export default function Help() {
  const { tenant, can } = useTenant();
  const link = supportDeepLink(tenant);
  const priority = can('priority_support');

  return (
    <>
      <PageHeader title="Help" subtitle="Talk to us where you already are." />

      <div className="grid max-w-3xl gap-4 md:grid-cols-2">
        <section className="card p-5">
          <span className="grid h-10 w-10 place-items-center rounded-lg bg-green-lt text-green">
            <Icon name="whatsapp" className="h-5 w-5" />
          </span>
          <h2 className="mt-3 font-display text-base font-semibold text-ink">
            {priority ? 'Your dedicated support line' : 'Message us on WhatsApp'}
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            {priority
              ? 'Business stores go to the front of the queue. Send us a message and we will pick it up.'
              : 'The same number you list on. Ask us anything about your store, an order or a payout.'}
          </p>

          {link ? (
            <a
              href={link}
              className="mt-4 inline-flex items-center gap-2 rounded-pill bg-green px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
            >
              <Icon name="whatsapp" className="h-4 w-4" />
              Open WhatsApp
            </a>
          ) : (
            <p className="mt-4 text-xs text-muted">
              Support is not configured on this deployment yet.
            </p>
          )}
        </section>

        <section className="card p-5">
          <h2 className="font-display text-base font-semibold text-ink">Common questions</h2>
          <dl className="mt-3 space-y-3 text-sm">
            <Faq
              q="How do I add a product?"
              a={
                botConfigured()
                  ? 'Send us the photos, the name, the price and the condition on WhatsApp. We build the listing and post it for you.'
                  : 'Use the Add Product button on your Listings screen.'
              }
            />
            <Faq
              q="When do I get paid?"
              a={
                can('escrow')
                  ? 'Buyers pay upfront and we hold it until they confirm the item arrived. If they go quiet, it releases to you automatically.'
                  : 'Buyers pay through us and you are paid the same day, minus commission.'
              }
            />
            <Faq
              q="Why is my Instagram not posting?"
              a="Instagram needs a Business or Creator account linked to a Facebook Page. Personal accounts cannot be posted to. Check the Channels screen."
            />
          </dl>
        </section>
      </div>
    </>
  );
}

function Faq({ q, a }) {
  return (
    <div>
      <dt className="font-medium text-ink">{q}</dt>
      <dd className="mt-0.5 leading-relaxed text-muted">{a}</dd>
    </div>
  );
}
