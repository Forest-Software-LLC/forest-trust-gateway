import test from 'node:test';
import assert from 'node:assert/strict';
import { BackendInternalApiClient } from '../src/internalApiClient.ts';

function fakeFetch(responses: Record<string, unknown>) {
    const calls: { url: string; init: any }[] = [];
    const fn = (async (url: string, init: any) => {
        calls.push({ url, init });
        const path = new URL(url).pathname;
        return {
            ok: true,
            json: async () => responses[path] ?? {},
        } as Response;
    }) as typeof fetch;
    return { fn, calls };
}

test('publish-authorization forwards the Authorization header and the internal secret, never a real user credential of its own', async () => {
    const { fn, calls } = fakeFetch({ '/internal/publish-authorization': { authenticated: true, membershipLevel: 2, packageAlreadyExists: false, hasWriteGrant: false } });
    const client = new BackendInternalApiClient('https://backend.internal', 'shh-internal-secret', fn);

    const facts = await client.getPublishAuthorization({ authorizationHeader: 'Bearer usertoken', scope: 's', name: 'n', platform: 'roblox' });

    assert.equal(facts.membershipLevel, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers['Authorization'], 'Bearer usertoken');
    assert.equal(calls[0].init.headers['X-Internal-Secret'], 'shh-internal-secret');
    assert.equal(calls[0].init.method, 'POST');
});

test('access-facts is a GET with query params, and omits Authorization when the caller sent none', async () => {
    const { fn, calls } = fakeFetch({ '/internal/access-facts': { isPublic: true, isOwnerMatch: false, isOrganizationOwned: false, membershipRank: null, hasPackageAccessGrant: false, hash: 'h', storagePath: 'public/h.tgz' } });
    const client = new BackendInternalApiClient('https://backend.internal', 'secret', fn);

    const facts = await client.getAccessFacts({ scope: 's', name: 'n', platform: 'roblox', version: '1.0.0' });

    assert.equal(facts.isPublic, true);
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.headers['Authorization'], undefined);
    assert.ok(calls[0].url.includes('scope=s'));
});

test('verify-license is a POST carrying the declared license and captured text, no Authorization header needed', async () => {
    const { fn, calls } = fakeFetch({ '/internal/verify-license': { ok: true, rating: 'safe', caveats: [], verified: true, needsAiScan: false } });
    const client = new BackendInternalApiClient('https://backend.internal', 'secret', fn);

    const verdict = await client.verifyLicense({ scope: 's', name: 'n', declaredLicense: 'MIT', licenseText: 'MIT License...', isPublic: true });

    assert.equal(verdict.ok, true);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(JSON.parse(calls[0].init.body).declaredLicense, 'MIT');
    assert.equal(calls[0].init.headers['Authorization'], undefined);
});

test('a non-OK response throws rather than silently returning empty facts', async () => {
    const fn = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    const client = new BackendInternalApiClient('https://backend.internal', 'secret', fn);
    await assert.rejects(() => client.getPublishAuthorization({ scope: 's', name: 'n', platform: 'roblox' }));
});
