-- The three WhatsApp tables have RLS on and no policies, which already denies
-- every client read. They also still carry Supabase's default grant to
-- `authenticated`, which 0010 and 0012 did not remove.
--
-- That grant is currently harmless: with RLS enabled and no policy, Postgres
-- returns nothing regardless of the privilege. It is removed anyway, for the
-- same reason channel_connections has neither. The two are separate locks —
-- the grant is what the role holds, the policy is what it may see with it —
-- and the day somebody adds a policy to one of these tables to solve some
-- narrow problem, the grant is what decides whether that mistake is contained.
--
-- This is the fourth time a default grant in this schema has turned out to be
-- doing something nobody wrote down (0004, 0005, 0007), so the rule is worth
-- stating plainly: adding a table to `public` grants it to `authenticated`
-- unless you say otherwise, and adding a column to a granted table publishes
-- that column.

revoke all on public.whatsapp_secrets from anon, authenticated;
revoke all on public.bot_conversations from anon, authenticated;
revoke all on public.bot_messages from anon, authenticated;

-- service_role is untouched: it is what the Worker connects as, and it is the
-- only thing that reads any of these.
