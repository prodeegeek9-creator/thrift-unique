import test from 'node:test';
import assert from 'node:assert/strict';

import { checkPetPhotos, loadPhotos, MAX_CHECKED, KINDS } from '../lib/petVision.js';

// Looking at the photos of a pet being listed. OpenAI is a stand-in; what is
// tested is what is asked of it and what is made of its answer.

const cfg = { openaiKey: 'sk-test', petVisionModel: null, petVisionDetail: null };
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

const answer = (photos, usage = { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 20 } }) =>
  new Response(JSON.stringify({ model: 'gpt-4o-mini-2024-07-18', choices: [{ message: { content: JSON.stringify({ photos }) } }], usage }), { status: 200 });

test('no key means no check, and no call', async () => {
  await withFetch(() => assert.fail('must not call'), async () => {
    assert.equal(await checkPetPhotos({ openaiKey: null }, [photo(1)]), null);
    assert.equal(await checkPetPhotos(cfg, [null, null]), null);
  });
});

test('the photos go out as images at low detail, asked for as strict JSON, and answers come back by position', async () => {
  await withFetch(
    () => answer([
      { index: 0, shows_pet: true, kind: 'dog', face_visible: true },
      { index: 1, shows_pet: false, kind: 'dog', face_visible: true },
    ]),
    async (calls) => {
      // The middle photo could not be read, so it is not sent; the answers still land on the right photos.
      const out = await checkPetPhotos(cfg, [photo(1), null, photo(3)]);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
      assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test');
      const sent = JSON.parse(calls[0].init.body);
      assert.equal(sent.model, 'gpt-4o-mini');
      assert.equal(sent.response_format.type, 'json_schema');
      assert.equal(sent.response_format.json_schema.strict, true);
      assert.deepEqual(sent.response_format.json_schema.schema.properties.photos.items.properties.kind.enum, KINDS);
      const content = sent.messages[0].content;
      assert.equal(content.length, 3);
      assert.match(content[0].text, /face_visible/);
      assert.equal(content[1].image_url.detail, 'low');
      assert.equal(content[1].image_url.url, `data:image/jpeg;base64,${btoa(String.fromCharCode(0xff, 0xd8, 1))}`);
      assert.deepEqual(out.verdicts, [
        { shows_pet: true, kind: 'dog', face_visible: true },
        null,
        // Not a pet means not an animal, whatever kind it said.
        { shows_pet: false, kind: 'not_an_animal', face_visible: true },
      ]);
      // What it used, as the AI log takes it.
      assert.deepEqual(
        { ...out.usage, prompt: undefined, response: undefined },
        { model: 'gpt-4o-mini-2024-07-18', images: 2, input_tokens: 100, cached_tokens: 20, output_tokens: 10, cost_usd: null, image_detail: 'low', prompt: undefined, response: undefined }
      );
      assert.match(out.usage.prompt, /pet-selling website/);
      assert.match(out.usage.response, /"photos"/);
    }
  );
});

test('a chosen model and photo size are used, and the cost is worked out when prices are set', async () => {
  const priced = { ...cfg, petVisionModel: 'gpt-x', petVisionDetail: 'high', priceInput: 0.15, priceCached: 0.075, priceOutput: 0.6 };
  await withFetch(() => answer([{ index: 0, shows_pet: true, kind: 'cat', face_visible: false }], { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 200 } }), async (calls) => {
    const out = await checkPetPhotos(priced, [photo(1)]);
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.model, 'gpt-x');
    assert.equal(sent.messages[0].content[1].image_url.detail, 'high');
    // 800 × 0.15 + 200 × 0.075 + 100 × 0.6, per million tokens
    assert.equal(out.usage.cost_usd, 0.000195);
    // An unknown size falls back to low.
    await checkPetPhotos({ ...cfg, petVisionDetail: 'ultra' }, [photo(1)]);
    assert.equal(JSON.parse(calls[1].init.body).messages[0].content[1].image_url.detail, 'low');
  });
});

test('anything that goes wrong says why, in a few words, and never throws', async () => {
  const cases = [
    [() => new Response('quota', { status: 429 }), /^OpenAI said HTTP 429$/],
    [() => new Response(JSON.stringify({ error: { message: 'Incorrect API key provided: sk-proj-********abcd. You can find your API key at https://platform.openai.com.' } }), { status: 401 }), /^OpenAI said HTTP 401: Incorrect API key provided: sk-… You can find/],
    [() => new Response(JSON.stringify({ error: { message: 'The model `gpt-x` does not exist' } }), { status: 404 }), /HTTP 404: The model `gpt-x` does not exist/],
    [() => new Response('not json', { status: 200 }), /answer could not be read/],
    [() => new Response(JSON.stringify({ choices: [] }), { status: 200 }), /answer could not be read/],
    [() => new Response(JSON.stringify({ choices: [{ message: { refusal: 'no', content: null } }] }), { status: 200 }), /answer could not be read/],
    [() => new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), { status: 200 }), /answer could not be read/],
    [() => answer('nope'), /answer could not be read/],
    [() => { throw new TypeError('network down'); }, /^could not reach OpenAI \(network down\)$/],
  ];
  for (const [handler, expected] of cases) {
    await withFetch(handler, async () => {
      const out = await checkPetPhotos(cfg, [photo(1)]);
      assert.equal(out.verdicts, undefined);
      assert.match(out.error, expected);
      // A key never travels in the explanation.
      assert.doesNotMatch(out.error, /sk-proj|sk-[a-z0-9]{6}/i);
    });
  }
  // One bad entry spoils only itself.
  await withFetch(
    () => answer([{ index: 0, shows_pet: true, kind: 'unicorn', face_visible: true }, { index: 1, shows_pet: true, kind: 'cat', face_visible: false }]),
    async () => {
      const out = await checkPetPhotos(cfg, [photo(1), photo(2)]);
      assert.deepEqual(out.verdicts, [null, { shows_pet: true, kind: 'cat', face_visible: false }]);
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
