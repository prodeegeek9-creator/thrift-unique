// Looking at the photos somebody sends of a pet they want to list (lib/petIntake.js):
// is a real animal the subject, which kind, and can its face be seen?
//
// One call to OpenAI, like the item photo review, for a batch of photos. It is
// a convenience for the seller and a filter for the store, never a gate that
// can stop listings: anything that goes wrong (no key, a timeout, an answer
// that is not what was asked for) returns null, and the conversation carries
// on unchecked.

export const DEFAULT_VISION_MODEL = 'gpt-4o-mini';
// 'low' is one 512px view and a small fixed number of tokens a photo; 'high'
// reads a WhatsApp photo as tiles and costs thirty thousand or so. Whether a
// pet is in the picture and its face shows does not need the detail.
export const DEFAULT_DETAIL = 'low';
export const DETAILS = ['low', 'high', 'auto'];

// More than this and the request gets large for little gain: the first photos
// are the ones buyers see.
export const MAX_CHECKED = 4;
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

export const KINDS = ['dog', 'cat', 'bird', 'rabbit', 'fish', 'reptile', 'rodent', 'other_animal', 'not_an_animal'];

export const PROMPT =
  'You check photos for a pet-selling website in Nigeria. There are several images, in order. ' +
  'For each one, answer:\n' +
  '- shows_pet: true only if a real, live animal that could be a pet is clearly the main subject. ' +
  'False for people, screenshots, text, memes, drawings, toys, products, food, or no animal.\n' +
  `- kind: one of ${KINDS.join(', ')}. Use not_an_animal when shows_pet is false.\n` +
  "- face_visible: true only if the animal's face (eyes and nose) is clearly visible and in focus. " +
  'False if it faces away, is hidden, cropped, blurred or too far away to see its face.\n' +
  'Answer for every image, using its position as index starting at 0.';

// OpenAI's strict structured output: every property required, no extras.
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['photos'],
  properties: {
    photos: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'shows_pet', 'kind', 'face_visible'],
        properties: {
          index: { type: 'integer' },
          shows_pet: { type: 'boolean' },
          kind: { type: 'string', enum: KINDS },
          face_visible: { type: 'boolean' },
        },
      },
    },
  },
};

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// Fetch the photos we have already saved. A photo that cannot be read is
// left unchecked (null), not refused.
export async function loadPhotos(urls) {
  return Promise.all(
    urls.slice(0, MAX_CHECKED).map(async (url) => {
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const bytes = new Uint8Array(await res.arrayBuffer());
        const type = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
        if (!bytes.byteLength || bytes.byteLength > MAX_PHOTO_BYTES || !type.startsWith('image/')) return null;
        return { bytes, type };
      } catch {
        return null;
      }
    })
  );
}

// What a call cost, in the shape ai_usage takes, priced when the Worker has the
// same per-million prices the photo-review service uses.
export function cost(cfg, input, cached, output) {
  const { priceInput, priceCached, priceOutput } = cfg;
  if (![priceInput, priceCached, priceOutput].every((n) => Number.isFinite(n))) return null;
  return Number((((input - cached) * priceInput + cached * priceCached + output * priceOutput) / 1e6).toFixed(6));
}

// What OpenAI said was wrong, in a few words and never with a key in it.
function reason(text) {
  let message = '';
  try {
    message = JSON.parse(text)?.error?.message ?? '';
  } catch { /* not JSON */ }
  return String(message).replace(/sk-[A-Za-z0-9_*.-]+/g, 'sk-…').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// photos: [{ bytes, type } | null] →
//   { verdicts: [{ shows_pet, kind, face_visible } | null, …], usage } — one verdict per photo;
//   { error } — a few words on why the check could not be done, for whoever has to fix it;
//   null when there was nothing to check (no key, no photo that could be read).
export async function checkPetPhotos(cfg, photos) {
  if (!cfg.openaiKey) return null;
  const usable = photos.map((p, i) => ({ p, i })).filter(({ p }) => p);
  if (!usable.length) return null;

  const model = cfg.petVisionModel || DEFAULT_VISION_MODEL;
  const detail = DETAILS.includes(cfg.petVisionDetail) ? cfg.petVisionDetail : DEFAULT_DETAIL;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.openaiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPT },
              ...usable.map(({ p }) => ({
                type: 'image_url',
                image_url: { url: `data:${p.type};base64,${toBase64(p.bytes)}`, detail },
              })),
            ],
          },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'pet_photos', strict: true, schema: SCHEMA } },
        max_completion_tokens: 500,
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) {
      const why = reason(await res.text().catch(() => ''));
      console.error('pet photo check refused:', res.status, why);
      return { error: `OpenAI said HTTP ${res.status}${why ? `: ${why}` : ''}` };
    }

    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content;
    const answers = typeof text === 'string' ? JSON.parse(text)?.photos : null;
    if (!Array.isArray(answers)) return { error: "OpenAI's answer could not be read" };

    // Answers are by position among the photos sent; put them back by the
    // photo's own position.
    const verdicts = photos.map(() => null);
    for (const a of answers) {
      const original = usable[a?.index]?.i;
      if (original === undefined || !KINDS.includes(a.kind) || typeof a.shows_pet !== 'boolean') continue;
      verdicts[original] = { shows_pet: a.shows_pet, kind: a.shows_pet ? a.kind : 'not_an_animal', face_visible: a.face_visible === true };
    }

    const u = body.usage ?? {};
    const input = u.prompt_tokens ?? 0;
    const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
    const output = u.completion_tokens ?? 0;
    return {
      verdicts,
      usage: {
        model: body.model || model,
        images: usable.length,
        input_tokens: input,
        cached_tokens: cached,
        output_tokens: output,
        cost_usd: cost(cfg, input, cached, output),
        image_detail: detail,
        prompt: PROMPT,
        response: text.slice(0, 20_000),
      },
    };
  } catch (err) {
    console.error('pet photo check failed:', err?.message ?? err);
    return { error: err instanceof SyntaxError ? "OpenAI's answer could not be read" : `could not reach OpenAI (${String(err?.message ?? err).slice(0, 80)})` };
  }
}
