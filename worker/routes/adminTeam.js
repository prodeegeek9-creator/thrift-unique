import { db } from '../lib/supabase.js';
import { json } from '../lib/http.js';
import { audit } from '../lib/operator.js';
import { EMAIL, generateInvite } from '../lib/accounts.js';

// The admin team: who can open the platform console, and at what level.
//
// Reached only through handleAdmin, after requireOperator, so reading needs
// any operator and every change needs an owner (a POST under /api/admin).
//
// Nobody changes or removes themselves here. Demoting yourself by accident is
// how a platform ends up with no owner at all, and an owner who wants out can
// ask another owner. Past that, the last owner cannot be removed or demoted by
// anybody, which is the same rule seen from the other side.
//
// Sign-in links are handed back to the console to copy, not sent: the person
// adding a colleague knows how to reach them, and nothing here depends on the
// project's email being set up. The link lands on /admin/login, where the
// console's own session picks it up (src/lib/adminAuth.jsx).

const LEVELS = ['support', 'owner'];

export async function listTeam(cfg, op) {
  const rows = await db(cfg).select(
    'platform_admins',
    'select=user_id,level,email,note,created_at&order=created_at.asc'
  );
  return json({
    me: op.userId,
    team: rows.map((r) => ({ ...r, you: r.user_id === op.userId })),
  });
}

// POST /api/admin/team { email, level }
export async function addToTeam(request, cfg, op) {
  const body = await request.json().catch(() => ({}));
  const email = String(body?.email ?? '').trim().toLowerCase();
  const level = body?.level ?? 'support';

  if (!EMAIL.test(email)) return json({ error: 'Enter their email address.' }, 400);
  if (!LEVELS.includes(level)) return json({ error: 'Choose support or owner.' }, 400);

  const existingId = await db(cfg).rpc('user_id_for_email', { addr: email });
  let userId = typeof existingId === 'string' ? existingId : null;
  let link = null;

  if (userId) {
    const already = await db(cfg).one('platform_admins', `user_id=eq.${userId}&select=level`);
    if (already) return json({ error: 'They are already on the admin team.' }, 409);
  } else {
    try {
      const created = await generateInvite(cfg, email, { redirectTo: consoleUrl(cfg) });
      userId = created?.userId ?? null;
      link = created?.link ?? null;
    } catch (err) {
      console.error('admin invite failed:', err?.message ?? err);
    }
    if (!userId) return json({ error: 'Could not create their account just now. Try again shortly.' }, 502);
  }

  await db(cfg).insert(
    'platform_admins',
    { user_id: userId, level, email, added_by: op.userId },
    { onConflict: 'user_id', returning: false }
  );
  await audit(cfg, op.userId, 'team.add', { subject: email, detail: { level, new_account: Boolean(link) } });

  // An existing account signs in with the password it already has.
  return json({ ok: true, status: link ? 'invited' : 'added', email, level, link });
}

// POST /api/admin/team/:userId { level } | { remove: true }
export async function changeTeam(request, cfg, op, userId) {
  const body = await request.json().catch(() => ({}));

  if (userId === op.userId) {
    return json({ error: "You can't change your own access. Ask another owner." }, 409);
  }

  const member = await db(cfg).one('platform_admins', `user_id=eq.${userId}&select=user_id,level,email`);
  if (!member) return json({ error: 'Not on the admin team.' }, 404);

  const remove = body?.remove === true;
  const level = body?.level;
  if (!remove && !LEVELS.includes(level)) return json({ error: 'Choose support or owner.' }, 400);
  if (!remove && level === member.level) return json({ ok: true, level });

  if (member.level === 'owner' && (remove || level !== 'owner')) {
    const owners = await db(cfg).select('platform_admins', 'level=eq.owner&select=user_id');
    if (owners.length <= 1) return json({ error: 'The platform needs at least one owner.' }, 409);
  }

  if (remove) {
    await db(cfg).del('platform_admins', `user_id=eq.${userId}`);
    await audit(cfg, op.userId, 'team.remove', { subject: member.email ?? userId, detail: { level: member.level } });
    return json({ ok: true, removed: true });
  }

  await db(cfg).update('platform_admins', `user_id=eq.${userId}`, { level }, { returning: false });
  await audit(cfg, op.userId, 'team.level', {
    subject: member.email ?? userId,
    detail: { from: member.level, to: level },
  });
  return json({ ok: true, level });
}

// POST /api/admin/team/:userId/link
//
// A fresh sign-in link for a colleague who never used their invitation, or has
// forgotten their password. Opening it lets them choose a new one.
export async function teamLink(cfg, op, userId) {
  const member = await db(cfg).one('platform_admins', `user_id=eq.${userId}&select=user_id,email`);
  if (!member) return json({ error: 'Not on the admin team.' }, 404);
  if (!member.email) return json({ error: 'No email on file for them.' }, 409);

  let link = null;
  try {
    ({ link } = await generateInvite(cfg, member.email, { type: 'recovery', redirectTo: consoleUrl(cfg) }));
  } catch (err) {
    console.error('admin link failed:', err?.message ?? err);
  }
  if (!link) return json({ error: 'Could not make a link just now. Try again shortly.' }, 502);

  await audit(cfg, op.userId, 'team.link', { subject: member.email });
  return json({ ok: true, link });
}

function consoleUrl(cfg) {
  return cfg.publicOrigin ? `${cfg.publicOrigin}/admin/login` : null;
}
