/*
    hashAndPipe.ts

    Pipes `source` into `sink` while computing the SHA-256 of the exact bytes
    that pass through. This is the answer to a specific attack: could a
    compromised or malicious backend unzip an uploaded tarball, inject code,
    re-tar it, and hash THAT instead, so the database and the CDN agree on a
    hash that never corresponds to what the publisher actually sent?

    That's only possible if hashing and writing to storage happen as two
    separate steps with room for a rewrite in between. This function makes
    them the same step: the hash is computed from a tee on the literal bytes
    reaching the sink (via a shared 'data' listener on the tap, the same
    pattern Node's own `.pipe()` uses), not recomputed later from whatever
    ended up in storage. There is no point in this function where an
    unzip-and-inject step could sit without being visible in a one-screen
    diff — feed it a fake sink and confirm the returned hash always matches
    exactly what the sink received.

    Storage credentials never appear here: `sink` is any Writable the caller
    constructs (an S3 upload stream in Forest's case), injected rather than
    created inside this function.
*/

import { createHash } from 'crypto';
import { pipeline } from 'stream/promises';
import { PassThrough, Readable, Writable } from 'stream';

export async function hashAndPipe(source: Readable, sink: Writable): Promise<{ hash: string }> {
    const hasher = createHash('sha256');
    const tap = new PassThrough();
    tap.on('data', (chunk: Buffer) => hasher.update(chunk));

    await pipeline(source, tap, sink);

    return { hash: hasher.digest('hex') };
}
