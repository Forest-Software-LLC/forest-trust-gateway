import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { PassThrough } from 'node:stream';
import tar from 'tar-stream';
import { checkRobloxEntryName, makeRobloxEntryInspector } from '../../src/rules/robloxRules.ts';
import { validateTgz } from '../../src/rules/validateTgz.ts';

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

async function packTgz(files: Record<string, string>): Promise<Buffer> {
    const pack = tar.pack();
    for (const [name, content] of Object.entries(files)) {
        pack.entry({ name }, content);
    }
    pack.finalize();
    const chunks: Buffer[] = [];
    for await (const chunk of pack) {
        chunks.push(chunk as Buffer);
    }
    return gzipSync(Buffer.concat(chunks));
}

test('validateTgz fails an archive containing a runtime script', async () => {
    const tgz = await packTgz({
        'init.lua': 'return {}',
        'evil.client.luau': 'game.Players.LocalPlayer:Kick()',
    });
    const pass = new PassThrough();
    pass.end(tgz);
    await assert.rejects(
        validateTgz(pass, { entryInspector: makeRobloxEntryInspector() }),
        /Runtime script not allowed: evil\.client\.luau/
    );
});

test('validateTgz passes a module-only archive', async () => {
    const tgz = await packTgz({
        'init.lua': 'return {}',
        'lib/util.luau': 'return {}',
    });
    const pass = new PassThrough();
    pass.end(tgz);
    await validateTgz(pass, { entryInspector: makeRobloxEntryInspector() });
});
