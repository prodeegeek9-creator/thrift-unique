import { Link } from 'react-router-dom';
import InfoPage, { ContactLine, List, Section } from './InfoPage.jsx';
import { LEGAL_UPDATED, supportContact } from '../../lib/legal.js';

// Written from what the system actually stores and who it is shared with:
// the migrations under supabase/migrations, the checkout form, the sign-up
// conversation in worker/lib/bot.js and the payout card. A new column of
// personal data, or a new service it goes to, belongs in here too.
export default function Privacy() {
  const contact = supportContact();

  return (
    <InfoPage
      title="Privacy policy"
      updated={LEGAL_UPDATED}
      intro="This explains what personal information Vendwyze collects, why, who it is shared with, and the choices you have. It covers store owners and their staff, buyers, and people who send items to a thrift store to sell."
    >
      <Section title="Who we are">
        <p>
          Vendwyze runs a platform that lets independent businesses sell through WhatsApp, a store web page and a
          dashboard, and takes payment from buyers on their behalf. When this policy says “we”, it means Vendwyze.
        </p>
        <p>
          Each store on Vendwyze is its own business. A store decides what it sells and deals with its own buyers,
          and is responsible for how it uses the buyer details it receives through us.
        </p>
      </Section>

      <Section title="What we collect">
        <p className="font-medium text-ink">If you run a store, or work in one</p>
        <List>
          <li>Your name, email address, phone and WhatsApp number, and address.</li>
          <li>Your business details: its name, type, what it sells, its plan and its store page settings.</li>
          <li>The bank account your payouts go to, checked with the bank through Paystack.</li>
          <li>Your listings, including the photos you send, and the messages you send to our WhatsApp number.</li>
          <li>When you accepted our terms, and which version you accepted.</li>
          <li>Sign-in details. If you sign in with Google, we receive your name and email from Google.</li>
        </List>

        <p className="pt-2 font-medium text-ink">If you buy from a store</p>
        <List>
          <li>Your name, WhatsApp number and delivery address, and an email address if you give one.</li>
          <li>Any note you leave for the store, and what you bought, when, and for how much.</li>
          <li>
            Payment status from Paystack. We never see or store your card number or bank login; Paystack handles
            those.
          </li>
          <li>Messages you send to our WhatsApp number, for example to buy an item or confirm a delivery.</li>
        </List>

        <p className="pt-2 font-medium text-ink">If you send an item to a thrift store to sell</p>
        <List>
          <li>Your WhatsApp number and name, the photos and description of the item, and the price you ask.</li>
        </List>

        <p className="pt-2 font-medium text-ink">From everyone who visits</p>
        <List>
          <li>
            Basic technical information our hosting provider records, such as IP address, browser type and the
            pages requested, used to keep the service secure and working.
          </li>
          <li>Which channel a visit or sale came from (for example WhatsApp or a store link), so stores can see what works.</li>
        </List>
      </Section>

      <Section title="Why we use it">
        <List>
          <li>To run stores, list items, take payments, and pay stores what they are owed.</li>
          <li>To hold payments until delivery is confirmed on plans that include buyer protection, and to issue refunds.</li>
          <li>To send receipts, order and delivery updates, and account messages on WhatsApp or by email.</li>
          <li>To charge plan fees, and to remind stores when a fee is due.</li>
          <li>To prevent fraud, settle disputes, and keep records we are required to keep by law.</li>
          <li>To support you when you contact us, and to improve the service.</li>
        </List>
        <p>
          We use your information because it is needed to provide the service you asked for, to meet our legal
          obligations, or for our legitimate interest in running a safe and reliable service. We do not sell your
          personal information, and we do not use it for advertising.
        </p>
      </Section>

      <Section title="Who we share it with">
        <List>
          <li>
            <span className="font-medium text-ink">The store you deal with.</span> A store sees the name, delivery
            details and order history of its own buyers, and the details of people who send it items to sell. The
            dashboard partly hides buyer phone numbers on screen. A store never sees another store's buyers.
          </li>
          <li>
            <span className="font-medium text-ink">Paystack</span>, which processes payments, refunds and payouts.
          </li>
          <li>
            <span className="font-medium text-ink">WhatsApp (Meta)</span>, which carries the messages we send and
            receive.
          </li>
          <li>
            <span className="font-medium text-ink">Our infrastructure providers</span>: Supabase (database, sign-in
            and photo storage) and Cloudflare (hosting).
          </li>
          <li>
            <span className="font-medium text-ink">Google</span>, only if you choose to sign in with Google.
          </li>
          <li>Authorities, where the law requires it, or to protect people from fraud or harm.</li>
        </List>
        <p>
          Some of these providers store data outside Nigeria. Where they do, we rely on their contractual and
          security commitments to protect it.
        </p>
      </Section>

      <Section title="Item photos and store pages">
        <p>
          Store pages and item pages are public: anyone with the link can see the store's name, its listings and
          their photos. Do not include personal information in item photos or descriptions that you would not want
          to be public.
        </p>
      </Section>

      <Section title="Cookies and storage in your browser">
        <p>
          We do not use advertising or tracking cookies. The dashboard keeps a few items in your browser's storage
          so it works properly: your signed-in session, which store you last opened, and whether you have dismissed
          certain prompts. Clearing your browser's storage removes them; you will need to sign in again.
        </p>
      </Section>

      <Section title="How long we keep it">
        <p>
          We keep account information while your store or account is open. We keep records of orders, payments,
          refunds and payouts for as long as tax, accounting and financial laws require, even after an account is
          closed. Other information is deleted or anonymised when we no longer need it.
        </p>
      </Section>

      <Section title="How we protect it">
        <p>
          Data is encrypted in transit. Each store can reach only its own records, enforced by the database itself,
          and secret keys are kept on our servers, never in the app your browser loads. Only a small team at
          Vendwyze can see across stores, and what they do is logged.
        </p>
      </Section>

      <Section title="Your rights">
        <p>
          Under the Nigeria Data Protection Act 2023 and similar laws, you can ask us for a copy of your
          information, ask us to correct it or delete it, object to how we use it, or ask us to move it to another
          service. Some information we must keep by law, such as payment records, even if you ask us to delete it.
        </p>
        <p>
          If you bought from a store, you can also contact that store directly about the details it holds. If you
          are not satisfied with our response, you can complain to the Nigeria Data Protection Commission.
        </p>
      </Section>

      <Section title="Children">
        <p>Vendwyze is not meant for anyone under 18, and we do not knowingly collect their information.</p>
      </Section>

      <Section title="Changes to this policy">
        <p>
          We will update this page when our practices change and show the date at the top. If a change is
          significant, we will tell store owners on WhatsApp or by email.
        </p>
      </Section>

      <Section title="Contact us">
        <ContactLine contact={contact} />
        <p>
          See also our{' '}
          <Link to="/terms" className="font-medium text-green hover:underline">
            terms of service
          </Link>
          .
        </p>
      </Section>
    </InfoPage>
  );
}
