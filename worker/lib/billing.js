import { PLAN_PRICES, TRIAL_DAYS, GRACE_DAYS, TIERS } from './plans.js';
import { applyTier } from './planChange.js';
import { db } from './supabase.js';
import { nairaToKobo } from './money.js';
import { formatNaira } from './bot.js';
import { chatId } from './waha.js';

// The monthly plan fee.
//
// A store is free for TRIAL_DAYS from approval. From then on it pays a month
// at a time. REMIND_BEFORE_DAYS before the end of what it has paid for, an
// invoice is opened and the owner is sent its pay page on WhatsApp. If it
// renews automatically, the saved card is charged on the day. Unpaid on the
// day, the store is past due; unpaid GRACE_DAYS later, it is paused until it
// pays. The hourly cron runs billingSweep(); each reminder goes once.
//
// Prices are kept in step with the sign-up bot (lib/bot.js), the homepage
// (src/pages/public/Home.jsx) and the Billing page (src/lib/billing.js).


export { PLAN_PRICES, TRIAL_DAYS, GRACE_DAYS };
export const REMIND_BEFORE_DAYS = 3;

const DAY = 86_400_000;
const REF_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

// What this store pays a month: its agreed price if it has one, else its
// plan's. Zero means it pays nothing and is never invoiced.
export function priceFor(tenant) {
  if (tenant?.plan_price != null) return Number(tenant.plan_price);
  return PLAN_PRICES[tenant?.tier] ?? PLAN_PRICES.starter;
}

export function addMonth(date) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + 1);
  // 31 January + 1 month is 3 March in JavaScript; keep it in February.
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d;
}

function random(n) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('');
}

export function payPageUrl(cfg, invoice) {
  return `${cfg.publicOrigin ?? ''}/billing/pay/${invoice.payment_ref}`;
}

const TENANT_FIELDS =
  'id,slug,name,tier,status,whatsapp_number,billing_status,paid_until,plan_price,auto_renew,next_tier,next_tier_at';

// On approval: the free period starts. Only once, so re-approving a store
// that was suspended does not hand it another trial.
export async function startTrial(cfg, tenantId, now = new Date()) {
  const tenant = await db(cfg).one('tenants', `id=eq.${tenantId}&select=${TENANT_FIELDS}`);
  if (!tenant || tenant.paid_until || priceFor(tenant) === 0) return tenant;
  await db(cfg).update(
    'tenants',
    `id=eq.${tenantId}&paid_until=is.null`,
    { billing_status: 'trial', paid_until: new Date(now.getTime() + TRIAL_DAYS * DAY).toISOString() },
    { returning: false }
  );
  return tenant;
}

// The invoice for the next month, opened REMIND_BEFORE_DAYS ahead (or at once,
// with force, for a store paying early). One per period: the unique
// (tenant_id, period_start) makes a second sweep find the first one.
export async function ensureInvoice(cfg, tenant, { now = new Date(), force = false } = {}) {
  const price = priceFor(tenant);
  if (!price || !tenant.paid_until) return null;

  const open = await db(cfg).one('plan_invoices', `tenant_id=eq.${tenant.id}&kind=eq.period&status=eq.open&select=*`);
  if (open) return open;

  const due = new Date(tenant.paid_until);
  if (!force && due.getTime() - now.getTime() > REMIND_BEFORE_DAYS * DAY) return null;

  // Paying for a month that starts where the paid time ends; a store that
  // was paused starts its new month from today rather than paying for the
  // weeks it was off.
  const start = tenant.billing_status === 'paused' && due < now ? now : due;
  // A downgrade the store asked for starts with this month: raise it at the
  // lower plan's price (lib/planChange.js).
  const lower = tenant.next_tier && tenant.next_tier_at && start >= new Date(tenant.next_tier_at);
  const tier = lower ? tenant.next_tier : tenant.tier;
  const row = {
    tenant_id: tenant.id,
    kind: 'period',
    tier,
    amount: lower && tenant.plan_price == null ? PLAN_PRICES[tier] : price,
    period_start: start.toISOString(),
    period_end: addMonth(start).toISOString(),
    status: 'open',
    payment_ref: `utb_${random(20)}`,
  };
  const created = await db(cfg).insert('plan_invoices', row, { onConflict: 'tenant_id,period_start' });
  return created ?? db(cfg).one('plan_invoices', `tenant_id=eq.${tenant.id}&kind=eq.period&status=eq.open&select=*`);
}

