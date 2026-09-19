import { supabase } from './supabase.js';

// The buyers who have paid this store. Growth+ — see FLAG_MIN_TIER.
//
// Reads buyer_summary, the view that does the counting in Postgres rather than
// pulling every order into the browser to group it. The view is
// security_invoker, so the caller's own RLS still applies and a tenant sees
// only their own customers.
//
// Note what "their own" means here: buyers are scoped per tenant, so the same
// person buying from two different sellers is two rows. Each seller owns their
// customer relationship — that is what they are paying for, and a shared buyer
// table would quietly make the platform the one with the list.

const COLUMNS =
  'id, tenant_id, name, phone, first_seen_at, order_count, total_spent, ' +
  'last_purchase_at, is_repeat';

export async function fetchContacts(tenantId, { search = '', limit = 200 } = {}) {
  if (!tenantId) return [];

  let q = supabase
    .from('buyer_summary')
    .select(COLUMNS)
    .eq('tenant_id', tenantId)
    // Best customers first. A contact list sorted by recency answers "who
    // bought today", which the Orders screen already answers; sorted by spend
    // it answers "who should I message when new stock lands", which nothing
    // else does.
    .order('total_spent', { ascending: false })
    .limit(limit);

  if (search.trim()) {
    const term = `%${search.trim()}%`;
    q = q.or(`name.ilike.${term},phone.ilike.${term}`);
  }

  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

// The two numbers in the Contacts header: "124 buyers · 18 repeat buyers".
export async function fetchContactStats(tenantId) {
  if (!tenantId) return { buyers: 0, repeat: 0 };

  const [all, repeat] = await Promise.all([
    supabase
      .from('buyer_summary')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId),
    supabase
      .from('buyer_summary')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('is_repeat', true),
  ]);

  for (const r of [all, repeat]) if (r.error) throw r.error;
  return { buyers: all.count ?? 0, repeat: repeat.count ?? 0 };
}

// Everything one buyer has bought, for the drawer behind "View profile" on an
// order.
export async function fetchContactOrders(tenantId, buyerId) {
  if (!tenantId || !buyerId) return [];

  const { data, error } = await supabase
    .from('orders')
    .select('id, order_code, amount, status, created_at, product:products(title, images)')
    .eq('tenant_id', tenantId)
    .eq('buyer_id', buyerId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data ?? [];
}
