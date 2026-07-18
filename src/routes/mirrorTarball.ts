/*
    mirrorTarball.ts

    PUT /internal/mirror-tarball?hash=<sha256hex> — the wally-mirror ingest.

    forest-backend's wally sync job converts upstream wally packages into
    forest tarballs, but (by design, since the trust split) holds no storage
    credentials — it pushes the bytes here instead. The guarantee this route
    keeps is the same content-addressing rule as publish: the object key is
    derived from the sha256 of the bytes ACTUALLY RECEIVED, and the caller's
    claimed hash must match it. A compromised caller can therefore only ever
    ADD content-addressed objects — it can never overwrite or replace an
    existing tarball, because same key implies same bytes.

    Auth is x-mirror-secret (GATEWAY_MIRROR_SECRET) — deliberately a
    dedicated secret rather than INTERNAL_API_SECRET: it grants a different
    capability (storage writes) in the opposite call direction, and should
    be rotatable/revocable on its own.
*/

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { S3Client } from '@aws-sdk/client-s3';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { hashToFilename } from '../rules/index.ts';
import { putPackageObject } from '../uploader.ts';

export interface MirrorTarballRouteDeps {
    s3: S3Client;
    bucketName: string;
    mirrorSecret: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function secretMatches(provided: unknown, expected: string): boolean {
    if (typeof provided !== 'string') return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

export function registerMirrorTarballRoute(fastify: FastifyInstance, deps: MirrorTarballRouteDeps) {
    fastify.put('/internal/mirror-tarball', async (request: FastifyRequest, reply: FastifyReply) => {
        if (!secretMatches(request.headers['x-mirror-secret'], deps.mirrorSecret)) {
            return reply.status(401).send({ error: 'Unauthorized' });
        }

        const hash = (request.query as Record<string, unknown>)['hash'];
        if (typeof hash !== 'string' || !SHA256_HEX.test(hash)) {
            return reply.status(400).send({ error: 'hash must be 64 lowercase hex characters' });
        }

        const body = request.body;
        if (!Buffer.isBuffer(body) || body.length === 0) {
            return reply.status(400).send({ error: 'body must be the raw tgz bytes (Content-Type: application/gzip)' });
        }

        const actual = createHash('sha256').update(body).digest('hex');
        if (actual !== hash) {
            return reply.status(400).send({ error: 'hash-mismatch', claimed: hash, actual });
        }

        const key = `public/${hashToFilename(hash)}`;
        try {
            await deps.s3.send(new HeadObjectCommand({ Bucket: deps.bucketName, Key: key }));
            // Content-addressed: existing means byte-identical by construction.
            return reply.status(200).send({ existed: true, key });
        } catch {
            /* absent — write it */
        }
        await putPackageObject(deps.s3, deps.bucketName, key, body);
        return reply.status(201).send({ key });
    });
}
