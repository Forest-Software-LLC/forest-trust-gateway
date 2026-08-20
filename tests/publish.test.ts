import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createGzip } from 'node:zlib';
import tar from 'tar-stream';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { registerPublishRoute } from '../src/routes/publish.ts';
import { MockInternalApiClient, allowedPublishFacts, deniedPublishFacts, rejectedLicenseVerdict, deniedAccessFacts } from './mockInternalApiClient.ts';
import { buildMultipartBody } from './multipartHelper.ts';
import { buildRbxm } from './rbxmFixture.ts';

async function makeTgz(entries: { name: string; content: string }[]): Promise<Buffer> {
    const pack = tar.pack();
    for (const { name, content } of entries) pack.entry({ name }, content);
    pack.finalize();
    const gzip = createGzip();
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
        pack.pipe(gzip).on('data', c => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject);
    });
}

// A fake S3Client that just records what it was asked to store, so tests
// never touch real R2 credentials or network.
function makeFakeS3() {
    const puts: { key: string; body: Buffer; ssecAlgorithm?: string; ssecKey?: string }[] = [];
    return {
        client: {
            send: async (command: any) => {
                puts.push({
                    key: command.input.Key,
                    body: Buffer.from(command.input.Body),
                    ssecAlgorithm: command.input.SSECustomerAlgorithm,
                    ssecKey: command.input.SSECustomerKey,
                });
                return {};
            },
        } as any,
        puts,
    };
}

const dummyAccessFacts = deniedAccessFacts;

function buildApp(client: MockInternalApiClient, s3: any, fileSizeLimit = 10 * 1024 * 1024, tarballEncKey?: Buffer) {
    const fastify = Fastify();
    // Same registration shape as src/server.ts — the fileSize limit is part
    // of the contract under test (see the oversized-upload tests below).
    fastify.register(multipart, { limits: { fileSize: fileSizeLimit } });
    registerPublishRoute(fastify, { internalApi: client, s3, bucketName: 'test-bucket', cdnBaseUrl: 'https://registry.forest.dev', tarballEncKey });
    return fastify;
}

function forestJsonFor(overrides: Partial<Record<string, unknown>> = {}) {
    return JSON.stringify({
        name: 'testpkg',
        author: 'testscope',
        root: 'src/init.luau',
        version: '1.0.0',
        dependencies: {},
        platform: 'roblox',
        license: 'MIT',
        ...overrides,
    });
}

test('a request denied by decidePublishPermission is rejected before any R2 write happens', async () => {
    const client = new MockInternalApiClient(deniedPublishFacts, dummyAccessFacts);
    const { client: s3, puts } = makeFakeS3();
    const app = buildApp(client, s3);
    await app.ready();

    const tgz = await makeTgz([{ name: 'LICENSE', content: 'MIT License text' }, { name: 'src/init.luau', content: 'return {}' }]);
    const { body, contentType } = buildMultipartBody([
        { name: 'metadata', value: JSON.stringify({ public: true }) },
        { name: 'forestJson', value: forestJsonFor() },
        { name: 'file', value: tgz, filename: 'package.tgz', contentType: 'application/gzip' },
    ]);

    const res = await app.inject({
        method: 'POST', url: '/v1/package/upload',
        headers: { 'content-type': contentType, 'x-file-size': String(tgz.length), authorization: 'Bearer test' },
        payload: body,
    });

    assert.equal(res.statusCode, 403);
    assert.equal(puts.length, 0, 'nothing should ever be written to R2 for a denied publish');
    assert.equal(client.recordedCalls.length, 0, 'record-published-version must never be called for a denied publish');
});

