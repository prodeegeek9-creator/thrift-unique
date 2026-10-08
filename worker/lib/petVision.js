// Looking at the photos somebody sends of a pet they want to list (lib/petIntake.js):
// is a real animal the subject, which kind, and can its face be seen?
//
// One call to a vision model for a batch of photos. It is a convenience for
// the seller and a filter for the store, never a gate that can stop listings:
// anything that goes wrong (no key, a timeout, an answer that is not what was
// asked for) returns null, and the conversation carries on unchecked.

export const DEFAULT_VISION_MODEL = 'gemini-2.5-flash';

// More than this and the request gets large for little gain: the first photos
// are the ones buyers see.
export const MAX_CHECKED = 4;
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

export const KINDS = ['dog', 'cat', 'bird', 'rabbit', 'fish', 'reptile', 'rodent', 'other_animal', 'not_an_animal'];

const PROMPT =
  'You check photos for a pet-selling website in Nigeria. There are several images, in order. ' +
  'For each one, answer:\n' +
  '- shows_pet: true only if a real, live animal that could be a pet is clearly the main subject. ' +
  'False for people, screenshots, text, memes, drawings, toys, products, food, or no animal.\n' +
  `- kind: one of ${KINDS.join(', ')}. Use not_an_animal when shows_pet is false.\n` +
  "- face_visible: true only if the animal's face (eyes and nose) is clearly visible and in focus. " +
  'False if it faces away, is hidden, cropped, blurred or too far away to see its face.\n' +
  'Answer for every image, using its position as index starting at 0.';

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    photos: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          index: { type: 'INTEGER' },
          shows_pet: { type: 'BOOLEAN' },
          kind: { type: 'STRING', enum: KINDS },
          face_visible: { type: 'BOOLEAN' },
        },
        required: ['index', 'shows_pet', 'kind', 'face_visible'],
      },
    },
  },
  required: ['photos'],
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

// photos: [{ bytes, type } | null] → [{ shows_pet, kind, face_visible } | null],
// one per photo, or null when the whole check could not be done.
export async function checkPetPhotos(cfg, photos) {
  if (!cfg.petVisionKey) return null;
  const usable = photos.map((p, i) => ({ p, i })).filter(({ p }) => p);
  if (!usable.length) return null;

  try {
    const model = cfg.petVisionModel || DEFAULT_VISION_MODEL;
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.petVisionKey },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: PROMPT },
              ...usable.map(({ p }) => ({ inline_data: { mime_type: p.type, data: toBase64(p.bytes) } })),
            ],
          },
        ],
        generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      console.error('pet photo check refused:', res.status, (await res.text().catch(() => '')).slice(0, 200));
      return null;
    }

    const body = await res.json();
    const text = (body?.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? '').join('');
    const answers = JSON.parse(text)?.photos;
    if (!Array.isArray(answers)) return null;

    // Answers are by position among the photos sent; put them back by the
    // photo's own position.
    const out = photos.map(() => null);
    for (const a of answers) {
      const original = usable[a?.index]?.i;
      if (original === undefined || !KINDS.includes(a.kind) || typeof a.shows_pet !== 'boolean') continue;
      out[original] = { shows_pet: a.shows_pet, kind: a.shows_pet ? a.kind : 'not_an_animal', face_visible: a.face_visible === true };
    }
    return out;
  } catch (err) {
    console.error('pet photo check failed:', err?.message ?? err);
    return null;
  }
}
