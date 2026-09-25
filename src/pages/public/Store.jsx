import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { brandStyle, fetchPublicStore } from '../../lib/tenants.js';
import { formatNaira } from '../../lib/money.js';
import { imageUrl } from '../../lib/images.js';
import BrandMark from '../../components/ui/BrandMark.jsx';
import LogoLoader from '../../components/ui/LogoLoader.jsx';

// A store's own page: /s/<slug>.
//
// Every store on the platform gets one, kept apart from every other store —
// its name, its colour, its listings and its WhatsApp, with nothing from
// anybody else's catalogue beside them. It is an add-on to how a store already
// sells (WhatsApp, Instagram, a link in a DM), not a marketplace: one link a
// store can put in its bio instead of posting items one at a time. Each item
// opens its own /p/<code> page, which is where buying starts.
//
// Reads through public_store(), which answers for one live store by slug and
// nothing adjacent to it. A store still waiting for approval is "not found".

const CONDITION = {
  brand_new: 'Brand new',
  excellent: 'Excellent',
  good: 'Good',
  fair: 'Fair',
};

export default function Store() {
  const { slug } = useParams();
  const [store, setStore] = useState(null);
  const [state, setState] = useState('loading');

  useEffect(() => {
    let active = true;
    (async () => {
      const row = await fetchPublicStore(slug).catch(() => null);
      if (!active) return;
      setStore(row);
      setState(row ? 'ready' : 'missing');
    })();
    return () => {
      active = false;
    };
  }, [slug]);

  useEffect(() => {
    if (store?.name) document.title = store.name;
  }, [store?.name]);

  if (state === 'loading') return <LogoLoader fullScreen label="Loading" />;

  if (state === 'missing') {
    return (
      <div className="min-h-dvh bg-bg px-4 py-10">
        <div className="card mx-auto max-w-sm p-5 text-center">
          <BrandMark className="mx-auto h-8 w-8" />
          <h1 className="mt-3 font-display text-lg font-semibold">Store not found</h1>
          <p className="mt-2 text-sm text-muted">
            This store doesn't exist, or isn't open yet.
          </p>
        </div>
      </div>
    );
  }

  const logo = imageUrl(store.logo_url);
  const chat = store.whatsapp_number
    ? `https://wa.me/${store.whatsapp_number}?text=${encodeURIComponent(`Hi ${store.name}! I found your store online.`)}`
    : null;

  return (
    <div className="min-h-dvh bg-bg" style={brandStyle(store)}>
      <header className="border-b border-line bg-surface px-4 py-5">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          {logo ? (
            <img src={logo} alt="" className="h-12 w-12 shrink-0 rounded-full object-cover" />
          ) : (
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-green text-lg font-semibold text-white">
              {store.name.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-display text-lg font-semibold text-ink">{store.name}</h1>
            <p className="text-xs text-muted">
              {store.products.length} item{store.products.length === 1 ? '' : 's'} for sale
            </p>
          </div>
          {chat ? (
            <a
              href={chat}
              className="shrink-0 rounded-pill bg-green px-4 py-2 text-xs font-semibold text-white"
            >
              WhatsApp
            </a>
          ) : null}
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-5">
        {store.products.length ? (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {store.products.map((p) => (
              <li key={p.public_code}>
                <Link to={`/p/${p.public_code}`} className="card block overflow-hidden">
                  {imageUrl(p.image) ? (
                    <img
                      src={imageUrl(p.image)}
                      alt={p.title}
                      loading="lazy"
                      className="aspect-square w-full object-cover"
                    />
                  ) : (
                    <div className="aspect-square w-full bg-line" />
                  )}
                  <div className="p-2.5">
                    <p className="truncate text-sm font-medium text-ink">{p.title}</p>
                    <p className="mt-0.5 text-sm font-semibold text-ink">{formatNaira(p.price)}</p>
                    <p className="text-xs text-muted">{CONDITION[p.condition] ?? p.condition}</p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-16 text-center text-sm text-muted">
            Nothing listed right now. Check back soon, or message the store on WhatsApp.
          </p>
        )}

        <p className="mt-8 text-center text-xs text-muted">Payment protected by Unique Thrift</p>
      </main>
    </div>
  );
}