test('a valid package with a matching license is accepted, hashed, stored, and recorded', async () => {
    const client = new MockInternalApiClient(allowedPublishFacts, dummyAccessFacts);
    const { client: s3, puts } = makeFakeS3();
    const app = buildApp(client, s3);
    await app.ready();

    const tgz = await makeTgz([{ name: 'LICENSE', content: 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy' }, { name: 'src/init.luau', content: 'return {}' }]);
    const { body, contentType } = buildMultipartBody([
        { name: 'metadata', value: JSON.stringify({ public: true }) },
        { name: 'forestJson', value: forestJsonFor() },
        { name: 'file', value: tgz, filename: 'package.tgz', contentType: 'application/gzip' },
    ]);

    const res = await app.inject({
        method: 'POST', url: '/v1/package/upload',
        headers: { 'content-type': contentType, 'x-file-size': String(tgz.length), authorization: 'Bearer test' },
        payload: body,
    });

    assert.equal(res.statusCode, 200);
    const resBody = res.json();
    assert.equal(resBody.version, '1.0.0');

    // The hash the route returned must equal sha256 of the exact tarball bytes
    // that were sent, AND the fake S3 client must have received exactly those
    // same bytes under the matching content-addressed key.
    const expectedHash = createHash('sha256').update(tgz).digest('hex');
    assert.equal(resBody.hash, expectedHash);
    assert.equal(puts.length, 1);
    assert.equal(puts[0].key, `public/${expectedHash}.tgz`);
    assert.equal(puts[0].body.toString('base64'), tgz.toString('base64'));

    assert.equal(client.recordedCalls.length, 1);
    assert.equal(client.recordedCalls[0].hash, expectedHash);
    assert.equal(client.recordedCalls[0].licenseVerified, true);
    assert.equal(client.recordedCalls[0].licenseRating, 'safe');

    // A package recorded without these would be broken (no entry point)
    // or silently wrong (lost description/readme) — pin every field the
    // backend needs to persist a usable version.
    assert.equal(client.recordedCalls[0].archiveRoot, 'src/init.luau');
    assert.equal(client.recordedCalls[0].declaredLicense, 'MIT');
    assert.equal(client.recordedCalls[0].isPublic, true);
    assert.equal(client.recordedCalls[0].needsAiScan, false);
    // No packagesDir in the manifest -> none recorded (absent = the default
    // `Packages`, matching every version published before the field existed).
    assert.equal(client.recordedCalls[0].packagesDir, undefined);

    // What the license means is forest-backend's call, not this gateway's —
    // but the gateway must still forward exactly what it captured from the
    // archive, so the backend's rating is grounded in the real file.
    assert.equal(client.verifyLicenseCalls.length, 1);
    assert.equal(client.verifyLicenseCalls[0].declaredLicense, 'MIT');
    assert.match(client.verifyLicenseCalls[0].licenseText ?? '', /permission is hereby granted/i);
    assert.equal(client.verifyLicenseCalls[0].isPublic, true);
});

test('a Windows-style backslash root is stored with forward slashes', async () => {
    // Publishers on Windows write OS-style paths into forest.json's root;
    // the stored archiveRoot drives extraction path-matching on EVERY
    // consumer OS, so it must be forward-slashed (chiefwildin/AnimNation
    // @1.14.0 shipped as `AnimNation\init.luau` and broke mac/linux).
    const client = new MockInternalApiClient(allowedPublishFacts, dummyAccessFacts);
    const { client: s3 } = makeFakeS3();
    const app = buildApp(client, s3);
    await app.ready();

    const tgz = await makeTgz([{ name: 'LICENSE', content: 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy' }, { name: 'AnimNation/init.luau', content: 'return {}' }]);
    const { body, contentType } = buildMultipartBody([
        { name: 'metadata', value: JSON.stringify({ public: true }) },
        { name: 'forestJson', value: forestJsonFor({ root: 'AnimNation\\init.luau' }) },
        { name: 'file', value: tgz, filename: 'package.tgz', contentType: 'application/gzip' },
    ]);

    const res = await app.inject({
        method: 'POST', url: '/v1/package/upload',
        headers: { 'content-type': contentType, 'x-file-size': String(tgz.length), authorization: 'Bearer test' },
        payload: body,
    });

    assert.equal(res.statusCode, 200);
    assert.equal(client.recordedCalls.length, 1);
    assert.equal(client.recordedCalls[0].archiveRoot, 'AnimNation/init.luau');
});

test('a custom dependency alias is preserved, and none is fabricated for string shorthand', async () => {
    const client = new MockInternalApiClient(allowedPublishFacts, dummyAccessFacts);
    const { client: s3 } = makeFakeS3();
    const app = buildApp(client, s3);
    await app.ready();

    const tgz = await makeTgz([{ name: 'LICENSE', content: 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy' }, { name: 'src/init.luau', content: 'return {}' }]);
    const { body, contentType } = buildMultipartBody([
        { name: 'metadata', value: JSON.stringify({ public: true }) },
        {
            name: 'forestJson',
            value: forestJsonFor({
                dependencies: {
                    'scope/shorthand': '^1.0.0', // string shorthand -> recorded alias-less; consumers derive the name from the key
                    'scope/promise': { version: '^2.0.0', alias: 'MyPromise' }, // explicit custom alias
                },
            }),
        },
        { name: 'file', value: tgz, filename: 'package.tgz', contentType: 'application/gzip' },
    ]);

    const res = await app.inject({
        method: 'POST', url: '/v1/package/upload',
        headers: { 'content-type': contentType, 'x-file-size': String(tgz.length), authorization: 'Bearer test' },
        payload: body,
    });

    assert.equal(res.statusCode, 200);
    const deps = client.recordedCalls[0].dependencies;
    // No fabricated alias: a full `scope/name` key is never a legal folder
    // name, so shorthand deps are recorded alias-less.
    assert.deepEqual(deps['scope/shorthand'], { version: '^1.0.0' });
    assert.deepEqual(deps['scope/promise'], { version: '^2.0.0', alias: 'MyPromise' });
});

// ---- packagesDir (custom dependency container directory) ---------------------

test('a valid custom packagesDir is accepted and forwarded on record-published-version', async () => {
    const client = new MockInternalApiClient(allowedPublishFacts, dummyAccessFacts);
    const { client: s3, puts } = makeFakeS3();
    const app = buildApp(client, s3);
    await app.ready();

    const tgz = await makeTgz([{ name: 'LICENSE', content: 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy' }, { name: 'src/init.luau', content: 'return {}' }]);
    const { body, contentType } = buildMultipartBody([
        { name: 'metadata', value: JSON.stringify({ public: true }) },
        { name: 'forestJson', value: forestJsonFor({ packagesDir: 'roblox_packages' }) },
        { name: 'file', value: tgz, filename: 'package.tgz', contentType: 'application/gzip' },
    ]);

    const res = await app.inject({
        method: 'POST', url: '/v1/package/upload',
        headers: { 'content-type': contentType, 'x-file-size': String(tgz.length), authorization: 'Bearer test' },
        payload: body,
    });

    assert.equal(res.statusCode, 200);
    assert.equal(puts.length, 1);
    assert.equal(client.recordedCalls.length, 1);
    // The whole point of the field: the name must reach the backend, or the
    // package installs under `Packages` while its source requires the renamed
    // container, breaking every consumer.
    assert.equal(client.recordedCalls[0].packagesDir, 'roblox_packages');
});

test('a traversal-style or otherwise malformed packagesDir is rejected before any backend call', async () => {
    // Registry-supplied packagesDir values flow into consumer filesystem
    // paths at install time, so anything that could escape or nest below the
    // project dir must die at the schema. The letter-start rule also excludes
    // the CLI's cleanup-exempt `_`/`.` prefixes, and 65 chars breaks the cap.
    const badNames = ['../evil', '..', 'nested/dir', 'back\\slash', '.hidden', '_private', 'name with space', 'x:drive', 'A'.repeat(65)];
    for (const packagesDir of badNames) {
        const client = new MockInternalApiClient(allowedPublishFacts, dummyAccessFacts);
        const { client: s3, puts } = makeFakeS3();
        const app = buildApp(client, s3);
        await app.ready();

        const tgz = await makeTgz([{ name: 'LICENSE', content: 'MIT License text' }, { name: 'src/init.luau', content: 'return {}' }]);
        const { body, contentType } = buildMultipartBody([
            { name: 'metadata', value: JSON.stringify({ public: true }) },
            { name: 'forestJson', value: forestJsonFor({ packagesDir }) },
            { name: 'file', value: tgz, filename: 'package.tgz', contentType: 'application/gzip' },
        ]);

        const res = await app.inject({
            method: 'POST', url: '/v1/package/upload',
            headers: { 'content-type': contentType, 'x-file-size': String(tgz.length), authorization: 'Bearer test' },
            payload: body,
        });

        assert.equal(res.statusCode, 400, `expected 400 for packagesDir ${JSON.stringify(packagesDir)}`);
        assert.match(res.json().error, /Invalid JSON format for field forestJson/);
        assert.equal(client.publishAuthorizationCalls.length, 0, 'a malformed manifest must never reach the backend');
        assert.equal(puts.length, 0);
        assert.equal(client.recordedCalls.length, 0);
    }
});

test('a Windows reserved device name as packagesDir is rejected case-insensitively', async () => {
    // CON, PRN, AUX, NUL, COM1-9, LPT1-9 can never exist as folders on a
    // Windows consumer's disk — a package published with one would be
    // uninstallable there. The rejection must not over-match: CONSOLE is legal.
    const cases: { packagesDir: string; expected: number }[] = [
        { packagesDir: 'CON', expected: 400 },
        { packagesDir: 'con', expected: 400 },
        { packagesDir: 'Com5', expected: 400 },
        { packagesDir: 'lpt9', expected: 400 },
        { packagesDir: 'CONSOLE', expected: 200 },
    ];
    for (const { packagesDir, expected } of cases) {
        const client = new MockInternalApiClient(allowedPublishFacts, dummyAccessFacts);
        const { client: s3 } = makeFakeS3();
        const app = buildApp(client, s3);
        await app.ready();

        const tgz = await makeTgz([{ name: 'LICENSE', content: 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy' }, { name: 'src/init.luau', content: 'return {}' }]);
        const { body, contentType } = buildMultipartBody([
            { name: 'metadata', value: JSON.stringify({ public: true }) },
            { name: 'forestJson', value: forestJsonFor({ packagesDir }) },
            { name: 'file', value: tgz, filename: 'package.tgz', contentType: 'application/gzip' },
        ]);

        const res = await app.inject({
            method: 'POST', url: '/v1/package/upload',
            headers: { 'content-type': contentType, 'x-file-size': String(tgz.length), authorization: 'Bearer test' },
            payload: body,
        });

        assert.equal(res.statusCode, expected, `expected ${expected} for packagesDir ${JSON.stringify(packagesDir)}`);
    }
});

test('a rejected license verdict blocks the publish — nothing stored, before or after', async () => {
    // The gateway doesn't decide what a license means — the backend does.
    // This test proves the gateway actually respects a rejection from that
    // call rather than storing the package anyway.
    const client = new MockInternalApiClient(allowedPublishFacts, dummyAccessFacts, rejectedLicenseVerdict);
    const { client: s3, puts } = makeFakeS3();
    const app = buildApp(client, s3);
    await app.ready();

    const tgz = await makeTgz([{ name: 'LICENSE', content: 'GNU GENERAL PUBLIC LICENSE Version 3' }, { name: 'src/init.luau', content: 'return {}' }]);
    const { body, contentType } = buildMultipartBody([
        { name: 'metadata', value: JSON.stringify({ public: true }) },
        { name: 'forestJson', value: forestJsonFor() },
        { name: 'file', value: tgz, filename: 'package.tgz', contentType: 'application/gzip' },
    ]);

    const res = await app.inject({
        method: 'POST', url: '/v1/package/upload',
        headers: { 'content-type': contentType, 'x-file-size': String(tgz.length), authorization: 'Bearer test' },
        payload: body,
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /license mismatch/i);
    assert.equal(puts.length, 0, 'a version rejected on license grounds must never be written to R2');
    assert.equal(client.recordedCalls.length, 0);
});

test('a cooldown block (retryAfterSeconds present) is a 429 with a Retry-After header, nothing stored', async () => {
    const client = new MockInternalApiClient(
        { ...allowedPublishFacts, blockedReason: 'Free accounts can only publish a new package every 12 hours. Try again in 3h.', retryAfterSeconds: 10800 },
        dummyAccessFacts
    );
    const { client: s3, puts } = makeFakeS3();
    const app = buildApp(client, s3);
    await app.ready();

    const tgz = await makeTgz([{ name: 'LICENSE', content: 'MIT' }, { name: 'src/init.luau', content: 'return {}' }]);
    const { body, contentType } = buildMultipartBody([
        { name: 'metadata', value: JSON.stringify({ public: true }) },
        { name: 'forestJson', value: forestJsonFor() },
        { name: 'file', value: tgz, filename: 'package.tgz', contentType: 'application/gzip' },
    ]);

    const res = await app.inject({
        method: 'POST', url: '/v1/package/upload',
        headers: { 'content-type': contentType, 'x-file-size': String(tgz.length), authorization: 'Bearer test' },
        payload: body,
    });

    assert.equal(res.statusCode, 429);
    assert.equal(res.headers['retry-after'], '10800');
    assert.equal(puts.length, 0);
    assert.equal(client.recordedCalls.length, 0);
});

test('an over-limit block (no retryAfterSeconds) is a 403, not a 429', async () => {
    const client = new MockInternalApiClient(
        { ...allowedPublishFacts, blockedReason: 'This Studio is over the free member limit of 3.' },
        dummyAccessFacts
    );
    const { client: s3, puts } = makeFakeS3();
    const app = buildApp(client, s3);
    await app.ready();

    const tgz = await makeTgz([{ name: 'LICENSE', content: 'MIT' }, { name: 'src/init.luau', content: 'return {}' }]);
    const { body, contentType } = buildMultipartBody([
        { name: 'metadata', value: JSON.stringify({ public: true }) },
        { name: 'forestJson', value: forestJsonFor() },
        { name: 'file', value: tgz, filename: 'package.tgz', contentType: 'application/gzip' },
    ]);

    const res = await app.inject({
        method: 'POST', url: '/v1/package/upload',
        headers: { 'content-type': contentType, 'x-file-size': String(tgz.length), authorization: 'Bearer test' },
        payload: body,
    });

    assert.equal(res.statusCode, 403);
    assert.equal(res.headers['retry-after'], undefined);
    assert.equal(puts.length, 0);
    assert.equal(client.recordedCalls.length, 0);
});

test('an unauthenticated request is rejected', async () => {
    const client = new MockInternalApiClient({ ...deniedPublishFacts, authenticated: false }, dummyAccessFacts);
    const { client: s3, puts } = makeFakeS3();
    const app = buildApp(client, s3);
    await app.ready();

    const tgz = await makeTgz([{ name: 'LICENSE', content: 'MIT' }, { name: 'src/init.luau', content: 'return {}' }]);
    const { body, contentType } = buildMultipartBody([
        { name: 'metadata', value: JSON.stringify({ public: true }) },
        { name: 'forestJson', value: forestJsonFor() },
        { name: 'file', value: tgz, filename: 'package.tgz', contentType: 'application/gzip' },
    ]);

    const res = await app.inject({
        method: 'POST', url: '/v1/package/upload',
        headers: { 'content-type': contentType, 'x-file-size': String(tgz.length) },
        payload: body,
    });

    assert.equal(res.statusCode, 401);
    assert.equal(puts.length, 0);
});

test('a declared x-file-size over the 10MB cap is rejected before the body is even parsed', async () => {
    const client = new MockInternalApiClient(allowedPublishFacts, dummyAccessFacts);
    const { client: s3, puts } = makeFakeS3();
    const app = buildApp(client, s3);
    await app.ready();

    const tgz = await makeTgz([{ name: 'LICENSE', content: 'MIT' }, { name: 'src/init.luau', content: 'return {}' }]);
    const { body, contentType } = buildMultipartBody([
        { name: 'metadata', value: JSON.stringify({ public: true }) },
        { name: 'forestJson', value: forestJsonFor() },
        { name: 'file', value: tgz, filename: 'package.tgz', contentType: 'application/gzip' },
    ]);

    const res = await app.inject({
        method: 'POST', url: '/v1/package/upload',
        headers: { 'content-type': contentType, 'x-file-size': String(11 * 1024 * 1024), authorization: 'Bearer test' },
        payload: body,
    });

    assert.equal(res.statusCode, 413);
    assert.equal(puts.length, 0);
});

test('a file that exceeds the multipart fileSize limit is rejected as truncated, not processed as a silent prefix', async () => {
    // busboy TRUNCATES at the limit instead of erroring, so without the
    // explicit part.file.truncated check the handler would carry a cut-off
    // buffer into validation. The tiny 1KB limit here (vs. the file's ~2KB)
    // triggers exactly that path; x-file-size deliberately understates the
    // size to prove the declared header alone doesn't protect anything.
    const client = new MockInternalApiClient(allowedPublishFacts, dummyAccessFacts);
    const { client: s3, puts } = makeFakeS3();
    const app = buildApp(client, s3, 1024);
    await app.ready();

    // Random bytes, not repeated characters — gzip squashes 'x'.repeat(4096)
    // to well under the 1KB limit, silently defeating the whole test.
    const bigContent = randomBytes(4096).toString('hex');
    const tgz = await makeTgz([{ name: 'LICENSE', content: 'MIT' }, { name: 'src/init.luau', content: bigContent }]);
    assert.ok(tgz.length > 1024, 'test file must exceed the 1KB limit for this test to mean anything');
    const { body, contentType } = buildMultipartBody([
        { name: 'metadata', value: JSON.stringify({ public: true }) },
        { name: 'forestJson', value: forestJsonFor() },
        { name: 'file', value: tgz, filename: 'package.tgz', contentType: 'application/gzip' },
    ]);

    const res = await app.inject({
        method: 'POST', url: '/v1/package/upload',
        headers: { 'content-type': contentType, 'x-file-size': String(100), authorization: 'Bearer test' },
        payload: body,
    });

    assert.equal(res.statusCode, 413);
    assert.equal(puts.length, 0);
    assert.equal(client.recordedCalls.length, 0);
});

test('the Authorization header is forwarded on the record-published-version call', async () => {
    // The backend resolves the publishing author from the caller's identity,
    // so recording a version without the caller's Authorization header fails
    // with a 401 — after the file is already stored. Nothing else in this
    // suite notices a dropped header (the mock doesn't enforce auth), so
    // this pins the forwarding explicitly.
    const client = new MockInternalApiClient(allowedPublishFacts, dummyAccessFacts);
    const { client: s3 } = makeFakeS3();
    const app = buildApp(client, s3);
    await app.ready();

    const tgz = await makeTgz([{ name: 'LICENSE', content: 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy' }, { name: 'src/init.luau', content: 'return {}' }]);
    const { body, contentType } = buildMultipartBody([
        { name: 'metadata', value: JSON.stringify({ public: true }) },
        { name: 'forestJson', value: forestJsonFor() },
        { name: 'file', value: tgz, filename: 'package.tgz', contentType: 'application/gzip' },
    ]);

    const res = await app.inject({
        method: 'POST', url: '/v1/package/upload',
        headers: { 'content-type': contentType, 'x-file-size': String(tgz.length), authorization: 'Bearer forwarded-token' },
        payload: body,
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(client.recordedAuthHeaders, ['Bearer forwarded-token']);
});

test('the requested visibility is forwarded on the publish-authorization call', async () => {
    // The backend gates private publishes behind a Pro subscription using
    // this flag — dropping it would silently bypass the gate (the backend
    // schema requires it, so a drop fails loudly there, but this pins the
    // gateway side too).
    const client = new MockInternalApiClient(allowedPublishFacts, dummyAccessFacts);
    const { client: s3 } = makeFakeS3();
    const app = buildApp(client, s3);
    await app.ready();

    const tgz = await makeTgz([{ name: 'LICENSE', content: 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy' }, { name: 'src/init.luau', content: 'return {}' }]);
    const { body, contentType } = buildMultipartBody([
        { name: 'metadata', value: JSON.stringify({ public: false }) },
        { name: 'forestJson', value: forestJsonFor() },
        { name: 'file', value: tgz, filename: 'package.tgz', contentType: 'application/gzip' },
    ]);

    const res = await app.inject({
        method: 'POST', url: '/v1/package/upload',
        headers: { 'content-type': contentType, 'x-file-size': String(tgz.length), authorization: 'Bearer test' },
        payload: body,
    });

    assert.equal(res.statusCode, 200);
    assert.equal(client.publishAuthorizationCalls.length, 1);
    assert.equal(client.publishAuthorizationCalls[0].isPublic, false);
});

// ---- UEFN platform branch ----------------------------------------------------

function uefnForestJson(overrides: Partial<Record<string, unknown>> = {}) {
    return JSON.stringify({
        name: 'testpkg',
        author: 'testscope',
        version: '1.0.0',
        dependencies: { 'cool-studio/MathUtil': '^1.0.0' },
        platform: 'uefn',
        license: 'MIT',
        ...overrides,
    });
}

function uefnUpload(forestJson: string, tgz: Buffer, metadata: Record<string, unknown> = { public: true }) {
    return buildMultipartBody([
        { name: 'metadata', value: JSON.stringify(metadata) },
        { name: 'forestJson', value: forestJson },
        { name: 'file', value: tgz, filename: 'package.tgz', contentType: 'application/gzip' },
    ]);
}

test('uefn happy path: no root, dep import, archiveRoot empty, compatVersion forwarded, no warnings key', async () => {
    const client = new MockInternalApiClient(allowedPublishFacts, dummyAccessFacts);
    const { client: s3, puts } = makeFakeS3();
    const app = buildApp(client, s3);
    await app.ready();

    const tgz = await makeTgz([
        { name: 'LICENSE', content: 'MIT License text' },
        { name: 'forest.json', content: uefnForestJson() },
        { name: 'Calc.verse', content: 'using { ForestPackages.cool_studio.MathUtil }\nDouble<public>(X:int):int = Add(X, X)\n' },
    ]);
    const { body, contentType } = uefnUpload(uefnForestJson(), tgz, { public: true, compatVersion: '41.20' });

    const res = await app.inject({
        method: 'POST', url: '/v1/package/upload',
        headers: { 'content-type': contentType, 'x-file-size': String(tgz.length), authorization: 'Bearer test' },
        payload: body,
    });

    assert.equal(res.statusCode, 200);
    const resBody = res.json();
    assert.equal(resBody.version, '1.0.0');
    assert.equal('warnings' in resBody, false, 'clean publish must not carry a warnings key');
    assert.equal(puts.length, 1);
    assert.equal(client.recordedCalls.length, 1);
    assert.equal(client.recordedCalls[0].archiveRoot, '');
    assert.equal(client.recordedCalls[0].platform, 'uefn');
    assert.equal(client.recordedCalls[0].compatVersion, '41.20');
});

test('uefn: Epic digest file in the tarball is rejected before license/R2/record', async () => {
    const client = new MockInternalApiClient(allowedPublishFacts, dummyAccessFacts);
    const { client: s3, puts } = makeFakeS3();
    const app = buildApp(client, s3);
    await app.ready();

    const tgz = await makeTgz([
        { name: 'LICENSE', content: 'MIT License text' },
        { name: 'Foo.digest.verse', content: 'x' },
    ]);
    const { body, contentType } = uefnUpload(uefnForestJson(), tgz);

    const res = await app.inject({
        method: 'POST', url: '/v1/package/upload',
        headers: { 'content-type': contentType, 'x-file-size': String(tgz.length), authorization: 'Bearer test' },
        payload: body,
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /digest/);
    assert.equal(puts.length, 0);
    assert.equal(client.recordedCalls.length, 0);
    assert.equal(client.verifyLicenseCalls.length, 0);
});

test('uefn: project-absolute Verse path rejected; Epic-root path allowed', async () => {
    const client = new MockInternalApiClient(allowedPublishFacts, dummyAccessFacts);
    const { client: s3, puts } = makeFakeS3();
    const app = buildApp(client, s3);
    await app.ready();

    const badTgz = await makeTgz([
        { name: 'LICENSE', content: 'MIT License text' },
        { name: 'A.verse', content: 'using { /mydomain/MyProj/Thing }\nF<public>():void = {}\n' },
    ]);
    const bad = uefnUpload(uefnForestJson(), badTgz);
    const badRes = await app.inject({
        method: 'POST', url: '/v1/package/upload',
        headers: { 'content-type': bad.contentType, 'x-file-size': String(badTgz.length), authorization: 'Bearer test' },
        payload: bad.body,
    });
    assert.equal(badRes.statusCode, 400);
    assert.match(badRes.json().error, /absolute Verse path/);
    assert.equal(puts.length, 0);

    const okTgz = await makeTgz([
        { name: 'LICENSE', content: 'MIT License text' },
        { name: 'A.verse', content: 'using { /Verse.org/Simulation }\nF<public>():void = {}\n' },
    ]);
    const ok = uefnUpload(uefnForestJson(), okTgz);
    const okRes = await app.inject({
        method: 'POST', url: '/v1/package/upload',
        headers: { 'content-type': ok.contentType, 'x-file-size': String(okTgz.length), authorization: 'Bearer test' },
        payload: ok.body,
    });
    assert.equal(okRes.statusCode, 200);
});

test('uefn: undeclared ForestPackages import is rejected naming the reference', async () => {
    const client = new MockInternalApiClient(allowedPublishFacts, dummyAccessFacts);
    const { client: s3 } = makeFakeS3();
    const app = buildApp(client, s3);
    await app.ready();

    const tgz = await makeTgz([
        { name: 'LICENSE', content: 'MIT License text' },
        { name: 'A.verse', content: 'using { ForestPackages.someone_else.Thing }\nF<public>():void = {}\n' },
    ]);
    const { body, contentType } = uefnUpload(uefnForestJson(), tgz);

    const res = await app.inject({
        method: 'POST', url: '/v1/package/upload',
        headers: { 'content-type': contentType, 'x-file-size': String(tgz.length), authorization: 'Bearer test' },
        payload: body,
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /someone_else\.Thing/);
});

test('uefn: self-reference by published path is rejected', async () => {
    const client = new MockInternalApiClient(allowedPublishFacts, dummyAccessFacts);
    const { client: s3 } = makeFakeS3();
    const app = buildApp(client, s3);
    await app.ready();

    const tgz = await makeTgz([
        { name: 'LICENSE', content: 'MIT License text' },
        { name: 'A.verse', content: 'using { ForestPackages.testscope.testpkg }\nF<public>():void = {}\n' },
    ]);
    const { body, contentType } = uefnUpload(uefnForestJson(), tgz);

    const res = await app.inject({
        method: 'POST', url: '/v1/package/upload',
        headers: { 'content-type': contentType, 'x-file-size': String(tgz.length), authorization: 'Bearer test' },
        payload: body,
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /own published path/);
});

test('uefn: package with no <public> export succeeds with a warnings array', async () => {
    const client = new MockInternalApiClient(allowedPublishFacts, dummyAccessFacts);
    const { client: s3, puts } = makeFakeS3();
    const app = buildApp(client, s3);
    await app.ready();

    const tgz = await makeTgz([
        { name: 'LICENSE', content: 'MIT License text' },
        { name: 'A.verse', content: 'Internal(X:int):int = X\n' },
    ]);
    const { body, contentType } = uefnUpload(uefnForestJson(), tgz);

    const res = await app.inject({
        method: 'POST', url: '/v1/package/upload',
        headers: { 'content-type': contentType, 'x-file-size': String(tgz.length), authorization: 'Bearer test' },
        payload: body,
    });

    assert.equal(res.statusCode, 200);
    const resBody = res.json();
    assert.ok(Array.isArray(resBody.warnings));
    assert.match(resBody.warnings[0], /<public>/);
    assert.equal(puts.length, 1, 'warnings do not block storage');
});

test('uefn manifest without root parses; roblox manifest without root is still rejected', async () => {
    const client = new MockInternalApiClient(allowedPublishFacts, dummyAccessFacts);
    const { client: s3 } = makeFakeS3();
    const app = buildApp(client, s3);
    await app.ready();

    // roblox without root must fail schema parse (superRefine)
    const tgz = await makeTgz([
        { name: 'LICENSE', content: 'MIT License text' },
        { name: 'src/init.luau', content: 'return {}' },
    ]);
    const robloxNoRoot = forestJsonFor({ root: undefined });
    const { body, contentType } = buildMultipartBody([
        { name: 'metadata', value: JSON.stringify({ public: true }) },
        { name: 'forestJson', value: robloxNoRoot },
        { name: 'file', value: tgz, filename: 'package.tgz', contentType: 'application/gzip' },
    ]);

    const res = await app.inject({
        method: 'POST', url: '/v1/package/upload',
        headers: { 'content-type': contentType, 'x-file-size': String(tgz.length), authorization: 'Bearer test' },
        payload: body,
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /Invalid JSON format for field forestJson/);
});

test('uefn: packagesDir is rejected — the shared ForestPackages mount name is the platform contract', async () => {
    // On UEFN there is ONE flat shared mount for the whole project and its
    // name is compiled into every package's Verse source; a package authored
    // against a renamed mount could never co-install with the rest of the
    // registry (see docs/uefn-adapter.md section 5), so the field is
    // roblox-only. Even a value that would be perfectly legal on roblox
    // must fail the uefn schema parse.
    const client = new MockInternalApiClient(allowedPublishFacts, dummyAccessFacts);
    const { client: s3, puts } = makeFakeS3();
    const app = buildApp(client, s3);
    await app.ready();

    const tgz = await makeTgz([
        { name: 'LICENSE', content: 'MIT License text' },
        { name: 'Calc.verse', content: 'Double<public>(X:int):int = X + X\n' },
    ]);
    const { body, contentType } = uefnUpload(uefnForestJson({ packagesDir: 'roblox_packages' }), tgz);

    const res = await app.inject({
        method: 'POST', url: '/v1/package/upload',
        headers: { 'content-type': contentType, 'x-file-size': String(tgz.length), authorization: 'Bearer test' },
        payload: body,
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /Invalid JSON format for field forestJson/);
    assert.equal(client.publishAuthorizationCalls.length, 0);
    assert.equal(puts.length, 0);
    assert.equal(client.recordedCalls.length, 0);
});

/*
    Encryption at rest: a private publish with the master key configured
    must reach R2 with SSE-C parameters whose key is derived from the
    final storage key (see src/rules/tarballEncryption.ts). The body the
    S3 client receives is still plaintext — R2 does the encrypting.
*/
test('a private publish with TARBALL_ENC_KEY set stores with a derived SSE-C key', async () => {
    const client = new MockInternalApiClient(allowedPublishFacts, dummyAccessFacts);
    const { client: s3, puts } = makeFakeS3();
    const masterKey = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
    const app = buildApp(client, s3, undefined, masterKey);
    await app.ready();

    const tgz = await makeTgz([{ name: 'LICENSE', content: 'MIT License text' }, { name: 'src/init.luau', content: 'return {}' }]);
    const { body, contentType } = buildMultipartBody([
        { name: 'metadata', value: JSON.stringify({ public: false }) },
        { name: 'forestJson', value: forestJsonFor() },
        { name: 'file', value: tgz, filename: 'package.tgz', contentType: 'application/gzip' },
    ]);

    const res = await app.inject({
        method: 'POST', url: '/v1/package/upload',
        headers: { 'content-type': contentType, 'x-file-size': String(tgz.length), authorization: 'Bearer test' },
        payload: body,
    });

    assert.equal(res.statusCode, 200);
    const expectedHash = createHash('sha256').update(tgz).digest('hex');
    assert.equal(puts.length, 1);
    assert.equal(puts[0].key, `private/${expectedHash}.tgz`);
    assert.equal(puts[0].ssecAlgorithm, 'AES256');
    const expectedKey = createHmac('sha256', masterKey).update(`private/${expectedHash}.tgz`, 'utf8').digest('base64');
    assert.equal(puts[0].ssecKey, expectedKey);
    // Plaintext body: encryption happens inside R2, not here.
    assert.equal(puts[0].body.toString('base64'), tgz.toString('base64'));
});

test('a public publish never carries SSE-C parameters, even with the key configured', async () => {
    const client = new MockInternalApiClient(allowedPublishFacts, dummyAccessFacts);
    const { client: s3, puts } = makeFakeS3();
    const app = buildApp(client, s3, undefined, Buffer.alloc(32, 7));
    await app.ready();

    const tgz = await makeTgz([{ name: 'LICENSE', content: 'MIT License text' }, { name: 'src/init.luau', content: 'return {}' }]);
    const { body, contentType } = buildMultipartBody([
        { name: 'metadata', value: JSON.stringify({ public: true }) },
        { name: 'forestJson', value: forestJsonFor() },
        { name: 'file', value: tgz, filename: 'package.tgz', contentType: 'application/gzip' },
    ]);

    const res = await app.inject({
        method: 'POST', url: '/v1/package/upload',
        headers: { 'content-type': contentType, 'x-file-size': String(tgz.length), authorization: 'Bearer test' },
        payload: body,
    });

    assert.equal(res.statusCode, 200);
    assert.equal(puts.length, 1);
    assert.equal(puts[0].ssecAlgorithm, undefined);
    assert.equal(puts[0].ssecKey, undefined);
});

test('a private publish without TARBALL_ENC_KEY stores plaintext (local-dev / pre-rollout path)', async () => {
    const client = new MockInternalApiClient(allowedPublishFacts, dummyAccessFacts);
    const { client: s3, puts } = makeFakeS3();
    const app = buildApp(client, s3);
    await app.ready();

    const tgz = await makeTgz([{ name: 'LICENSE', content: 'MIT License text' }, { name: 'src/init.luau', content: 'return {}' }]);
    const { body, contentType } = buildMultipartBody([
        { name: 'metadata', value: JSON.stringify({ public: false }) },
        { name: 'forestJson', value: forestJsonFor() },
        { name: 'file', value: tgz, filename: 'package.tgz', contentType: 'application/gzip' },
    ]);

    const res = await app.inject({
        method: 'POST', url: '/v1/package/upload',
        headers: { 'content-type': contentType, 'x-file-size': String(tgz.length), authorization: 'Bearer test' },
        payload: body,
    });

    assert.equal(res.statusCode, 200);
    assert.equal(puts.length, 1);
    assert.equal(puts[0].ssecAlgorithm, undefined);
    assert.equal(puts[0].ssecKey, undefined);
});

/*
    Dependency visibility at publish. The gateway sends the declared
    dependency keys to the backend and applies the pure rule to the facts
    it gets back — nothing may reach R2 that its own consumers could not
    install. Rule-level cases live in tests/rules/dependencyVisibility.test.ts;
    these pin the wiring.
*/
test('the declared dependency keys are forwarded on the publish-authorization call', async () => {
    const client = new MockInternalApiClient(allowedPublishFacts, dummyAccessFacts);
    const { client: s3 } = makeFakeS3();
    const app = buildApp(client, s3);
    await app.ready();

    const tgz = await makeTgz([{ name: 'LICENSE', content: 'MIT License text' }, { name: 'src/init.luau', content: 'return {}' }]);
    const { body, contentType } = buildMultipartBody([
        { name: 'metadata', value: JSON.stringify({ public: true }) },
        { name: 'forestJson', value: forestJsonFor({ dependencies: { 'scope/one': '^1.0.0', 'other/two': { version: '^2.0.0' } } }) },
        { name: 'file', value: tgz, filename: 'package.tgz', contentType: 'application/gzip' },
    ]);

    await app.inject({
        method: 'POST', url: '/v1/package/upload',
        headers: { 'content-type': contentType, 'x-file-size': String(tgz.length), authorization: 'Bearer test' },
        payload: body,
    });

    assert.equal(client.publishAuthorizationCalls.length, 1);
    assert.deepEqual(client.publishAuthorizationCalls[0].dependencyKeys.sort(), ['other/two', 'scope/one']);
});

test('a public package declaring a private dependency is rejected before anything is stored', async () => {
    const client = new MockInternalApiClient({
        ...allowedPublishFacts,
        dependencies: [{ key: 'me/secret', resolved: true, isPublic: false, ownedByAuthor: true }],
    }, dummyAccessFacts);
    const { client: s3, puts } = makeFakeS3();
    const app = buildApp(client, s3);
    await app.ready();

    const tgz = await makeTgz([{ name: 'LICENSE', content: 'MIT License text' }, { name: 'src/init.luau', content: 'return {}' }]);
    const { body, contentType } = buildMultipartBody([
        { name: 'metadata', value: JSON.stringify({ public: true }) },
        { name: 'forestJson', value: forestJsonFor({ dependencies: { 'me/secret': '^1.0.0' } }) },
        { name: 'file', value: tgz, filename: 'package.tgz', contentType: 'application/gzip' },
    ]);

    const res = await app.inject({
        method: 'POST', url: '/v1/package/upload',
        headers: { 'content-type': contentType, 'x-file-size': String(tgz.length), authorization: 'Bearer test' },
        payload: body,
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /public package cannot depend on private/i);
    assert.equal(puts.length, 0, 'an uninstallable package must never reach R2');
    assert.equal(client.recordedCalls.length, 0);
});

test('a private package declaring another scope\'s private dependency is rejected', async () => {
    const client = new MockInternalApiClient({
        ...allowedPublishFacts,
        dependencies: [{ key: 'them/secret', resolved: true, isPublic: false, ownedByAuthor: false }],
    }, dummyAccessFacts);
    const { client: s3, puts } = makeFakeS3();
    const app = buildApp(client, s3);
    await app.ready();

    const tgz = await makeTgz([{ name: 'LICENSE', content: 'MIT License text' }, { name: 'src/init.luau', content: 'return {}' }]);
    const { body, contentType } = buildMultipartBody([
        { name: 'metadata', value: JSON.stringify({ public: false }) },
        { name: 'forestJson', value: forestJsonFor({ dependencies: { 'them/secret': '^1.0.0' } }) },
        { name: 'file', value: tgz, filename: 'package.tgz', contentType: 'application/gzip' },
    ]);

    const res = await app.inject({
        method: 'POST', url: '/v1/package/upload',
        headers: { 'content-type': contentType, 'x-file-size': String(tgz.length), authorization: 'Bearer test' },
        payload: body,
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /owned by the same scope/i);
    assert.equal(puts.length, 0);
});

test('a private package may depend on its own scope\'s private package', async () => {
    const client = new MockInternalApiClient({
        ...allowedPublishFacts,
        dependencies: [{ key: 'me/secret', resolved: true, isPublic: false, ownedByAuthor: true }],
    }, dummyAccessFacts);
    const { client: s3, puts } = makeFakeS3();
    const app = buildApp(client, s3);
    await app.ready();

    const tgz = await makeTgz([{ name: 'LICENSE', content: 'MIT License text' }, { name: 'src/init.luau', content: 'return {}' }]);
    const { body, contentType } = buildMultipartBody([
        { name: 'metadata', value: JSON.stringify({ public: false }) },
        { name: 'forestJson', value: forestJsonFor({ dependencies: { 'me/secret': '^1.0.0' } }) },
        { name: 'file', value: tgz, filename: 'package.tgz', contentType: 'application/gzip' },
    ]);

    const res = await app.inject({
        method: 'POST', url: '/v1/package/upload',
        headers: { 'content-type': contentType, 'x-file-size': String(tgz.length), authorization: 'Bearer test' },
        payload: body,
    });

    assert.equal(res.statusCode, 200);
    assert.equal(puts.length, 1);
});

test('a backend that sends no dependency facts still publishes (older-backend compatibility)', async () => {
    const client = new MockInternalApiClient(allowedPublishFacts, dummyAccessFacts);
    const { client: s3, puts } = makeFakeS3();
    const app = buildApp(client, s3);
    await app.ready();

    const tgz = await makeTgz([{ name: 'LICENSE', content: 'MIT License text' }, { name: 'src/init.luau', content: 'return {}' }]);
    const { body, contentType } = buildMultipartBody([
        { name: 'metadata', value: JSON.stringify({ public: true }) },
        { name: 'forestJson', value: forestJsonFor({ dependencies: { 'scope/one': '^1.0.0' } }) },
        { name: 'file', value: tgz, filename: 'package.tgz', contentType: 'application/gzip' },
    ]);

    const res = await app.inject({
        method: 'POST', url: '/v1/package/upload',
        headers: { 'content-type': contentType, 'x-file-size': String(tgz.length), authorization: 'Bearer test' },
        payload: body,
    });

    assert.equal(res.statusCode, 200);
    assert.equal(puts.length, 1);
});

// --- roblox model files ------------------------------------------------------

const MIT_TEXT = 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy';
const REAL_LUAU = '-- real module\n' + 'local x = 1\n'.repeat(40) + 'return x\n';

async function makeTgzBin(entries: { name: string; content: string | Buffer }[]): Promise<Buffer> {
    const pack = tar.pack();
    for (const { name, content } of entries) pack.entry({ name }, content);
    pack.finalize();
    const gzip = createGzip();
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
        pack.pipe(gzip).on('data', c => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject);
    });
}

async function publishTgz(tgz: Buffer) {
    const client = new MockInternalApiClient(allowedPublishFacts, dummyAccessFacts);
    const { client: s3, puts } = makeFakeS3();
    const app = buildApp(client, s3);
    await app.ready();
    const { body, contentType } = buildMultipartBody([
        { name: 'metadata', value: JSON.stringify({ public: true }) },
        { name: 'forestJson', value: forestJsonFor() },
        { name: 'file', value: tgz, filename: 'package.tgz', contentType: 'application/gzip' },
    ]);
    const res = await app.inject({
        method: 'POST', url: '/v1/package/upload',
        headers: { 'content-type': contentType, 'x-file-size': String(tgz.length), authorization: 'Bearer test' },
        payload: body,
    });
    return { res, puts, client };
}

test('a roblox package with a script-bearing model file is rejected before R2 or record', async () => {
    const tgz = await makeTgzBin([
        { name: 'LICENSE', content: MIT_TEXT },
        { name: 'src/init.luau', content: REAL_LUAU },
        { name: 'assets/ui.rbxm', content: buildRbxm('LocalScript') },
    ]);
    const { res, puts, client } = await publishTgz(tgz);
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /LocalScript x1/);
    assert.equal(puts.length, 0, 'a script-bearing model must never reach R2');
    assert.equal(client.recordedCalls.length, 0);
});

test('a roblox package with a clean model file and real code publishes', async () => {
    const tgz = await makeTgzBin([
        { name: 'LICENSE', content: MIT_TEXT },
        { name: 'src/init.luau', content: REAL_LUAU },
        { name: 'assets/tree.rbxm', content: buildRbxm('Model') },
    ]);
    const { res, puts } = await publishTgz(tgz);
    assert.equal(res.statusCode, 200);
    assert.equal(puts.length, 1);
});

test('a model-only roblox package trips the code floor at the route level', async () => {
    const tgz = await makeTgzBin([
        { name: 'LICENSE', content: MIT_TEXT },
        { name: 'src/init.luau', content: 'return script.Model' },
        { name: 'Model.rbxm', content: buildRbxm('Model') },
    ]);
    const { res, puts } = await publishTgz(tgz);
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /code-first/);
    assert.equal(puts.length, 0);
});
