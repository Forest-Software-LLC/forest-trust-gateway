import test from 'node:test';
import assert from 'node:assert/strict';
import { hashToFilename, isDuplicateVersion } from '../../src/rules/contentAddress.ts';

test('hashToFilename derives the storage key from the hash alone', () => {
    assert.equal(
        hashToFilename('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'),
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.tgz'
    );
});

test('isDuplicateVersion detects an existing version', () => {
    assert.equal(isDuplicateVersion(['1.0.0', '1.1.0'], '1.1.0'), true);
});

test('isDuplicateVersion allows a genuinely new version', () => {
    assert.equal(isDuplicateVersion(['1.0.0', '1.1.0'], '1.2.0'), false);
});

test('isDuplicateVersion on an empty package always allows the first version', () => {
    assert.equal(isDuplicateVersion([], '0.1.0'), false);
});
