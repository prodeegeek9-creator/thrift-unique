import { Link } from 'react-router-dom';
import InfoPage, { ContactLine, List, Section } from './InfoPage.jsx';
import { CONFIRM_WINDOW_DAYS, GRACE_DAYS, LEGAL_UPDATED, TRIAL_DAYS, supportContact } from '../../lib/legal.js';

// The long form of what a store owner says YES to in the sign-up chat
// (termsMessage() in worker/lib/bot.js, DISCLAIMER_VERSION). The two must
// say the same thing; when the bot's wording changes, this page changes with
// it, and the other way round.
export default function Terms() {
  const contact = supportContact();

  return (
    <InfoPage
      title="Terms of service"
      updated={LEGAL_UPDATED}
      intro="These terms apply to everyone who uses Vendwyze: businesses that open a store, their staff, and buyers who pay through a store's page, a payment link or WhatsApp. By using Vendwyze you agree to them."
    >
      <Section title="1. What Vendwyze does">
        <p>
          Vendwyze gives businesses a way to list items over WhatsApp, a public store page, a dashboard, and
          payment collection through Paystack. Vendwyze is not the seller of any item. Each store is an independent
          business and is responsible for what it lists, describes, sells and delivers.
        </p>
      </Section>

      <Section title="2. Opening a store">
        <List>
          <li>You must be at least 18 and able to enter a binding agreement for your business.</li>
          <li>The details you give us, including your payout bank account, must be true and kept up to date.</li>
          <li>
            A new store is reviewed by Vendwyze before its dashboard and store page go live. We can decline a store
            without giving a reason.
          </li>
          <li>You are responsible for everyone you give access to your store, and for keeping sign-in details safe.</li>
        </List>
      </Section>

      <Section title="3. Plans and fees">
        <List>
          <li>
            Every plan is free for {TRIAL_DAYS} days after your store is approved. After that the plan fee is
            charged monthly, in advance, at the price shown on our{' '}
            <a href="/#plans" className="font-medium text-green hover:underline">
              plans
            </a>
            .
          </li>
          <li>
            If a plan fee is not paid within {GRACE_DAYS} days of its due date, the store is paused until it is.
          </li>
          <li>
            Every sale paid through Vendwyze has a commission deducted before the store is paid: the rate for your
            plan, or on Business the rate we have agreed with you. We will not raise a rate you have already
            accepted without your agreement.
          </li>
          <li>You can change plan at any time from your dashboard.</li>
        </List>
      </Section>

      <Section title="4. Payments and payouts">
        <List>
          <li>
            Buyers always pay through Vendwyze. Taking payment directly from a buyer for an item listed on Vendwyze
            is not allowed and can get the store suspended.
          </li>
          <li>On Starter, a store is paid the same day the buyer pays.</li>
          <li>
            On Growth and Business, the buyer's payment is held until they confirm the item arrived, or for{' '}
            {CONFIRM_WINDOW_DAYS} days, and is then released to the store. A hold stays in place while a dispute on
            that order is open.
          </li>
          <li>Payouts go to the bank account on your store, through Paystack.</li>
        </List>
      </Section>

      <Section title="5. Refunds">
        <p>
          What a buyer can get back depends on the store's plan and whether the store has already been paid. The
          full rules are on our{' '}
          <Link to="/refunds" className="font-medium text-green hover:underline">
            refunds and buyer protection
          </Link>{' '}
          page, which forms part of these terms. In short: Vendwyze can refund a buyer only while it still holds
          the payment; after that, a complaint is between the buyer and the store. If a buyer pays for an item that
          had already sold, Vendwyze refunds them in full and the store is not charged.
        </p>
      </Section>

      <Section title="6. What you can't sell or do">
        <List>
          <li>Items that are illegal, stolen, counterfeit, or that you do not have the right to sell.</li>
          <li>Weapons, drugs, prescription medicines, or anything else Paystack or WhatsApp does not allow.</li>
          <li>Listings that are misleading about an item's condition, authenticity or price.</li>
          <li>Spamming people on WhatsApp, or using Vendwyze to collect people's details for any other purpose.</li>
          <li>Trying to get around the platform's fees, security or another store's data.</li>
        </List>
        <p>We can remove listings and pause or close a store that breaks these terms.</p>
      </Section>

      <Section title="7. Buyers">
        <List>
          <li>
            The contract for an item is between you and the store. Questions about an item, its delivery or its
            condition go to the store first.
          </li>
          <li>
            On stores with buyer protection, please confirm when your item arrives. If something is wrong, reply to
            the store on WhatsApp before the hold ends and we will step in.
          </li>
          <li>A payment link a store sends you is for your WhatsApp number only and expires after a few days.</li>
        </List>
      </Section>

      <Section title="8. Your content">
        <p>
          You keep ownership of the photos and descriptions you send. You allow Vendwyze to store and display them
          on your store page, item pages, WhatsApp Status and the channels you connect, for as long as they are
          listed.
        </p>
      </Section>

      <Section title="9. Availability and liability">
        <p>
          We work to keep Vendwyze running, but it depends on WhatsApp, Paystack and other services we do not
          control, and it may sometimes be unavailable. To the extent the law allows, Vendwyze is not liable for
          lost sales, profits or indirect losses, or for what a store or buyer does. Our total liability to you is
          limited to the fees you paid us in the three months before the claim.
        </p>
      </Section>

      <Section title="10. Ending your use">
        <p>
          You can close your store at any time by contacting us. We can suspend or close a store for unpaid fees,
          for breaking these terms, or to protect buyers. Money owed for completed sales is still paid out, less
          any refunds or fees owed.
        </p>
      </Section>

      <Section title="11. Changes and law">
        <p>
          We may update these terms. When we do, we change the date at the top, and tell store owners about
          significant changes before they apply. These terms are governed by the laws of the Federal Republic of
          Nigeria.
        </p>
        <p>
          How we handle personal information is in our{' '}
          <Link to="/privacy" className="font-medium text-green hover:underline">
            privacy policy
          </Link>
          .
        </p>
      </Section>

      <Section title="12. Contact">
        <ContactLine contact={contact} />
      </Section>
    </InfoPage>
  );
}
