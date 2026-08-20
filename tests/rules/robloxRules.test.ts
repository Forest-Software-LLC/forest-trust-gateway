import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createGzip } from 'node:zlib';
import tar from 'tar-stream';
import { validateTgz } from '../../src/rules/validateTgz.ts';
import {
    checkRobloxEntryName,
    makeRobloxScanState,
    makeRobloxEntryInspector,
    validateRobloxPackage,
} from '../../src/rules/robloxRules.ts';
import { buildRbxm } from '../rbxmFixture.ts';

async function createTgz(entries: { name: string, content: string | Buffer }[]) {
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

function toStream(buf: Buffer) {
  const pass = new PassThrough();
  pass.end(buf);
  return pass;
}

// Comfortably over the 256-byte code floor
const REAL_CODE = { name: 'src/init.luau', content: '-- real module\n' + 'local x = 1\n'.repeat(40) + 'return x\n' };

async function runRobloxScan(entries: { name: string, content: string | Buffer }[]) {
  const buf = await createTgz(entries);
  const state = makeRobloxScanState();
  await validateTgz(toStream(buf), { entryInspector: makeRobloxEntryInspector(state) });
  return { state, errors: validateRobloxPackage(state) };
}

// --- runtime-script filename rules -------------------------------------------

test('rejects every runtime-script suffix variant', () => {
    for (const name of [
        'attack.server.lua',
        'attack.server.luau',
        'attack.client.lua',
        'attack.client.luau',
        'init.server.lua',
        'init.client.luau',
        'lib/nested/payload.server.luau',
    ]) {
        assert.match(checkRobloxEntryName(name, 'file') ?? '', /Runtime script not allowed/, name);
    }
});

test('suffix match is case-insensitive', () => {
    assert.match(checkRobloxEntryName('Attack.Server.Lua', 'file') ?? '', /Runtime script not allowed/);
    assert.match(checkRobloxEntryName('attack.CLIENT.LUAU', 'file') ?? '', /Runtime script not allowed/);
});

test('allows ordinary module files', () => {
    for (const name of [
        'init.lua',
        'init.luau',
        'lib/module.lua',
        'README.md',
        'LICENSE',
        'forest.json',
        // No dot separator before server/client — ordinary ModuleScript names
        'server.lua',
        'client.luau',
        'src/webserver.lua',
    ]) {
        assert.equal(checkRobloxEntryName(name, 'file'), null, name);
    }
});

test('directories are exempt even with a runtime-script-shaped name', () => {
    assert.equal(checkRobloxEntryName('weird.server.lua/', 'directory'), null);
});

test('validateTgz fails an archive containing a runtime script', async () => {
    const buf = await createTgz([
        { name: 'init.lua', content: 'return {}' },
        { name: 'evil.client.luau', content: 'game.Players.LocalPlayer:Kick()' },
    ]);
    await assert.rejects(
        () => validateTgz(toStream(buf), { entryInspector: makeRobloxEntryInspector(makeRobloxScanState()) }),
        /Runtime script not allowed: evil\.client\.luau/,
    );
});

test('validateTgz passes a module-only archive', async () => {
    const buf = await createTgz([
        { name: 'init.lua', content: 'return {}' },
        { name: 'lib/util.luau', content: 'return {}' },
    ]);
    await validateTgz(toStream(buf), { entryInspector: makeRobloxEntryInspector(makeRobloxScanState()) });
});

// --- model files -------------------------------------------------------------

test('model-free package passes untouched', async () => {
  const { state, errors } = await runRobloxScan([REAL_CODE]);
  assert.equal(state.rbxmFiles.size, 0);
  assert.deepEqual(errors, []);
});

test('clean model plus real code passes', async () => {
  const { state, errors } = await runRobloxScan([
    REAL_CODE,
    { name: 'assets/tree.rbxm', content: buildRbxm('Model') },
  ]);
  assert.equal(state.rbxmFiles.size, 1);
  assert.deepEqual(errors, []);
});

test('script-bearing model is rejected', async () => {
  const { errors } = await runRobloxScan([
    REAL_CODE,
    { name: 'assets/backdoor.rbxm', content: buildRbxm('LocalScript') },
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /assets\/backdoor\.rbxm/);
  assert.match(errors[0], /LocalScript x1/);
});

test('garbage bytes with an rbxm name are rejected as unparseable', async () => {
  const { errors } = await runRobloxScan([
    REAL_CODE,
    { name: 'assets/fake.rbxm', content: Buffer.from('this is not a model file') },
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not a valid Roblox binary model file/);
});

test('model-only package trips the code floor', async () => {
  const { errors } = await runRobloxScan([
    { name: 'init.luau', content: 'return script.Model' },
    { name: 'Model.rbxm', content: buildRbxm('Model') },
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /code-first/);
});

test('.lua files count toward the code floor too', async () => {
  const { errors } = await runRobloxScan([
    { name: 'init.lua', content: '-- legacy extension\n' + 'local y = 2\n'.repeat(40) + 'return y\n' },
    { name: 'Model.rbxm', content: buildRbxm('Model') },
  ]);
  assert.deepEqual(errors, []);
});

test('.rbxmx entries are rejected during extraction', async () => {
  const buf = await createTgz([
    REAL_CODE,
    { name: 'assets/tree.rbxmx', content: '<roblox></roblox>' },
  ]);
  const state = makeRobloxScanState();
  await assert.rejects(
    () => validateTgz(toStream(buf), { entryInspector: makeRobloxEntryInspector(state) }),
    /re-save as binary \.rbxm/,
  );
});

test('extension matching is case-insensitive', async () => {
  const { state, errors } = await runRobloxScan([
    REAL_CODE,
    { name: 'assets/TREE.RBXM', content: buildRbxm('ModuleScript') },
  ]);
  assert.equal(state.rbxmFiles.size, 1);
  assert.equal(errors.length, 1);
});
