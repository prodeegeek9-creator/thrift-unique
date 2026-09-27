import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Rules of the codebase that a test can hold it to.

const worker = join(dirname(fileURLToPath(import.meta.url)), '..');

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'test' ? [] : sources(path);
    return path.endsWith('.js') ? [path] : [];
  });
}

test('the Worker never selects *: every read names its columns (lib/columns.js)', () => {
  const offenders = sources(worker).flatMap((path) =>
    readFileSync(path, 'utf8')
      .split('\n')
      .map((line, i) => [line, i + 1])
      .filter(([line]) => /select=\*/.test(line) && !/^\s*\/\//.test(line))
      .map(([, n]) => `${path.slice(worker.length + 1)}:${n}`)
  );
  assert.deepEqual(offenders, []);
});
