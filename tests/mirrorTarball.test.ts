import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { registerMirrorTarballRoute } from '../src/routes/mirrorTarball.ts';

const SECRET = 'test-mirror-secret';

// Fake S3 with Head semantics: heads succeed only for keys already "stored",
// puts get recorded — so the created-vs-existed branch is testable.
function makeFakeS3(existingKeys: string[] = []) {
    const stored = new Set(existingKeys);
    const puts: { key: string; body: Buffer; contentType?: string }[] = [];
    return {
        client: {
            send: async (command: any) => {
                const name = command.constructor.name;
                if (name === 'HeadObjectCommand') {
                    if (stored.has(command.input.Key)) return {};
                    const err = new Error('NotFound');
                    (err as any).name = 'NotFound';
                    throw err;
                }
                puts.push({ key: command.input.Key, body: Buffer.from(command.input.Body), contentType: command.input.ContentType });
                stored.add(command.input.Key);
                return {};
            },
        } as any,
        puts,
    };
}

function buildApp(s3: any) {
    const fastify = Fastify();
    // Same parser shape as src/server.ts — the 10MB bodyLimit is part of the
    // contract under test.
    fastify.addContentTypeParser('application/gzip', { parseAs: 'buffer', bodyLimit: 10 * 1024 * 1024 },
        (_req, body, done) => done(null, body));
    registerMirrorTarballRoute(fastify, { s3, bucketName: 'test-bucket', mirrorSecret: SECRET });
    return fastify;
}

function tgzOf(content: Buffer): { body: Buffer; hash: string } {
    return { body: content, hash: createHash('sha256').update(content).digest('hex') };
}

test('a missing or wrong secret is rejected before anything touches storage', async () => {
    const { client: s3, puts } = makeFakeS3();
    const app = buildApp(s3);
    const { body, hash } = tgzOf(randomBytes(64));

    for (const headers of [{}, { 'x-mirror-secret': 'wrong' }]) {
        const res = await app.inject({
            method: 'PUT',
            url: `/internal/mirror-tarball?hash=${hash}`,
            headers: { 'content-type': 'application/gzip', ...headers },
            body,
        });
        assert.equal(res.statusCode, 401);
    }
    assert.equal(puts.length, 0);
});

test('a malformed hash parameter is rejected', async () => {
    const { client: s3, puts } = makeFakeS3();
    const app = buildApp(s3);
    const body = randomBytes(64);

    for (const bad of ['', 'abc', 'Z'.repeat(64), createHash('sha256').update(body).digest('hex').toUpperCase()]) {
        const res = await app.inject({
            method: 'PUT',
            url: `/internal/mirror-tarball?hash=${bad}`,
            headers: { 'content-type': 'application/gzip', 'x-mirror-secret': SECRET },
            body,
        });
        assert.equal(res.statusCode, 400, `hash: ${bad}`);
    }
    assert.equal(puts.length, 0);
});

test('a body that does not hash to the claimed value is rejected', async () => {
    const { client: s3, puts } = makeFakeS3();
    const app = buildApp(s3);
    const { hash } = tgzOf(Buffer.from('the real bytes'));

    const res = await app.inject({
        method: 'PUT',
        url: `/internal/mirror-tarball?hash=${hash}`,
        headers: { 'content-type': 'application/gzip', 'x-mirror-secret': SECRET },
        body: Buffer.from('tampered bytes'),
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'hash-mismatch');
    assert.equal(puts.length, 0);
});

test('a verified body is stored at its content-addressed public key', async () => {
    const { client: s3, puts } = makeFakeS3();
    const app = buildApp(s3);
    const { body, hash } = tgzOf(randomBytes(2048));

    const res = await app.inject({
        method: 'PUT',
        url: `/internal/mirror-tarball?hash=${hash}`,
        headers: { 'content-type': 'application/gzip', 'x-mirror-secret': SECRET },
        body,
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().key, `public/${hash}.tgz`);
    assert.equal(puts.length, 1);
    assert.equal(puts[0].key, `public/${hash}.tgz`);
    assert.ok(puts[0].body.equals(body));
    assert.equal(puts[0].contentType, 'application/gzip');
});

test('an already-stored key replies 200 existed and writes nothing', async () => {
    const { body, hash } = tgzOf(randomBytes(512));
    const { client: s3, puts } = makeFakeS3([`public/${hash}.tgz`]);
    const app = buildApp(s3);

    const res = await app.inject({
        method: 'PUT',
        url: `/internal/mirror-tarball?hash=${hash}`,
        headers: { 'content-type': 'application/gzip', 'x-mirror-secret': SECRET },
        body,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().existed, true);
    assert.equal(puts.length, 0);
});

test('bodies past the 10MB package cap are refused by the parser', async () => {
    const { client: s3, puts } = makeFakeS3();
    const app = buildApp(s3);
    const body = randomBytes(11 * 1024 * 1024);
    const hash = createHash('sha256').update(body).digest('hex');

    const res = await app.inject({
        method: 'PUT',
        url: `/internal/mirror-tarball?hash=${hash}`,
        headers: { 'content-type': 'application/gzip', 'x-mirror-secret': SECRET },
        body,
    });
    assert.equal(res.statusCode, 413);
    assert.equal(puts.length, 0);
});
