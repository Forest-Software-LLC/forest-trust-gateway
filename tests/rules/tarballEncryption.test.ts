import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { decodeTarballEncKey, deriveObjectEncryptionKey, TARBALL_ENC_KEY_BYTES } from '../../src/rules/tarballEncryption.ts';

/*
    THE SHARED TEST VECTOR. forest-cdn-worker implements the same
    derivation against WebCrypto and asserts this exact vector
    (test/tarballEncryption.spec.ts there) — the two services only
    interoperate if both tests pass against these same constants. Change
    one side and the other MUST change with it.
*/
const VECTOR = {
    masterB64: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=', // utf8 "0123456789abcdef0123456789abcdef"
    storageKey: 'private/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.tgz',
    derivedHex: 'a44177118f91c80a726a2be68bafe1d782c2093952661157e24976dc9a0547e1',
};

test('the shared cross-service test vector derives exactly', () => {
    const master = decodeTarballEncKey(VECTOR.masterB64);
    const derived = deriveObjectEncryptionKey(master, VECTOR.storageKey);
    assert.equal(derived.toString('hex'), VECTOR.derivedHex);
});

test('derivation is plain HMAC-SHA256 over the utf8 storage key', () => {
    const master = decodeTarballEncKey(VECTOR.masterB64);
    const expected = createHmac('sha256', master).update(VECTOR.storageKey, 'utf8').digest('hex');
    assert.equal(deriveObjectEncryptionKey(master, VECTOR.storageKey).toString('hex'), expected);
});

test('derived keys are 32 bytes — the length SSE-C requires', () => {
    const master = decodeTarballEncKey(VECTOR.masterB64);
    assert.equal(deriveObjectEncryptionKey(master, VECTOR.storageKey).length, 32);
});

test('different storage keys derive unrelated keys', () => {
    const master = decodeTarballEncKey(VECTOR.masterB64);
    const other = deriveObjectEncryptionKey(master, 'private/0000000000000000000000000000000000000000000000000000000000000000.tgz');
    assert.notEqual(other.toString('hex'), VECTOR.derivedHex);
});

test('decodeTarballEncKey rejects keys that are not exactly 32 bytes', () => {
    assert.throws(() => decodeTarballEncKey(Buffer.alloc(16).toString('base64')));
    assert.throws(() => decodeTarballEncKey(Buffer.alloc(33).toString('base64')));
    assert.throws(() => decodeTarballEncKey('not-base64!!'));
    assert.equal(decodeTarballEncKey(Buffer.alloc(TARBALL_ENC_KEY_BYTES).toString('base64')).length, TARBALL_ENC_KEY_BYTES);
});
