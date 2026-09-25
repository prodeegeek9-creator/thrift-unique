import { db, SupabaseError } from './supabase.js';
import { generateInvite } from './accounts.js';
import { COMMISSION, DISCLAIMER_VERSION } from './bot.js';

// Creating a store, and later giving it an owner.
//
// Two moments, deliberately apart. The store is created as soon as a seller
// finishes the sign-up conversation, so their number is claimed and the bot
// can tell them it is waiting. The login is created only when the operator
// approves it, so a sign-up that is turned down leaves no account behind.

const TIERS = ['starter', 'growth', 'business'];

// "Ada's Thrift & Vintage!" → "adas-thrift-vintage". The slug is in every
// shared product link, so it has to be something a person could read.
export function slugFor(name) {
  const base = String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return base.length >= 3 ? base : `store-${base}`.replace(/-+$/, '');
}

async function freeSlug(cfg, name) {
  const base = slugFor(name);
  for (let i = 0; i < 5; i += 1) {
    const slug = i === 0 ? base : `${base}-${Math.floor(1000 + Math.random() * 9000)}`;
    const taken = await db(cfg).one('tenants', `slug=eq.${encodeURIComponent(slug)}&select=id`);
    if (!taken) return slug;
  }
  throw new Error(`no free slug for ${base}`);
}

// A new store, waiting for approval: status 'onboarding', the chosen plan's
// features and commission, the terms its owner accepted, and the sender's
// number as the store's number.
//
// Reaching here means the terms were accepted: the sign-up conversation only
// asks for provisioning after a YES to them.
export async function provisionStore(cfg, { phone, name, storeType = null, category = null, tier }) {
  const plan = TIERS.includes(tier) ? tier : 'starter';
  const slug = await freeSlug(cfg, name);

  let tenant;
  try {
    tenant = await db(cfg).insert('tenants', {
      slug,
      name,
      tier: plan,
      status: 'onboarding',
      whatsapp_number: phone,
      store_type: storeType,
      category,
      commission_pct: COMMISSION[plan],
      disclaimer_accepted_at: new Date().toISOString(),
      disclaimer_version: DISCLAIMER_VERSION,
    });
  } catch (err) {
    // The number is unique. Losing that race means the store already exists,
    // which is the outcome that was wanted.
    if (err instanceof SupabaseError && err.status === 409) {
      const existing = await db(cfg).one(
        'tenants',
        `whatsapp_number=eq.${phone}&select=id,slug,name,status`
      );
      if (existing) return existing;
    }
    throw err;
  }

  await db(cfg).rpc('seed_tenant_features', { target: tenant.id, plan });
  return tenant;
}

// The owner, at approval.
//
// An email with no account gets one, and a set-password link to send. An email
// that already has an account gets the membership and no link: a login link
// for somebody's existing account must never be handed to whoever typed their
// address into a WhatsApp chat.
//
// Returns null for a store with no sign-up on record — one seeded by hand —
// which is approved without anybody being created or told.
export async function approveStore(cfg, tenant, { origin } = {}) {
  if (!tenant.whatsapp_number) return null;

  const signup = await db(cfg).one(
    'signups',
    `phone=eq.${tenant.whatsapp_number}&state=eq.pending&select=phone,chat_id,business_name,email`
  );
  if (!signup?.email) return null;

  // Idempotent (on conflict do nothing), and it repairs a store whose
  // provisioning died between the insert and the seed.
  await db(cfg).rpc('seed_tenant_features', {
    target: tenant.id,
    plan: TIERS.includes(tenant.tier) ? tenant.tier : 'starter',
  });

  const existing = await db(cfg).rpc('user_id_for_email', { addr: signup.email });
  let userId = typeof existing === 'string' ? existing : null;
  let link = null;

  if (!userId) {
    const created = await generateInvite(cfg, signup.email, {
      redirectTo: origin ? `${origin}/dashboard` : null,
      data: { invited_to: tenant.id },
    });
    if (!created?.userId) throw new Error('generate_link returned no user');
    userId = created.userId;
    link = created.link;
  }

  const now = new Date().toISOString();
  await db(cfg).insert(
    'tenant_members',
    {
      tenant_id: tenant.id,
      user_id: userId,
      role: 'owner',
      email: signup.email,
      invited_at: now,
      // They asked for this store; there is nothing left for them to accept.
      accepted_at: now,
    },
    { onConflict: 'tenant_id,user_id', returning: false }
  );

  return { signup, link, existingAccount: !link };
}
