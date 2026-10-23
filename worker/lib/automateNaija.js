// Automate Naija's student alerts go out from the platform number (see
// borrowedChat() in routes/waha.js). A student turns them on by sending this
// number a message with a one-time code: "Turn on my Automate Naija WhatsApp
// alerts. Code: AN-7K3P9Q". Writing first is the point; WhatsApp restricts a
// number that messages people who never wrote to it.
//
// What a code means, and every word of the reply, belong to Automate Naija:
// confirm_whatsapp_optin() in automate-naija-app,
// supabase/migrations/20261106_whatsapp_optin.sql. This file only carries the
// code and the sender's number there and brings the reply back.

// AN- and six characters from 32, the same alphabet as a web sign-up code
// (lib/bot.js WEB_CODE), which is VW- instead.
export const OPTIN_CODE = /\bAN-([A-HJ-NP-Z2-9]{6})\b/i;

export function optinCodeIn(text) {
  return OPTIN_CODE.exec(String(text ?? ''))?.[1]?.toUpperCase() ?? null;
}

export function optinConfigured(cfg) {
  return Boolean(cfg.automateNaijaUrl && cfg.automateNaijaKey);
}

// → the reply Automate Naija wants sent, or null when it could not be asked.
// Called with the project's public key: the function is open to anyone with
// a code, and a code is the only thing that turns alerts on.
export async function confirmOptin(cfg, code, phone) {
  try {
    const res = await fetch(`${cfg.automateNaijaUrl}/rest/v1/rpc/confirm_whatsapp_optin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: cfg.automateNaijaKey,
        Authorization: `Bearer ${cfg.automateNaijaKey}`,
      },
      body: JSON.stringify({ p_code: `AN-${code}`, p_phone: phone }),
    });
    if (!res.ok) {
      console.warn('automate naija opt-in refused:', res.status, (await res.text().catch(() => '')).slice(0, 200));
      return null;
    }
    const data = await res.json().catch(() => null);
    return typeof data?.reply === 'string' && data.reply.trim() ? data.reply : null;
  } catch (err) {
    console.warn('automate naija opt-in unreachable:', err?.message ?? err);
    return null;
  }
}
