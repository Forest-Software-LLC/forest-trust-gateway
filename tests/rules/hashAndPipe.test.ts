import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { hashAndPipe } from '../../src/rules/hashAndPipe.ts';

// A fake sink that just collects whatever bytes it actually receives —
// standing in for the real S3 upload stream, with no credentials needed.
function fakeSink() {
    const received: Buffer[] = [];
    const sink = new Writable({
        write(chunk, _enc, callback) {
            received.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            callback();
        },
    });
    return { sink, received: () => Buffer.concat(received) };
}

test('the returned hash matches sha256 of exactly what the sink received', async () => {
    const payload = Buffer.from('this is the exact package content');
    const { sink, received } = fakeSink();

    const { hash } = await hashAndPipe(Readable.from(payload), sink);

    assert.equal(received().toString(), payload.toString());
    assert.equal(hash, createHash('sha256').update(payload).digest('hex'));
});

test('the invariant holds across many small, oddly-sized chunks, not just one write', async () => {
    // Deliberately chunk the source into single bytes to exercise the tap
    // across many 'data' events rather than one — the hash must still equal
    // sha256 of the full reassembled content the sink received.
    const payload = Buffer.from('streaming this one byte at a time to be thorough');
    const chunks = Array.from(payload).map(b => Buffer.from([b]));
    const { sink, received } = fakeSink();

    const { hash } = await hashAndPipe(Readable.from(chunks), sink);

    assert.equal(received().toString(), payload.toString());
    assert.equal(hash, createHash('sha256').update(payload).digest('hex'));
});

test('different content produces a different hash, and the sink still received exactly that content', async () => {
    const payloadA = Buffer.from('original, legitimate tarball bytes');
    const payloadB = Buffer.from('a totally different payload, e.g. tampered content');
    const sinkA = fakeSink();
    const sinkB = fakeSink();

    const resultA = await hashAndPipe(Readable.from(payloadA), sinkA.sink);
    const resultB = await hashAndPipe(Readable.from(payloadB), sinkB.sink);

    assert.notEqual(resultA.hash, resultB.hash);
    // The point of this module: whatever the sink got is exactly what got hashed,
    // for each independently — there's no shared state or reuse across calls.
    assert.equal(resultA.hash, createHash('sha256').update(sinkA.received()).digest('hex'));
    assert.equal(resultB.hash, createHash('sha256').update(sinkB.received()).digest('hex'));
});
