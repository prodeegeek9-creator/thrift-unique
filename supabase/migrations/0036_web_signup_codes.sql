-- Signing up on the web, then opening the store on WhatsApp.
--
-- An account made on the website (email and password, or Google) has no
-- store: a store is opened by messaging the platform bot from the number it
-- will run on, which is what proves the seller has that number. The web's
-- "Set up your store on WhatsApp" button types a code into that chat, and the
-- code is how the bot knows which account the store is for, instead of asking
-- for an email a seller can mistype into a second account
-- (worker/routes/signup.js, signupStep in worker/lib/bot.js).
--
-- One code per account. Used by the first number that sends it, and only by
-- that number after that: a code forwarded to somebody else can't attach a
-- second store to the account.
create table public.web_signup_codes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  code text not null unique check (code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  email text not null,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  used_phone text
);

-- Written and read by the Worker under the service key only.
alter table public.web_signup_codes enable row level security;
revoke all on public.web_signup_codes from anon, authenticated;