// An invoice paid, however it was paid. Only an open invoice matches, so a
// webhook and a return page arriving together settle it once.
export async function settleInvoice(cfg, invoice, { via, authorization = null, email = null, autoRenew = false, say = null } = {}) {
  // An upgrade paid on a link that was since replaced still counts: the money
  // arrived, so the plan it paid for applies.
  const payable = invoice.kind === 'upgrade' ? 'in.(open,void)' : 'eq.open';
  const rows = await db(cfg).update(
    'plan_invoices',
    `id=eq.${invoice.id}&status=${payable}`,
    { status: 'paid', paid_at: new Date().toISOString(), paid_via: via }
  );
  if (!rows.length) return { settled: false };

  // The difference for moving up a plan: the plan changes now, and what is
  // paid for runs to the same date as before.
  if (invoice.kind === 'upgrade') {
    const tenant = await db(cfg).one('tenants', `id=eq.${invoice.tenant_id}&select=${TENANT_FIELDS}`);
    // Never a step down: a store that has since reached a higher plan keeps it.
    if (tenant && TIERS.indexOf(invoice.tier) <= TIERS.indexOf(tenant.tier)) return { settled: true, upgraded: null };
    await applyTier(cfg, invoice.tenant_id, invoice.tier);
    if (say && tenant) {
      await say(
        tenant,
        `🚀 You're on *${cap(invoice.tier)}* now. Thanks for your payment of ${formatNaira(invoice.amount)}.\n\n` +
          `From your next renewal the plan is ${formatNaira(PLAN_PRICES[invoice.tier])} a month.`
      ).catch(() => {});
    }
    return { settled: true, upgraded: invoice.tier };
  }

  const tenant = await db(cfg).one('tenants', `id=eq.${invoice.tenant_id}&select=${TENANT_FIELDS}`);
  const wasPaused = tenant?.billing_status === 'paused';
  // A paused store paying gets a full month from today, not the remainder of
  // a month it spent switched off.
  const periodEnd = wasPaused ? addMonth(new Date()).toISOString() : invoice.period_end;
  const paidUntil =
    tenant?.paid_until && new Date(tenant.paid_until) > new Date(periodEnd) ? tenant.paid_until : periodEnd;

  const patch = { billing_status: 'active', paid_until: paidUntil };

  // A card paid through the pay page with "renew automatically" ticked is kept
  // for next month. Only a reusable authorization can be charged again.
  if (autoRenew && authorization?.reusable && authorization.authorization_code && email) {
    await db(cfg).insert(
      'billing_cards',
      {
        tenant_id: invoice.tenant_id,
        authorization_code: authorization.authorization_code,
        email,
        card_brand: authorization.card_type ?? authorization.brand ?? null,
        card_last4: authorization.last4 ?? null,
        exp_month: authorization.exp_month ?? null,
        exp_year: authorization.exp_year ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'tenant_id', merge: true, returning: false }
    );
    patch.auto_renew = true;
  }

  await db(cfg).update('tenants', `id=eq.${invoice.tenant_id}`, patch, { returning: false });

  if (say && tenant) {
    const until = new Date(paidUntil).toLocaleDateString('en-NG', { day: 'numeric', month: 'long' });
    await say(
      tenant,
      `✅ Plan paid: ${formatNaira(invoice.amount)} for *${cap(invoice.tier)}*, covered until ${until}.` +
        (wasPaused ? '\n\nYour store is live again. 🎉' : '') +
        (patch.auto_renew ? '\n\nIt will renew automatically with this card. Turn that off any time under Billing.' : '')
    ).catch(() => {});
  }

  return { settled: true, paidUntil };
}

// Charging the saved card for an invoice on its due date. A distinct
// reference per attempt, because Paystack will not reuse one, with the
// invoice carried in the metadata.
export async function chargeSavedCard(cfg, tenant, invoice, { say = null } = {}) {
  if (!cfg.paystackKey || !tenant.auto_renew) return false;
  const card = await db(cfg).one('billing_cards', `tenant_id=eq.${tenant.id}&select=*`);
  if (!card) return false;

  try {
    const res = await fetch('https://api.paystack.co/transaction/charge_authorization', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.paystackKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authorization_code: card.authorization_code,
        email: card.email,
        amount: nairaToKobo(invoice.amount),
        reference: `${invoice.payment_ref}_c${random(4)}`,
        metadata: { kind: 'plan', invoice_ref: invoice.payment_ref },
      }),
    });
    const body = await res.json().catch(() => null);
    if (res.ok && body?.status && body.data?.status === 'success') {
      await settleInvoice(cfg, invoice, { via: 'card', say });
      return true;
    }
    console.warn('plan card charge not successful:', body?.data?.gateway_response ?? body?.message);
    return false;
  } catch (err) {
    console.error('plan card charge failed:', err?.message ?? err);
    return false;
  }
}

