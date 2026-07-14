import test from 'node:test';
import assert from 'node:assert/strict';
import { decidePublishPermission } from '../../src/rules/publishPolicy.ts';

test('a non-member (level 0) is always denied', () => {
    const result = decidePublishPermission({ membershipLevel: 0, packageAlreadyExists: true, hasWriteGrant: true });
    assert.equal(result.allowed, false);
});

test('a member (level 1) cannot create a brand-new package', () => {
    const result = decidePublishPermission({ membershipLevel: 1, packageAlreadyExists: false, hasWriteGrant: true });
    assert.equal(result.allowed, false);
    if (!result.allowed) assert.match(result.reason, /admin or owner rank/i);
});

test('a member (level 1) without a write grant cannot publish an existing package', () => {
    const result = decidePublishPermission({ membershipLevel: 1, packageAlreadyExists: true, hasWriteGrant: false });
    assert.equal(result.allowed, false);
    if (!result.allowed) assert.match(result.reason, /write grant/i);
});

test('a member (level 1) WITH a write grant can publish an existing package', () => {
    const result = decidePublishPermission({ membershipLevel: 1, packageAlreadyExists: true, hasWriteGrant: true });
    assert.equal(result.allowed, true);
});

test('an admin/owner (level 2+) can always publish, new package or not, grant or not', () => {
    assert.equal(decidePublishPermission({ membershipLevel: 2, packageAlreadyExists: false, hasWriteGrant: false }).allowed, true);
    assert.equal(decidePublishPermission({ membershipLevel: 3, packageAlreadyExists: true, hasWriteGrant: false }).allowed, true);
});
