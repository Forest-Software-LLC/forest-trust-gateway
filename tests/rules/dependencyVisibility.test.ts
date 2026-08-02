import test from 'node:test';
import assert from 'node:assert/strict';
import { decideDependencyVisibility } from '../../src/rules/dependencyVisibility.ts';

const publicDep = { key: 'someone/utils', resolved: true, isPublic: true, ownedByAuthor: false };
const ownPrivateDep = { key: 'me/secret', resolved: true, isPublic: false, ownedByAuthor: true };
const foreignPrivateDep = { key: 'them/secret', resolved: true, isPublic: false, ownedByAuthor: false };
const unresolvedDep = { key: 'nobody/nothing', resolved: false, isPublic: false, ownedByAuthor: false };

test('no dependencies at all is allowed, public or private', () => {
    assert.equal(decideDependencyVisibility({ isPublic: true, dependencies: [] }).allowed, true);
    assert.equal(decideDependencyVisibility({ isPublic: false, dependencies: [] }).allowed, true);
});

test('public dependencies are allowed for both public and private packages', () => {
    assert.equal(decideDependencyVisibility({ isPublic: true, dependencies: [publicDep] }).allowed, true);
    assert.equal(decideDependencyVisibility({ isPublic: false, dependencies: [publicDep] }).allowed, true);
});

test('a public package may not depend on a private package, even its own', () => {
    const result = decideDependencyVisibility({ isPublic: true, dependencies: [ownPrivateDep] });
    assert.equal(result.allowed, false);
    assert.match((result as { reason: string }).reason, /public package cannot depend on private/i);
    assert.match((result as { reason: string }).reason, /me\/secret/);
});

test('a private package may depend on its own scope\'s private packages', () => {
    const result = decideDependencyVisibility({ isPublic: false, dependencies: [ownPrivateDep, publicDep] });
    assert.equal(result.allowed, true);
});

test('a private package may not depend on another scope\'s private package', () => {
    const result = decideDependencyVisibility({ isPublic: false, dependencies: [foreignPrivateDep] });
    assert.equal(result.allowed, false);
    assert.match((result as { reason: string }).reason, /owned by the same scope/i);
    assert.match((result as { reason: string }).reason, /them\/secret/);
});

test('the rejection names every offending dependency, deterministically ordered', () => {
    const result = decideDependencyVisibility({
        isPublic: false,
        dependencies: [
            { key: 'z/one', resolved: true, isPublic: false, ownedByAuthor: false },
            { key: 'a/two', resolved: true, isPublic: false, ownedByAuthor: false },
            ownPrivateDep,
            publicDep,
        ],
    });
    assert.equal(result.allowed, false);
    const reason = (result as { reason: string }).reason;
    assert.match(reason, /a\/two, z\/one/);
    // Only the offending ones are named — a legal dependency is not implied to be at fault.
    assert.doesNotMatch(reason, /me\/secret/);
    assert.doesNotMatch(reason, /someone\/utils/);
});

test('unresolved dependencies are ignored, not treated as private', () => {
    // Publish has never verified dependency existence; a typo must keep
    // failing at install time rather than becoming a new publish rejection.
    assert.equal(decideDependencyVisibility({ isPublic: true, dependencies: [unresolvedDep] }).allowed, true);
    assert.equal(decideDependencyVisibility({ isPublic: false, dependencies: [unresolvedDep] }).allowed, true);
});

test('a public package with a foreign private dependency reports the public rule, not the ownership one', () => {
    // The public rule is the stricter, more explanatory one — being told to
    // "use your own scope's private package" would be actively wrong advice.
    const result = decideDependencyVisibility({ isPublic: true, dependencies: [foreignPrivateDep] });
    assert.equal(result.allowed, false);
    assert.match((result as { reason: string }).reason, /public package cannot depend on private/i);
});
