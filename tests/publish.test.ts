import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createGzip } from 'node:zlib';
import tar from 'tar-stream';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { registerPublishRoute } from '../src/routes/publish.ts';
import { MockInternalApiClient, allowedPublishFacts, deniedPublishFacts, rejectedLicenseVerdict, deniedAccessFacts } from './mockInternalApiClient.ts';
import { buildMultipartBody } from './multipartHelper.ts';

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
    const puts: { key: string; body: Buffer }[] = [];
    return {
        client: {
            send: async (command: any) => {
                puts.push({ key: command.input.Key, body: Buffer.from(command.input.Body) });
                return {};
            },
        } as any,
        puts,
    };
}

const dummyAccessFacts = deniedAccessFacts;

function buildApp(client: MockInternalApiClient, s3: any, fileSizeLimit = 10 * 1024 * 1024) {
    const fastify = Fastify();
    // Same registration shape as src/server.ts — the fileSize limit is part
    // of the contract under test (see the oversized-upload tests below).
    fastify.register(multipart, { limits: { fileSize: fileSizeLimit } });
    registerPublishRoute(fastify, { internalApi: client, s3, bucketName: 'test-bucket', cdnBaseUrl: 'https://registry.forest.dev' });
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

    // What the license means is forest-backend's call, not this gateway's —
    // but the gateway must still forward exactly what it captured from the
    // archive, so the backend's rating is grounded in the real file.
    assert.equal(client.verifyLicenseCalls.length, 1);
    assert.equal(client.verifyLicenseCalls[0].declaredLicense, 'MIT');
    assert.match(client.verifyLicenseCalls[0].licenseText ?? '', /permission is hereby granted/i);
    assert.equal(client.verifyLicenseCalls[0].isPublic, true);
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
