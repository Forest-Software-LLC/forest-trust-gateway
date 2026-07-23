import test from 'node:test';
import assert from 'node:assert/strict';
import {
    checkUefnEntryName,
    mapScopeToVerseIdentifier,
    validateUefnPackage,
} from '../../src/rules/uefnRules.ts';

// ---- checkUefnEntryName ------------------------------------------------------

test('entry names: allowed files pass', () => {
    for (const name of ['Calc.verse', 'sub/dir/MathUtil.verse', 'README.md', 'forest.json', 'LICENSE', 'license.txt']) {
        assert.equal(checkUefnEntryName(name, 'file'), null, name);
    }
});

test('entry names: directories pass regardless of name', () => {
    assert.equal(checkUefnEntryName('sub/dir/', 'directory'), null);
});

test('entry names: non-file non-directory types are rejected (symlink evasion)', () => {
    const error = checkUefnEntryName('x.verse', 'symlink');
    assert.ok(error !== null);
    assert.match(error!, /entry type/);
});

test('entry names: install receipts are rejected at any depth', () => {
    for (const name of ['.forest-receipt', 'a/b/.forest-receipt']) {
        const error = checkUefnEntryName(name, 'file');
        assert.ok(error !== null, name);
        assert.match(error!, /receipt/i);
    }
});

test('entry names: Epic digest files are rejected at any depth', () => {
    for (const name of ['Foo.digest.verse', 'nested/Assets.digest.verse']) {
        const error = checkUefnEntryName(name, 'file');
        assert.ok(error !== null, name);
        assert.match(error!, /digest/);
    }
});

test('entry names: binary UE assets are rejected', () => {
    for (const name of ['Mesh.uasset', 'Level.umap', 'a/b/Tex.UASSET']) {
        const error = checkUefnEntryName(name, 'file');
        assert.ok(error !== null, name);
        assert.match(error!, /Binary UE assets/);
    }
});

test('entry names: everything else is rejected by the allowlist (incl. dotfiles and lua)', () => {
    for (const name of ['script.lua', 'init.luau', '.gitignore', 'x.png', 'x.txt']) {
        const error = checkUefnEntryName(name, 'file');
        assert.ok(error !== null, name);
        assert.match(error!, /not allowed/);
    }
});

// ---- mapScopeToVerseIdentifier ----------------------------------------------
// SYNC CANARY: identical vectors to forest-backend test/uefn/
// verseIdentifiers.test.ts — a divergence means the duplicated
// implementations have drifted.

test('scope mapping: hyphens, digit-led, reserved, plain', () => {
    assert.equal(mapScopeToVerseIdentifier('cool-studio'), 'cool_studio');
    assert.equal(mapScopeToVerseIdentifier('a-b-c'), 'a_b_c');
    assert.equal(mapScopeToVerseIdentifier('123-team'), '_123_team');
    assert.equal(mapScopeToVerseIdentifier('7up'), '_7up');
    assert.equal(mapScopeToVerseIdentifier('module'), '_module');
    assert.equal(mapScopeToVerseIdentifier('set'), '_set');
    assert.equal(mapScopeToVerseIdentifier('alice'), 'alice');
    assert.equal(mapScopeToVerseIdentifier('stratiz'), 'stratiz');
});

// ---- validateUefnPackage -----------------------------------------------------

function makeInput(files: Record<string, string>, overrides: Partial<{ ownScope: string; ownName: string; dependencyKeys: string[] }> = {}) {
    return {
        files: new Map(Object.entries(files)),
        ownScope: 'testscope',
        ownName: 'testpkg',
        dependencyKeys: ['cool-studio/MathUtil'],
        ...overrides,
    };
}

test('declared dep import passes; case-insensitive match', () => {
    const result = validateUefnPackage(makeInput({
        'Calc.verse': 'using { ForestPackages.cool_studio.MathUtil }\nDouble<public>(X:int):int = Add(X, X)\n',
    }));
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
});

test('undeclared ForestPackages import is an error naming the reference', () => {
    const result = validateUefnPackage(makeInput({
        'Calc.verse': 'using { ForestPackages.someone_else.Thing }\nF<public>():void = {}\n',
    }));
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /someone_else\.Thing/);
    assert.match(result.errors[0], /not.*declared|no matching/i);
});

test('self-reference by published path is an error', () => {
    const result = validateUefnPackage(makeInput({
        'A.verse': 'X<public>():int = (ForestPackages.testscope.testpkg:)Helper()\n',
    }));
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /own published path/);
});

test('Epic API absolute paths are allowed; project absolute paths are rejected', () => {
    const ok = validateUefnPackage(makeInput({
        'A.verse': 'using { /Verse.org/Simulation }\nusing { /Fortnite.com/Devices }\nF<public>():void = {}\n',
    }));
    assert.deepEqual(ok.errors, []);

    const bad = validateUefnPackage(makeInput({
        'A.verse': 'using { /mydomain/MyProj/ForestPackages/x }\nF<public>():void = {}\n',
    }));
    assert.equal(bad.errors.length, 1);
    assert.match(bad.errors[0], /absolute Verse path/);
});

test('absolute qualified access is rejected; Epic-root qualifier allowed', () => {
    const bad = validateUefnPackage(makeInput({
        'A.verse': 'F<public>(X:int):int = (/foo/Bar:)Add(X, X)\n',
    }));
    assert.equal(bad.errors.length, 1);
    assert.match(bad.errors[0], /absolute qualified access/);

    const ok = validateUefnPackage(makeInput({
        'A.verse': 'F<public>(X:int):int = (/Verse.org/Verse:)Floor(1.5)\n',
    }));
    assert.deepEqual(ok.errors, []);
});

test('Assets digest imports are rejected', () => {
    const result = validateUefnPackage(makeInput({
        'A.verse': 'using { Assets.Textures }\nF<public>():void = {}\n',
    }));
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /asset digest/);
});

test('multi-path using splits on commas', () => {
    const result = validateUefnPackage(makeInput({
        'A.verse': 'using { /Verse.org/Simulation, /mydomain/Bad }\nF<public>():void = {}\n',
    }));
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /\/mydomain\/Bad/);
});

test('no <public> anywhere is a warning, not an error', () => {
    const result = validateUefnPackage(makeInput({
        'A.verse': 'Internal(X:int):int = X\n',
    }));
    assert.deepEqual(result.errors, []);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /<public>/);
});

test('a using inside a comment still matches (documented lexical lenience)', () => {
    const result = validateUefnPackage(makeInput({
        'A.verse': '# using { /mydomain/Commented }\nF<public>():void = {}\n',
    }));
    assert.equal(result.errors.length, 1, 'comment content is deliberately scanned');
});

test('duplicate offending references are deduped', () => {
    const line = 'using { /mydomain/Bad }\n';
    const result = validateUefnPackage(makeInput({
        'A.verse': `${line}${line}F<public>():void = {}\n`,
    }));
    assert.equal(result.errors.length, 1);
});

test('empty file map produces no errors and no export warning', () => {
    const result = validateUefnPackage(makeInput({}));
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
});
