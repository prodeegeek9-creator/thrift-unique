import { Link } from 'react-router-dom';
import InfoPage, { List, Section } from './InfoPage.jsx';
import Icon from '../../components/ui/Icon.jsx';
import { setupDeepLink } from '../../lib/whatsapp.js';

export default function About() {
  const open = setupDeepLink();

  return (
    <InfoPage
      title="About Vendwyze"
      intro="Vendwyze helps thrift stores and brands sell from WhatsApp, the place their customers already are, without building or looking after a website."
    >
      <Section title="Why we built it">
        <p>
          Plenty of businesses already sell through WhatsApp chats and Status updates. What they lack is the rest
          of a shop: a page that shows everything for sale, a way to take payment that buyers trust, and a record
          of who bought what. Vendwyze adds those, while the selling stays in the chat.
        </p>
      </Section>

      <Section title="What we do">
        <List>
          <li>
            <span className="font-medium text-ink">Listing in a chat.</span> Send a photo, a name and a price to
            our WhatsApp number and the item is listed.
          </li>
          <li>
            <span className="font-medium text-ink">Your own store page.</span> Every store gets a web page and a
            link for each item, ready to drop in any chat or bio.
          </li>
          <li>
            <span className="font-medium text-ink">Posting for you.</span> New items go out to your WhatsApp
            Status automatically.
          </li>
          <li>
            <span className="font-medium text-ink">Payments through Paystack.</span> Buyers pay through us, and on
            Growth and Business their payment is held until they confirm delivery.
          </li>
          <li>
            <span className="font-medium text-ink">Thrift consignment.</span> People who bring items to a thrift
            store send them on WhatsApp, and the store approves and prices them.
          </li>
        </List>
      </Section>

      <Section title="What we don't do">
        <p>
          There is no Vendwyze marketplace. Each store's page shows that store alone, so we never put your
          competitors next to your listings or send your buyers elsewhere.
        </p>
      </Section>

      <Section title="Get started">
        <p>
          Opening a store takes a couple of minutes on WhatsApp, and every plan is free for your first 14 days.
        </p>
        <div className="flex flex-wrap gap-3 pt-1">
          {open ? (
            <a
              href={open}
              className="inline-flex items-center gap-2 rounded-pill bg-green px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90"
            >
              <Icon name="whatsapp" className="h-4 w-4" />
              Open your store on WhatsApp
            </a>
          ) : null}
          <Link
            to="/contact"
            className="inline-flex items-center rounded-pill border border-line bg-surface px-5 py-2.5 text-sm font-semibold text-ink hover:bg-surface-2"
          >
            Talk to us
          </Link>
        </div>
      </Section>
    </InfoPage>
  );
}
