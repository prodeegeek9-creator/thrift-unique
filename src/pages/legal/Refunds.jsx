import { Link } from 'react-router-dom';
import InfoPage, { ContactLine, List, Section } from './InfoPage.jsx';
import { CONFIRM_WINDOW_DAYS, LEGAL_UPDATED, supportContact } from '../../lib/legal.js';

// The rules in worker/lib/refunds.js, said for buyers and stores. The same
// split by plan is on the homepage's pricing and in the bot's terms.
export default function Refunds() {
  const contact = supportContact();

  return (
    <InfoPage
      title="Refunds & buyer protection"
      updated={LEGAL_UPDATED}
      intro="Every payment on Vendwyze goes through Paystack, never to a store's own account. What a buyer can get back depends on the store's plan and on whether the store has been paid yet."
    >
      <Section title="Stores with buyer protection (Growth and Business)">
        <List>
          <li>Your payment is held by Vendwyze, not paid to the store, until you confirm the item arrived.</li>
          <li>
            If you don't confirm, the payment is released to the store {CONFIRM_WINDOW_DAYS} days after you paid,
            unless there is an open dispute on the order.
          </li>
          <li>
            While it is held, your payment can be refunded to you. If something is wrong, reply to the store on
            WhatsApp before the {CONFIRM_WINDOW_DAYS} days are up and we will step in.
          </li>
          <li>Once you confirm, or the hold ends, the payment goes to the store and can no longer be refunded through us.</li>
        </List>
      </Section>

      <Section title="Stores without buyer protection (Starter)">
        <List>
          <li>The store is paid the same day you pay.</li>
          <li>We can refund you only before the store's payout has gone out.</li>
          <li>After that, a complaint about the item is between you and the store.</li>
        </List>
      </Section>

      <Section title="How much you get back">
        <List>
          <li>
            A refund is what you paid less Paystack's processing fee, which Paystack keeps on a refund. Vendwyze
            does not charge its commission on a refunded sale.
          </li>
          <li>
            If you paid for an item that had already been sold to someone else, you are refunded automatically and
            in full, and Vendwyze pays the fee.
          </li>
          <li>A payment that is not for the item's price is checked by a person, who refunds or settles it.</li>
        </List>
      </Section>

      <Section title="How long it takes">
        <p>
          Once a refund is made, it usually reaches you in 3 to 10 working days, depending on your bank and how you
          paid. We tell you on WhatsApp when it has been sent. If a refund does not go through, we retry it and
          will contact you if we need anything.
        </p>
      </Section>

      <Section title="For stores">
        <p>
          A refund never takes money back from a store that has already been paid. On buyer-protection plans,
          answer a buyer's complaint while the payment is held; you can open a dispute from your dashboard. Taking
          payment outside Vendwyze removes all of this protection and is not allowed by our{' '}
          <Link to="/terms" className="font-medium text-green hover:underline">
            terms
          </Link>
          .
        </p>
      </Section>

      <Section title="Need help?">
        <ContactLine contact={contact} />
      </Section>
    </InfoPage>
  );
}
