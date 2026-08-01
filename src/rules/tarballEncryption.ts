/*
    tarballEncryption.ts

    Encryption-at-rest key derivation for private package tarballs.

    Private objects are stored with R2 SSE-C (customer-provided AES-256
    keys): R2 encrypts on write and will not return the bytes — on any
    path, including a public bucket URL — unless the same key accompanies
    the read. The per-object key is derived, never stored:

        objectKey = HMAC-SHA256(masterKey, "private/<sha256>.tgz")

    Deriving from the full storage key means the only two holders of the
    master secret (this service, which writes, and forest-cdn-worker,
    which reads) can each recompute an object's key from nothing but its
    path — no key material is persisted per package, and one object's key
    reveals nothing about any other's. The same derivation is implemented
    against WebCrypto in forest-cdn-worker; the shared test vector in
    tests/rules/tarballEncryption.test.ts keeps the two in lockstep.

    Public and mirrored tarballs are deliberately NOT encrypted as they are
    world-readable by design, and plaintext keeps the CDN passthrough path
    untouched for them.
*/

import { createHmac } from 'node:crypto';

export const TARBALL_ENC_KEY_BYTES = 32;


// The master key arrives as base64 and must decode to exactly 32 bytes.
export function decodeTarballEncKey(base64: string): Buffer {
    const key = Buffer.from(base64, 'base64');
    if (key.length !== TARBALL_ENC_KEY_BYTES) {
        throw new Error(`TARBALL_ENC_KEY must be base64 of exactly ${TARBALL_ENC_KEY_BYTES} bytes (got ${key.length})`);
    }
    return key;
}

export function deriveObjectEncryptionKey(masterKey: Buffer, storageKey: string): Buffer {
    return createHmac('sha256', masterKey).update(storageKey, 'utf8').digest();
}
