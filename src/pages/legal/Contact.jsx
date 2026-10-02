import { Link } from 'react-router-dom';
import InfoPage, { Section } from './InfoPage.jsx';
import Icon from '../../components/ui/Icon.jsx';
import { supportContact } from '../../lib/legal.js';

// Support happens on WhatsApp, the same number the bot answers on: a message
// opening "Support request" is routed to a person (supportDeepLink() in
// lib/whatsapp.js). An email shows only when one is configured.
export default function Contact() {
  const { whatsapp, number, email } = supportContact();

  return (
    <InfoPage
      title="Contact us"
      intro="The quickest way to reach us is WhatsApp. We answer store owners, their staff and buyers."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {whatsapp ? (
          <a href={whatsapp} className="card block p-5 hover:bg-surface-2">
            <Icon name="whatsapp" className="h-6 w-6 text-green" />
            <h2 className="mt-3 font-display text-base font-semibold text-ink">WhatsApp</h2>
            <p className="mt-1 text-sm text-muted">{number ?? 'Message our support line'}</p>
          </a>
        ) : null}
        {email ? (
          <a href={`mailto:${email}`} className="card block p-5 hover:bg-surface-2">
            <span className="grid h-6 w-6 place-items-center text-lg leading-none text-green" aria-hidden="true">
              @
            </span>
            <h2 className="mt-3 font-display text-base font-semibold text-ink">Email</h2>
            <p className="mt-1 break-all text-sm text-muted">{email}</p>
          </a>
        ) : null}
        {!whatsapp && !email ? (
          <p className="text-sm text-muted sm:col-span-2">Contact details are being set up. Please check back soon.</p>
        ) : null}
      </div>

      <Section title="Bought something?">
        <p>
          Questions about an item or its delivery are best sent to the store first: reply to them on WhatsApp. If
          the store has buyer protection and something is wrong, tell them before the hold ends and we will step
          in. Read how{' '}
          <Link to="/refunds" className="font-medium text-green hover:underline">
            refunds
          </Link>{' '}
          work.
        </p>
      </Section>

      <Section title="Run a store?">
        <p>
          Signed in, use <span className="font-medium text-ink">Help</span> in your dashboard: it opens WhatsApp with
          your store already named, so we can help faster.
        </p>
      </Section>

      <Section title="Privacy requests">
        <p>
          To ask for a copy of your information, or to correct or delete it, contact us using any of the options
          above. Our{' '}
          <Link to="/privacy" className="font-medium text-green hover:underline">
            privacy policy
          </Link>{' '}
          explains what we hold.
        </p>
      </Section>
    </InfoPage>
  );
}
