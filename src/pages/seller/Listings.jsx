import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import PageHeader from '../../components/ui/PageHeader.jsx';
import Icon from '../../components/ui/Icon.jsx';
import StatusPill from '../../components/ui/StatusPill.jsx';
import ChannelDots from '../../components/ui/ChannelDots.jsx';
import EmptyState from '../../components/ui/EmptyState.jsx';
import ListingEditor from '../../components/ListingEditor.jsx';
import { useTenant } from '../../lib/TenantContext.jsx';
import { useToast } from '../../lib/ToastContext.jsx';
import { fetchListings, fetchListingCounts, fetchChannelPosts } from '../../lib/products.js';
import { listingDeepLink, botConfigured } from '../../lib/whatsapp.js';
import { productUrl } from '../../lib/tenants.js';
import { formatNaira } from '../../lib/money.js';
import { keys } from '../../lib/queryKeys.js';
import { firstImage } from '../../lib/images.js';

const CONDITION = {
  brand_new: 'Brand new',
  excellent: 'Excellent condition',
  good: 'Good condition',
  fair: 'Fair condition',
};

export default function Listings() {
  const { tenant } = useTenant();
  const tenantId = tenant?.id;
  const toast = useToast();
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  // null: closed. 'new': adding. Otherwise the id being edited.
  const [editing, setEditing] = useState(null);

  const { data: counts } = useQuery({
    queryKey: keys.listingCounts(tenantId),
    queryFn: () => fetchListingCounts(tenantId),
    enabled: Boolean(tenantId),
  });

  const { data: listings, isLoading } = useQuery({
    queryKey: keys.listings(tenantId, `${filter}:${search}`),
    queryFn: () => fetchListings(tenantId, { filter, search }),
    enabled: Boolean(tenantId),
  });

  const ids = (listings ?? []).map((l) => l.id);
  const { data: posts } = useQuery({
    queryKey: keys.channelPosts(tenantId, ids),
    queryFn: () => fetchChannelPosts(tenantId, ids),
    enabled: Boolean(tenantId && ids.length),
  });

  const deepLink = listingDeepLink(tenant);

  return (
    <>
      <PageHeader
        title="Listings"
        subtitle={
          counts ? `${counts.active} active · ${counts.sold} sold` : 'Everything you have for sale.'
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {deepLink ? (
              <a
                href={deepLink}
                className="inline-flex items-center gap-1.5 rounded-pill border border-line bg-surface px-4 py-2 text-sm font-semibold text-ink hover:bg-surface-2"
              >
                <Icon name="whatsapp" className="h-4 w-4" />
                Add on WhatsApp
              </a>
            ) : null}
            <button
              type="button"
              onClick={() => setEditing('new')}
              className="inline-flex items-center gap-1.5 rounded-pill bg-green px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
            >
              <Icon name="plus" className="h-4 w-4" />
              Add Product
            </button>
          </div>
        }
      />

      <div className="mb-4 space-y-3">
        <label className="relative block max-w-sm">
          <Icon
            name="search"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
          />
          <span className="sr-only">Search products</span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search products…"
            className="w-full rounded-pill border border-line bg-surface py-2 pl-9 pr-4 text-sm outline-none placeholder:text-muted focus:border-green/40"
          />
        </label>

        <div className="flex flex-wrap gap-2">
          {[
            { id: 'all', label: 'All', n: counts?.all },
            { id: 'active', label: 'Active', n: counts?.active },
            { id: 'sold', label: 'Sold', n: counts?.sold },
          ].map((chip) => (
            <button
              key={chip.id}
              type="button"
              onClick={() => setFilter(chip.id)}
              className={`rounded-pill border px-3 py-1.5 text-xs font-medium transition-colors ${
                filter === chip.id
                  ? 'border-sidebar bg-sidebar text-white'
                  : 'border-line bg-surface text-muted hover:text-ink'
              }`}
            >
              {chip.label}
              {chip.n != null ? ` (${chip.n})` : ''}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-72 animate-pulse rounded-card bg-surface-2" />
          ))}
        </div>
      ) : !listings?.length ? (
        <EmptyState
          icon="listings"
          title={search ? 'Nothing matches that' : 'No listings yet'}
          body={
            search
              ? 'Try a different word, or clear the search.'
              : botConfigured()
                ? 'Add one here with photos from your phone or laptop, or send a photo on WhatsApp and we will list it for you.'
                : 'Add your first product with the button below.'
          }
          action={
            search ? null : (
              <div className="flex flex-wrap justify-center gap-2">
                <button
                  type="button"
                  onClick={() => setEditing('new')}
                  className="inline-flex items-center gap-1.5 rounded-pill bg-green px-4 py-2 text-sm font-semibold text-white"
                >
                  <Icon name="plus" className="h-4 w-4" />
                  Add a product
                </button>
                {deepLink ? (
                  <a
                    href={deepLink}
                    className="inline-flex items-center gap-1.5 rounded-pill border border-line px-4 py-2 text-sm font-semibold text-ink"
                  >
                    <Icon name="whatsapp" className="h-4 w-4" />
                    Open WhatsApp
                  </a>
                ) : null}
              </div>
            )
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {listings.map((item) => (
            <article key={item.id} className="card flex flex-col overflow-hidden">
              {firstImage(item) ? (
                <img
                  src={firstImage(item)}
                  alt=""
                  className="aspect-[4/3] w-full bg-surface-2 object-cover"
                />
              ) : (
                <div className="grid aspect-[4/3] w-full place-items-center bg-surface-2 text-muted">
                  <Icon name="listings" className="h-6 w-6" />
                </div>
              )}

              <div className="flex flex-1 flex-col p-3">
                <h3 className="truncate text-sm font-medium text-ink">{item.title}</h3>
                <p className="mt-0.5 font-display text-base font-semibold text-ink">
                  {formatNaira(item.price)}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {CONDITION[item.condition] ?? item.condition}
                </p>

                <div className="mt-2 flex items-center justify-between gap-2">
                  <StatusPill status={item.status} />
                  <ChannelDots posts={posts?.[item.id] ?? {}} />
                </div>

                <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
                  <button
                    type="button"
                    onClick={() => setEditing(item.id)}
                    className="flex-1 rounded-lg border border-line py-1.5 text-xs font-medium text-ink hover:bg-surface-2"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    title="Copy share link"
                    onClick={() => {
                      const url = productUrl(item.public_code);
                      navigator.clipboard
                        ?.writeText(url)
                        .then(() => toast('Link copied', 'success'))
                        .catch(() => toast('Could not copy that link', 'error'));
                    }}
                    className="grid h-8 w-8 place-items-center rounded-lg border border-line text-muted hover:text-ink"
                  >
                    <span className="sr-only">Copy share link for {item.title}</span>
                    <Icon name="more" className="h-4 w-4" />
                  </button>
                </div>

                {/* The code is what a buyer quotes back to the bot, so it is
                    worth showing rather than hiding behind the copy button. */}
                <p className="mt-2 text-center text-[10px] tracking-wider text-muted">
                  {item.public_code}
                </p>
              </div>
            </article>
          ))}
        </div>
      )}

      {editing ? (
        <ListingEditor
          tenantId={tenantId}
          listingId={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}
