import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createGzip } from 'node:zlib';
import tar from 'tar-stream';
import { validateTgz } from '../../src/rules/validateTgz.ts';

async function createTgz(entries: { name: string, content: string }[]) {
  const pack = tar.pack();
  for (const { name, content } of entries) {
    pack.entry({ name }, content);
  }
  pack.finalize();

  const gzip = createGzip();
  const chunks: Buffer[] = [];
  return await new Promise<Buffer>((resolve, reject) => {
    pack.pipe(gzip)
      .on('data', chunk => chunks.push(chunk))
      .on('end', () => resolve(Buffer.concat(chunks)))
      .on('error', reject);
  });
}

// validateTgz expects a PassThrough (the upload tee) — it ends/destroys it itself
function toStream(buf: Buffer) {
  const pass = new PassThrough();
  pass.end(buf);
  return pass;
}

test('accepts valid tgz archive', async () => {
  const buf = await createTgz([{ name: 'file.txt', content: 'hello' }]);
  await assert.doesNotReject(() => validateTgz(toStream(buf)));
});

test('rejects archive with path traversal', async () => {
  const buf = await createTgz([{ name: '../evil.txt', content: 'bad' }]);
  await assert.rejects(() => validateTgz(toStream(buf)));
});

test('rejects archive with too many files', async () => {
  const entries = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, content: 'x' }));
  const buf = await createTgz(entries);
  await assert.rejects(() => validateTgz(toStream(buf), { maxFiles: 3 }));
});

test('rejects a file that exceeds maxFileSize', async () => {
  const buf = await createTgz([{ name: 'big.txt', content: 'x'.repeat(1000) }]);
  await assert.rejects(() => validateTgz(toStream(buf), { maxFileSize: 100 }));
});

test('captures top-level LICENSE text during validation', async () => {
  const buf = await createTgz([
    { name: 'LICENSE', content: 'MIT License text here' },
    { name: 'src/init.luau', content: 'return {}' },
  ]);
  const licenseCapture: { text?: string } = {};
  await validateTgz(toStream(buf), { licenseCapture });
  assert.equal(licenseCapture.text, 'MIT License text here');
});
