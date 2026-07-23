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

// ---- entryInspector hook (uefn platform branch) ------------------------------

test('entryInspector.inspectName rejects the archive mid-extraction', async () => {
  const buf = await createTgz([
    { name: 'ok.verse', content: 'F():void = {}' },
    { name: 'bad.lua', content: 'return {}' },
  ]);
  await assert.rejects(
    () => validateTgz(toStream(buf), {
      entryInspector: { inspectName: (name) => name.endsWith('.lua') ? `nope: ${name}` : null },
    }),
    /nope: bad\.lua/,
  );
});

test('entryInspector capture delivers exact contents while LICENSE capture still works', async () => {
  const buf = await createTgz([
    { name: 'LICENSE', content: 'MIT License text here' },
    { name: 'Calc.verse', content: 'Double<public>(X:int):int = X + X' },
    { name: 'README.md', content: '# not captured' },
  ]);
  const licenseCapture: { text?: string } = {};
  const captured = new Map<string, string>();
  await validateTgz(toStream(buf), {
    licenseCapture,
    entryInspector: {
      shouldCapture: (name) => name.endsWith('.verse'),
      onFile: (name, content) => { captured.set(name, content); },
    },
  });
  assert.equal(licenseCapture.text, 'MIT License text here');
  assert.equal(captured.size, 1);
  assert.equal(captured.get('Calc.verse'), 'Double<public>(X:int):int = X + X');
});

test('entryInspector per-file capture cap overflow fails the archive (never truncates)', async () => {
  const buf = await createTgz([
    { name: 'big.verse', content: 'x'.repeat(1000) },
  ]);
  await assert.rejects(
    () => validateTgz(toStream(buf), {
      entryInspector: {
        shouldCapture: (name) => name.endsWith('.verse'),
        onFile: () => {},
        maxCaptureBytes: 100,
      },
    }),
    /too large to scan/,
  );
});

test('no inspector: behavior identical to before the hook existed', async () => {
  const buf = await createTgz([{ name: 'anything.xyz', content: 'bytes' }]);
  await assert.doesNotReject(() => validateTgz(toStream(buf)));
});
