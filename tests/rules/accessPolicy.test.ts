import test from 'node:test';
import assert from 'node:assert/strict';
import { decidePackageAccess } from '../../src/rules/accessPolicy.ts';
import type { PackageAccessFacts } from '../../src/rules/accessPolicy.ts';

const denyAll: PackageAccessFacts = {
    isPublic: false,
    isOwnerMatch: false,
    isOrganizationOwned: false,
    membershipRank: null,
    hasPackageAccessGrant: false,
};

test('public packages are always accessible, regardless of any other fact', () => {
    assert.equal(decidePackageAccess({ ...denyAll, isPublic: true }), true);
});

test('an unauthenticated request (all facts false/null) is denied for a private package', () => {
    assert.equal(decidePackageAccess(denyAll), false);
});

test('the direct owner of a private package is granted access', () => {
    assert.equal(decidePackageAccess({ ...denyAll, isOwnerMatch: true }), true);
});

test('an org owner is granted access to the org\'s private packages', () => {
    assert.equal(decidePackageAccess({ ...denyAll, isOrganizationOwned: true, membershipRank: 'owner' }), true);
});

test('an org admin is granted access to the org\'s private packages', () => {
    assert.equal(decidePackageAccess({ ...denyAll, isOrganizationOwned: true, membershipRank: 'admin' }), true);
});

test('a plain org member with no explicit grant is denied', () => {
    assert.equal(decidePackageAccess({ ...denyAll, isOrganizationOwned: true, membershipRank: 'member' }), false);
});

test('a plain org member WITH an explicit PackageAccess grant is allowed', () => {
    assert.equal(decidePackageAccess({ ...denyAll, isOrganizationOwned: true, membershipRank: 'member', hasPackageAccessGrant: true }), true);
});

test('a non-member of the owning org with a stray grant flag is still denied unless isOrganizationOwned is true', () => {
    // Guards against a caller accidentally setting hasPackageAccessGrant without isOrganizationOwned
    assert.equal(decidePackageAccess({ ...denyAll, hasPackageAccessGrant: true }), false);
});
