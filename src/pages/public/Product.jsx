import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase.js';
import { formatNaira } from '../../lib/money.js';
import BrandMark from '../../components/ui/BrandMark.jsx';
import LogoLoader from '../../components/ui/LogoLoader.jsx';

// One item. Not a shop.
//
// There is no storefront, no cart and no browse — the product is discovered on
// WhatsApp Status, Instagram, Facebook or TikTok, and this page is only ever
// the far end of a link somebody was sent. It exists for three reasons a
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

  useEffect(() => {
    let active = true;
    (async () => {
      const { data, error } = await supabase.rpc('public_product', { code });
      if (!active) return;
      if (error || !data?.length) {
        setState('missing');
        return;
      }
      setProduct(data[0]);
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
      {product.images?.[0] ? (
        <img
          src={product.images[0]}
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
          Sold by {product.tenant_name} · Payment protected by Unique Thrift
        </p>
      </div>
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
