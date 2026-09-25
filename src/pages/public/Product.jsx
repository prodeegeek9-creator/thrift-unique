import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchPublicProduct } from '../../lib/products.js';
import { formatNaira } from '../../lib/money.js';
import BrandMark from '../../components/ui/BrandMark.jsx';
import LogoLoader from '../../components/ui/LogoLoader.jsx';
import { firstImage, imageUrl } from '../../lib/images.js';
import { fetchPublicStore } from '../../lib/tenants.js';

// One item.
//
// There is no cart and no marketplace — the product is discovered on WhatsApp
// Status, Instagram, Facebook, TikTok or its store's own page (Store.jsx), and
// this page is the far end of that link. It exists for three reasons a
// caption cannot cover:
//
//   - Instagram will not make a caption clickable, so a link in the bio or a
//     DM is the only route from "I want this" to a conversation.
//   - A forwarded link has to render as a photo and a price rather than bare
//     text, which means og: tags — injected by the Worker, not by React,
//     because a scraper does not run JavaScript.
//   - The bot needs to know which item a buyer means. The button below carries
//     the code into the opening message, so nobody has to describe the jacket.
//
// It reads through public_product(), which takes a code and returns one row.
// A plain anon SELECT policy would let anyone walk every tenant's catalogue.

const CONDITION = {
  brand_new: 'Brand new',
  excellent: 'Excellent condition',
  good: 'Good condition',
  fair: 'Fair condition',
};

export default function Product() {
  const { code } = useParams();
  const [product, setProduct] = useState(null);
  const [state, setState] = useState('loading');
  const [more, setMore] = useState([]);

  // A few more of the store's items, once the item itself is on screen. Its
  // own failure is silent: this is a nicety under the thing the buyer came for.
  useEffect(() => {
    if (!product?.tenant_slug) return undefined;
    let active = true;
    fetchPublicStore(product.tenant_slug)
      .then((store) => {
        if (!active || !store) return;
        setMore((store.products ?? []).filter((p) => p.public_code !== product.public_code).slice(0, 6));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [product?.tenant_slug, product?.public_code]);

  useEffect(() => {
    let active = true;
    // Arriving from "More from this store" lands at the top, not where the
    // last item's page was scrolled to.
    window.scrollTo(0, 0);
    (async () => {
      const row = await fetchPublicProduct(code).catch(() => null);
      if (!active) return;
      if (!row) {
        setState('missing');
        return;
      }
      setProduct(row);
      setState('ready');
    })();
    return () => {
      active = false;
    };
  }, [code]);

  if (state === 'loading') return <LogoLoader fullScreen label="Loading" />;

  if (state === 'missing') {
    return (
      <Frame>
        <h1 className="font-display text-lg font-semibold">Item not available</h1>
        <p className="mt-2 text-sm text-muted">
          This listing has sold or been taken down.
        </p>
      </Frame>
    );
  }

  const buyLink = product.tenant_whatsapp
    ? `https://wa.me/${product.tenant_whatsapp}?text=${encodeURIComponent(
        `Hi! I want to buy ${product.title} (${product.public_code}) — ${formatNaira(product.price)}`
      )}`
    : null;

  return (
    <Frame wide>
      {firstImage(product) ? (
        <img
          src={firstImage(product)}
          alt={product.title}
          className="aspect-square w-full rounded-card object-cover"
        />
      ) : null}

      <div className="mt-4">
        <h1 className="font-display text-xl font-semibold text-ink">{product.title}</h1>
        <p className="mt-1 text-2xl font-semibold text-ink">
          {formatNaira(product.price)}
        </p>
        <p className="mt-1 text-sm text-muted">
          {CONDITION[product.condition] ?? product.condition}
        </p>

        {product.description ? (
          <p className="mt-4 whitespace-pre-line text-sm leading-relaxed text-text">
            {product.description}
          </p>
        ) : null}

        {buyLink ? (
          <a
            href={buyLink}
            className="mt-6 block rounded-pill bg-green py-3 text-center text-sm font-semibold text-white"
          >
            Buy on WhatsApp
          </a>
        ) : null}

        <p className="mt-3 text-center text-xs text-muted">
          Sold by{' '}
          {product.tenant_slug ? (
            <Link to={`/s/${product.tenant_slug}`} className="font-medium text-green">
              {product.tenant_name}
            </Link>
          ) : (
            product.tenant_name
          )}{' '}
          · Payment protected by Unique Thrift
        </p>
      </div>

      {more.length ? (
        <div className="mt-6 border-t border-line pt-5">
          <div className="flex items-baseline justify-between">
            <h2 className="font-display text-sm font-semibold text-ink">More from {product.tenant_name}</h2>
            <Link to={`/s/${product.tenant_slug}`} className="text-xs font-semibold text-green">
              See all
            </Link>
          </div>
          <ul className="mt-3 grid grid-cols-3 gap-2">
            {more.map((p) => (
              <li key={p.public_code}>
                <Link to={`/p/${p.public_code}`} className="block">
                  {imageUrl(p.image) ? (
                    <img
                      src={imageUrl(p.image)}
                      alt={p.title}
                      loading="lazy"
                      className="aspect-square w-full rounded-lg bg-surface-2 object-cover"
                    />
                  ) : (
                    <div className="aspect-square w-full rounded-lg bg-surface-2" />
                  )}
                  <p className="mt-1 truncate text-[11px] text-ink">{p.title}</p>
                  <p className="text-[11px] font-semibold text-ink">{formatNaira(p.price)}</p>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Frame>
  );
}

function Frame({ children, wide = false }) {
  return (
    <div className="min-h-dvh bg-bg px-4 py-6">
      <div className={`mx-auto ${wide ? 'max-w-md' : 'max-w-sm'}`}>
        <div className="mb-4 flex justify-center">
          <BrandMark className="h-8 w-8" />
        </div>
        <div className="card p-5">{children}</div>
      </div>
    </div>
  );
}
