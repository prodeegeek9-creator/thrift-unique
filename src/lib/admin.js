import { supabase } from './supabase.js';

// The operator console's data layer.
//
// Unlike every other module in lib/, this one does not talk to Supabase. It
// cannot: the console reads across tenants, and every RLS policy is strictly
// tenant-scoped with no admin exception. So it calls the Worker, which holds
// the service key and checks operator status in one place.
//
// The access token goes in the Authorization header and the Worker resolves it
// with Supabase rather than decoding it — the browser is never asked whether
// it is an admin, it is told what it may see.

async function call(path, { method = 'GET', body } = {}) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Not signed in');

  const res = await fetch(`/api/admin${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(payload.error ?? `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return payload;
}

// Whether the signed-in person is an operator at all, and at what level.
//
// Returns null rather than throwing on 403, because "you are not an operator"
// is the ordinary answer for almost everyone who is signed in — it is not an
// error condition, it is the reason the console does not render.
export async function whoAmI() {
  try {
    return await call('/me');
  } catch (err) {
    if (err.status === 403) return null;
    throw err;
  }
}

export const fetchOverview = () => call('/overview');
export const fetchTenants = () => call('/tenants');
export const fetchTenant = (id) => call(`/tenants/${id}`);
export const fetchReleaseQueue = () => call('/escrow');
export const fetchDisputes = () => call('/disputes');
export const fetchAudit = () => call('/audit');

export const setFlag = (tenantId, flag, enabled) =>
  call(`/tenants/${tenantId}/flags`, { method: 'POST', body: { flag, enabled } });

export const setTenantStatus = (tenantId, status) =>
  call(`/tenants/${tenantId}/status`, { method: 'POST', body: { status } });

// planPrice: undefined leaves the monthly fee alone, null returns it to the
// plan's price, a number (0 for free) sets this store's own.
export const setPlan = (tenantId, tier, commissionPct, planPrice) =>
  call(`/tenants/${tenantId}/plan`, {
    method: 'POST',
    body: { tier, commission_pct: commissionPct, ...(planPrice !== undefined ? { plan_price: planPrice } : {}) },
  });

export const recordPlanPayment = (tenantId, note) =>
  call(`/tenants/${tenantId}/billing/record`, { method: 'POST', body: { note } });

export const setDetails = (tenantId, details) =>
  call(`/tenants/${tenantId}/details`, { method: 'POST', body: details });

// Each plan's standard commission, to prefill the plan editor. The sign-up
// terms quote these (COMMISSION in worker/lib/bot.js); keep them in step.
export const DEFAULT_COMMISSION = { starter: 8, growth: 7, business: 7 };

export const setPayoutsPaused = (tenantId, paused) =>
  call(`/tenants/${tenantId}/payouts-paused`, { method: 'POST', body: { paused } });

export const retryPayout = (payoutId) => call(`/payouts/${payoutId}/retry`, { method: 'POST', body: {} });

export const forceRelease = (orderId, reason) =>
  call(`/escrow/${orderId}/release`, { method: 'POST', body: { reason } });

export const resolveDispute = (disputeId, outcome, resolution) =>
  call(`/disputes/${disputeId}/resolve`, { method: 'POST', body: { outcome, resolution } });

// What each audit action reads as in the log. Unknown actions render their raw
// name rather than being hidden — an action nobody wrote a label for is still
// something that happened.
export const AUDIT_LABELS = {
  'flag.set': 'Changed a feature flag',
  'tenant.status': 'Changed a store’s status',
  'tenant.approve': 'Approved a new store',
  'tenant.plan': 'Changed a store’s plan or commission',
  'tenant.details': 'Edited a store’s details',
  'payouts.pause': 'Paused a store’s payouts',
  'payouts.resume': 'Resumed a store’s payouts',
  'payouts.retry': 'Retried a payout',
  'billing.record': 'Recorded a plan fee paid another way',
  'escrow.release': 'Released held funds',
  'dispute.resolve': 'Resolved a dispute',
};