// The hourly pass over every live store that pays a plan fee.
export async function billingSweep(cfg, { now = new Date(), say = null } = {}) {
  const tenants = await db(cfg).select(
    'tenants',
    `status=eq.active&paid_until=not.is.null&select=${TENANT_FIELDS}&limit=1000`
  );
  const out = { checked: 0, reminded: 0, charged: 0, paused: 0, downgraded: 0 };

  // An upgrade nobody paid for within a few days is dropped; the store can ask
  // again and gets a fresh amount for the days then left.
  await db(cfg)
    .update(
      'plan_invoices',
      `kind=eq.upgrade&status=eq.open&created_at=lt.${new Date(now.getTime() - 3 * DAY).toISOString()}`,
      { status: 'void' },
      { returning: false }
    )
    .catch((err) => console.error('billing sweep: voiding stale upgrades failed', err?.message ?? err));

  for (let tenant of tenants ?? []) {
    // A downgrade the store asked for, now that the time it paid for is over.
    if (tenant.next_tier && tenant.next_tier_at && now >= new Date(tenant.next_tier_at)) {
      try {
        await applyTier(cfg, tenant.id, tenant.next_tier);
        tenant = { ...tenant, tier: tenant.next_tier, next_tier: null, next_tier_at: null };
        out.downgraded += 1;
      } catch (err) {
        console.error('billing sweep: downgrade failed on', tenant.slug, err?.message ?? err);
      }
    }
    if (!priceFor(tenant)) continue;
    out.checked += 1;
    try {
      const invoice = await ensureInvoice(cfg, tenant, { now });
      if (!invoice) continue;

      const due = new Date(tenant.paid_until).getTime();
      const t = now.getTime();
      const stage = t < due ? 1 : t < due + 3 * DAY ? 2 : t < due + GRACE_DAYS * DAY ? 3 : 4;

      // Past due, and paused past the grace period.
      if (stage >= 2 && stage < 4 && tenant.billing_status !== 'past_due' && tenant.billing_status !== 'paused') {
        await db(cfg).update('tenants', `id=eq.${tenant.id}`, { billing_status: 'past_due' }, { returning: false });
      }
      if (stage === 4 && tenant.billing_status !== 'paused') {
        await db(cfg).update('tenants', `id=eq.${tenant.id}`, { billing_status: 'paused' }, { returning: false });
        out.paused += 1;
      }

      if ((invoice.reminder_stage ?? 0) >= stage) continue;

      // On the day, and once more in the grace period, a saved card is tried
      // before anybody is asked for anything.
      if ((stage === 2 || stage === 3) && tenant.auto_renew) {
        if (await chargeSavedCard(cfg, tenant, invoice, { say })) {
          out.charged += 1;
          continue;
        }
      }

      await db(cfg).update('plan_invoices', `id=eq.${invoice.id}`, { reminder_stage: stage }, { returning: false });
      if (say) await say(tenant, reminderMessage(cfg, tenant, invoice, stage)).catch(() => {});
      out.reminded += 1;
    } catch (err) {
      console.error('billing sweep: failed on', tenant.slug, err?.message ?? err);
    }
  }
  return out;
}

export function reminderMessage(cfg, tenant, invoice, stage) {
  const amount = formatNaira(invoice.amount);
  const plan = cap(invoice.tier);
  const link = payPageUrl(cfg, invoice);
  const when = new Date(tenant.paid_until).toLocaleDateString('en-NG', { day: 'numeric', month: 'long' });
  const trial = tenant.billing_status === 'trial';

  if (stage === 1) {
    return (
      `🗓️ ${trial ? 'Your free trial' : `Your ${plan} plan`} ends on ${when}. ` +
      `To keep ${tenant.name} running, pay ${amount} for the next month here:\n${link}`
    );
  }
  if (stage === 2) {
    return `⏰ Your ${plan} plan (${amount}) is due today. Pay here to keep ${tenant.name} running:\n${link}`;
  }
  if (stage === 3) {
    return (
      `⚠️ ${tenant.name}'s plan fee (${amount}) is overdue. ` +
      `Your store will be paused in a few days if it isn't paid:\n${link}`
    );
  }
  return (
    `⏸️ ${tenant.name} is paused because the plan fee (${amount}) wasn't paid. ` +
    `Your listings are saved. Pay here and it's back straight away:\n${link}`
  );
}

export function pausedMessage(cfg, tenant, invoice) {
  return (
    `⏸️ ${tenant.name} is paused until the plan fee is paid.` +
    (invoice ? ` Pay ${formatNaira(invoice.amount)} here and it's back straight away:\n${payPageUrl(cfg, invoice)}` : '')
  );
}

// Who to send billing messages to: the owner, on the platform number.
export function ownerChat(tenant) {
  return chatId(tenant?.whatsapp_number);
}

function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
