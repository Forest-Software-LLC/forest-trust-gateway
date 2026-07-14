import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { generateSignedUrl } from '../../src/rules/signedUrl.ts';

test('the signature is independently reproducible from the same key and pathname', () => {
    const key = 'test-signing-key';
    const url = generateSignedUrl('https://registry.forest.dev/private/abc123.tgz', key, 300);

    const parsed = new URL(url);
    const expires = parsed.searchParams.get('expires');
    const signature = parsed.searchParams.get('signature');

    const expected = createHmac('sha256', key)
        .update(`${parsed.pathname}?expires=${expires}`)
        .digest('hex');

    assert.equal(signature, expected);
});

test('a different key produces a different, non-matching signature', () => {
    const url = generateSignedUrl('https://registry.forest.dev/private/abc123.tgz', 'key-one', 300);
    const parsed = new URL(url);
    const wrongKeySignature = createHmac('sha256', 'key-two')
        .update(`${parsed.pathname}?expires=${parsed.searchParams.get('expires')}`)
        .digest('hex');

    assert.notEqual(parsed.searchParams.get('signature'), wrongKeySignature);
});

test('the signature only covers the pathname, not the host', () => {
    const key = 'test-signing-key';
    const url = generateSignedUrl('https://registry.forest.dev/private/abc123.tgz', key, 300);
    const parsed = new URL(url);
    const expires = parsed.searchParams.get('expires');

    // Same pathname, different host — signature must still verify, proving
    // the host is deliberately excluded from what's signed.
    const sameSignatureDifferentHost = createHmac('sha256', key)
        .update(`/private/abc123.tgz?expires=${expires}`)
        .digest('hex');

    assert.equal(parsed.searchParams.get('signature'), sameSignatureDifferentHost);
});

test('expires is set roughly expiresInSec seconds in the future', () => {
    const before = Math.floor(Date.now() / 1000);
    const url = generateSignedUrl('https://registry.forest.dev/private/abc123.tgz', 'k', 300);
    const expires = Number(new URL(url).searchParams.get('expires'));

    assert.ok(expires >= before + 299 && expires <= before + 301);
});
