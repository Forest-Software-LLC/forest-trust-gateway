import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createHmac } from 'node:crypto';
import { registerAccessRoute } from '../src/routes/access.ts';
import { MockInternalApiClient, deniedAccessFacts, publicAccessFacts } from './mockInternalApiClient.ts';
import type { AccessFacts } from '../src/internalApiClient.ts';

const CDN_BASE = 'https://registry.forest.dev';
const SIG_KEY = 'test-signing-key';

function buildApp(accessFacts: AccessFacts) {
    const fastify = Fastify();
    const client = new MockInternalApiClient(
        { authenticated: true, membershipLevel: 0, packageAlreadyExists: false, hasWriteGrant: false },
        accessFacts
    );
    registerAccessRoute(fastify, { internalApi: client, workerSigKey: SIG_KEY, cdnBaseUrl: CDN_BASE });
    return fastify;
}

test('a denied/nonexistent package 404s rather than revealing it exists', async () => {
    const app = buildApp(deniedAccessFacts);
    const res = await app.inject({ method: 'GET', url: '/v1/package/scope/roblox/pkg/1.0.0' });
    assert.equal(res.statusCode, 404);
});

test('a public package returns an unsigned, directly-usable URL', async () => {
    const app = buildApp(publicAccessFacts);
    const res = await app.inject({ method: 'GET', url: '/v1/package/scope/roblox/pkg/1.0.0' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.accessUrl, `${CDN_BASE}/public/abc123.tgz`);
});

test('the response reports the version forest-backend actually resolved to, not the raw request param', async () => {
    // publicAccessFacts.resolvedVersion is deliberately different from the
    // '1.0.0' in the request URL below — this is the real test that the
    // route uses the backend's semver-resolved version (a range/tag/omitted
    // version can resolve to something else entirely), not just echo back
    // whatever the caller happened to type in the path.
    const app = buildApp(publicAccessFacts);
    const res = await app.inject({ method: 'GET', url: '/v1/package/scope/roblox/pkg/1.0.0' });
    assert.equal(res.json().version, publicAccessFacts.resolvedVersion);
});

test('a granted package carries through the install metadata the CLI needs, not just the accessUrl', async () => {
    // The CLI needs more than the download URL to install a package:
    // archiveRoot (entry point), dependencies (dep tree), and the license
    // fields. Dropping any of these still yields a 200 with a valid
    // accessUrl, so nothing else in this suite would notice — this test
    // pins the full response shape.
    const app = buildApp(publicAccessFacts);
    const res = await app.inject({ method: 'GET', url: '/v1/package/scope/roblox/pkg/1.0.0' });
    const body = res.json();
    assert.equal(body.description, publicAccessFacts.description);
    assert.deepEqual(body.dependencies, publicAccessFacts.dependencies);
    assert.equal(body.license, publicAccessFacts.license);
    assert.equal(body.licenseRating, publicAccessFacts.licenseRating);
    assert.deepEqual(body.licenseCaveats, publicAccessFacts.licenseCaveats);
    assert.equal(body.licenseVerified, publicAccessFacts.licenseVerified);
    assert.equal(body.archiveRoot, publicAccessFacts.archiveRoot);
    assert.equal(body.public, publicAccessFacts.isPublic);
    assert.equal(body.integrity, publicAccessFacts.hash);
    assert.equal(body.ownerType, publicAccessFacts.ownerType);
});

test('a private package the caller is allowed to see gets a signed URL matching an independent HMAC recomputation', async () => {
    const privateAllowed: AccessFacts = {
        isPublic: false,
        isOwnerMatch: true,
        isOrganizationOwned: false,
        membershipRank: null,
        hasPackageAccessGrant: false,
        hash: 'def456',
        storagePath: 'private/def456.tgz',
        resolvedVersion: '2.0.0',
        description: null,
        dependencies: null,
        license: null,
        licenseRating: null,
        licenseCaveats: null,
        licenseVerified: null,
        archiveRoot: null,
        ownerType: null,
    };
    const app = buildApp(privateAllowed);
    const res = await app.inject({ method: 'GET', url: '/v1/package/scope/roblox/pkg/1.0.0' });
    assert.equal(res.statusCode, 200);

    const url = new URL(res.json().accessUrl);
    const expires = url.searchParams.get('expires');
    const expectedSig = createHmac('sha256', SIG_KEY)
        .update(`${url.pathname}?expires=${expires}`)
        .digest('hex');
    assert.equal(url.searchParams.get('signature'), expectedSig);
});

test('a private package caches nothing (no-store), unlike a public one', async () => {
    const privateAllowed: AccessFacts = {
        isPublic: false,
        isOwnerMatch: true,
        isOrganizationOwned: false,
        membershipRank: null,
        hasPackageAccessGrant: false,
        hash: 'def456',
        storagePath: 'private/def456.tgz',
        resolvedVersion: '2.0.0',
        description: null,
        dependencies: null,
        license: null,
        licenseRating: null,
        licenseCaveats: null,
        licenseVerified: null,
        archiveRoot: null,
        ownerType: null,
    };
    const app = buildApp(privateAllowed);
    const res = await app.inject({ method: 'GET', url: '/v1/package/scope/roblox/pkg/1.0.0' });
    assert.equal(res.headers['cache-control'], 'private, no-store');
});
