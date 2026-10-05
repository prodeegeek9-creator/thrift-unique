-- What the owner typed when the bot stepped back from a chat.
--
-- A chat is addressed by WhatsApp's privacy id (…@lid), which names nobody, so
-- the dashboard's list of chats on hold shows this beside each one: "You:
-- 'I'll send you the account number'" tells the owner which chat it is.
alter table public.bot_conversations
  add column if not exists paused_note text;
