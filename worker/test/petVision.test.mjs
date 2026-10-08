import test from 'node:test';
import assert from 'node:assert/strict';

import { checkPetPhotos, loadPhotos, MAX_CHECKED } from '../lib/petVision.js';

// Looking at the photos of a pet being listed. The model is a stand-in; what
// is tested is what is asked of it and what is made of its answer.

const cfg = { petVisionKey: 'key-123', petVisionModel: null };
const photo = (n) => ({ bytes: new Uint8Array([0xff, 0xd8, n]), type: 'image/jpeg' });

function withFetch(handler, run) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  return Promise.resolve(run(calls)).finally(() => { globalThis.fetch = real; });
}

const answer = (photos) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ photos }) }] } }] }), { status: 200 });

test('no key means no check, and no call', async () => {
  await withFetch(() => assert.fail('must not call'), async () => {
    assert.equal(await checkPetPhotos({ petVisionKey: null }, [photo(1)]), null);
    assert.equal(await checkPetPhotos(cfg, [null, null]), null);
  });
});

test('the photos go out as images with the key in a header, and answers come back by position', async () => {
  await withFetch(
    () => answer([
      { index: 0, shows_pet: true, kind: 'dog', face_visible: true },
      { index: 1, shows_pet: false, kind: 'dog', face_visible: true },
    ]),
    async (calls) => {
      // The middle photo could not be read, so it is not sent; the answers still land on the right photos.
      const out = await checkPetPhotos(cfg, [photo(1), null, photo(3)]);
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /\/models\/gemini-2\.5-flash:generateContent$/);
      assert.equal(calls[0].init.headers['x-goog-api-key'], 'key-123');
      const parts = JSON.parse(calls[0].init.body).contents[0].parts;
      assert.equal(parts.length, 3);
      assert.match(parts[0].text, /face_visible/);
      assert.equal(parts[1].inline_data.mime_type, 'image/jpeg');
      assert.equal(parts[1].inline_data.data, btoa(String.fromCharCode(0xff, 0xd8, 1)));
      assert.deepEqual(out, [
        { shows_pet: true, kind: 'dog', face_visible: true },
        null,
        // Not a pet means not an animal, whatever kind it said.
        { shows_pet: false, kind: 'not_an_animal', face_visible: true },
      ]);
    }
  );
});

test('a chosen model is used', async () => {
  await withFetch(() => answer([{ index: 0, shows_pet: true, kind: 'cat', face_visible: false }]), async (calls) => {
    await checkPetPhotos({ ...cfg, petVisionModel: 'gemini-x' }, [photo(1)]);
    assert.match(calls[0].url, /models\/gemini-x:generateContent/);
  });
});

test('anything that goes wrong is no answer, never an error', async () => {
  const cases = [
    () => new Response('quota', { status: 429 }),
    () => new Response('not json', { status: 200 }),
    () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }),
    () => answer('nope'),
    () => { throw new TypeError('network down'); },
  ];
  for (const handler of cases) {
    await withFetch(handler, async () => assert.equal(await checkPetPhotos(cfg, [photo(1)]), null));
  }
  // One bad entry spoils only itself.
  await withFetch(
    () => answer([{ index: 0, shows_pet: true, kind: 'unicorn', face_visible: true }, { index: 1, shows_pet: true, kind: 'cat', face_visible: false }]),
    async () => {
      assert.deepEqual(await checkPetPhotos(cfg, [photo(1), photo(2)]), [null, { shows_pet: true, kind: 'cat', face_visible: false }]);
    }
  );
});

test('saved photos are read back, and only what is a usable image counts', async () => {
  const big = new Uint8Array(4 * 1024 * 1024 + 1);
  await withFetch(
    (url) => {
      if (url.endsWith('/ok.png')) return new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/png; charset=x' } });
      if (url.endsWith('/gone.jpg')) return new Response('', { status: 404 });
      if (url.endsWith('/big.jpg')) return new Response(big, { headers: { 'content-type': 'image/jpeg' } });
      if (url.endsWith('/page.jpg')) return new Response('<html>', { headers: { 'content-type': 'text/html' } });
      throw new TypeError('down');
    },
    async () => {
      const out = await loadPhotos(['https://x/ok.png', 'https://x/gone.jpg', 'https://x/big.jpg', 'https://x/boom.jpg']);
      assert.equal(out[0].type, 'image/png');
      assert.deepEqual([...out[0].bytes], [1, 2]);
      assert.deepEqual(out.slice(1), [null, null, null]);
      // A page that is not an image is not one.
      assert.deepEqual(await loadPhotos(['https://x/page.jpg']), [null]);
      // Only the first few are ever read.
      assert.equal((await loadPhotos(Array.from({ length: MAX_CHECKED + 3 }, () => 'https://x/ok.png'))).length, MAX_CHECKED);
    }
  );
});
