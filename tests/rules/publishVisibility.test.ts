import test from 'node:test';
import assert from 'node:assert/strict';
import { decidePublishVisibility } from '../../src/rules/publishVisibility.ts';

test('a new package takes the requested visibility, omitted meaning private', () => {
    assert.deepEqual(decidePublishVisibility({ requestedPublic: true, packageAlreadyExists: false, storedPublic: undefined }), { allowed: true, isPublic: true });
    assert.deepEqual(decidePublishVisibility({ requestedPublic: false, packageAlreadyExists: false, storedPublic: undefined }), { allowed: true, isPublic: false });
    assert.deepEqual(decidePublishVisibility({ requestedPublic: undefined, packageAlreadyExists: false, storedPublic: undefined }), { allowed: true, isPublic: false });
});

test('an existing package keeps its stored visibility when the request omits it', () => {
    // Omitted must not read as private: a public package downloads from public/.
    assert.deepEqual(decidePublishVisibility({ requestedPublic: undefined, packageAlreadyExists: true, storedPublic: true }), { allowed: true, isPublic: true });
    assert.deepEqual(decidePublishVisibility({ requestedPublic: undefined, packageAlreadyExists: true, storedPublic: false }), { allowed: true, isPublic: false });
});

test('an existing package accepts a request that agrees with its stored visibility', () => {
    assert.deepEqual(decidePublishVisibility({ requestedPublic: true, packageAlreadyExists: true, storedPublic: true }), { allowed: true, isPublic: true });
    assert.deepEqual(decidePublishVisibility({ requestedPublic: false, packageAlreadyExists: true, storedPublic: false }), { allowed: true, isPublic: false });
});

test('a request contradicting the stored visibility is refused, naming the real one', () => {
    const toPrivate = decidePublishVisibility({ requestedPublic: false, packageAlreadyExists: true, storedPublic: true });
    assert.equal(toPrivate.allowed, false);
    if (!toPrivate.allowed) assert.match(toPrivate.reason, /is public/);

    const toPublic = decidePublishVisibility({ requestedPublic: true, packageAlreadyExists: true, storedPublic: false });
    assert.equal(toPublic.allowed, false);
    if (!toPublic.allowed) assert.match(toPublic.reason, /is private/);
});

test('without the stored-visibility fact (older backend) the request decides, as before', () => {
    assert.deepEqual(decidePublishVisibility({ requestedPublic: true, packageAlreadyExists: true, storedPublic: undefined }), { allowed: true, isPublic: true });
    assert.deepEqual(decidePublishVisibility({ requestedPublic: undefined, packageAlreadyExists: true, storedPublic: undefined }), { allowed: true, isPublic: false });
});
