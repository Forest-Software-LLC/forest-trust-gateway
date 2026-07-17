/*
    publish.ts

    POST /v1/package/upload — the package publish endpoint, served at
    packages.forest.dev.

    File bytes never reach the backend. This handler validates and hashes
    the package itself using this service's public rules (src/rules/); the
    backend only ever sees small JSON calls (was this allowed, what does
    this license mean, record what happened), never the tarball itself.
    License *rating* is the backend's call — see verifyLicense below — but
    a rejection there still happens before anything is written to R2.
*/

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PassThrough, Readable } from 'stream';
import {
    validateTgz,
    hashAndPipe,
    decidePublishPermission,
    hashToFilename,
} from '../rules/index.ts';
import { PackageMetadataSchema, ForestJsonSchema } from '../schemas.ts';
import type { ForestJson, PackageMetadata } from '../schemas.ts';
import { InternalApiError } from '../internalApiClient.ts';
import type { InternalApiClient } from '../internalApiClient.ts';
import type { S3Client } from '@aws-sdk/client-s3';
import { createBufferingSink, putPackageObject } from '../uploader.ts';

export interface PublishRouteDeps {
    internalApi: InternalApiClient;
    s3: S3Client;
    bucketName: string;
    cdnBaseUrl: string; // e.g. https://registry.forest.dev
}

export function registerPublishRoute(fastify: FastifyInstance, deps: PublishRouteDeps) {
    fastify.post('/v1/package/upload', async (request: FastifyRequest, reply: FastifyReply) => {
        // Required for CLI compatibility, and useful as a cheap early
        // reject — but it's only a client-declared hint. The enforced cap
        // is the multipart fileSize limit + validateTgz, not this number.
        const fileSizeHeader = request.headers['x-file-size'];
        if (!fileSizeHeader) {
            return reply.status(400).send({ error: 'Missing required header: x-file-size' });
        }
        const declaredSize = parseInt(fileSizeHeader as string, 10);
        if (Number.isFinite(declaredSize) && declaredSize > 10 * 1024 * 1024) {
            return reply.status(413).send({ error: 'File exceeds the 10MB package size limit' });
        }

        let metadata: PackageMetadata | undefined;
        let forestJson: ForestJson | undefined;
        let fileBuffer: Buffer | undefined;

        // Packages are capped at 10MB (enforced below by validateTgz), so the
        // file is fully buffered during multipart parsing rather than teed
        // live into validation/hashing — that avoids a real timing hazard:
        // this handler does an async permission check between reading the
        // file part and starting validation, and nothing would be draining
        // a live PassThrough tee during that gap, risking a stalled/truncated
        // stream. Buffering first means validation and hashing each get an
        // already-complete, independent stream to read from at their own pace.
        for await (const part of (request as any).parts()) {
            if (part.type === 'file') {
                if (!metadata || !forestJson) {
                    return reply.status(400).send({ error: 'Required fields: metadata and forestJson must be provided before the file.' });
                }
                if (fileBuffer) {
                    return reply.status(400).send({ error: 'Only one file can be uploaded at a time.' });
                }
                const chunks: Buffer[] = [];
                for await (const chunk of part.file) {
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                }
                // busboy TRUNCATES at the multipart fileSize limit rather
                // than erroring — manual chunk iteration like the loop above
                // silently yields a cut-off buffer, so this flag is the only
                // signal the cap was hit. Without this check a >10MB upload
                // would proceed into validation as a corrupt-but-plausible
                // prefix of itself.
                if (part.file.truncated) {
                    return reply.status(413).send({ error: 'File exceeds the 10MB package size limit' });
                }
                fileBuffer = Buffer.concat(chunks);
            } else {
                try {
                    const raw = JSON.parse(part.value as string);
                    if (part.fieldname === 'metadata') {
                        metadata = PackageMetadataSchema.parse(raw);
                    } else if (part.fieldname === 'forestJson') {
                        forestJson = ForestJsonSchema.parse(raw);
                    }
                } catch {
                    return reply.status(400).send({ error: `Invalid JSON format for field ${part.fieldname}` });
                }
            }
        }

        if (!fileBuffer || !metadata || !forestJson) {
            return reply.status(400).send({ error: 'Required fields: metadata, forestJson, and file must all be provided' });
        }
        if (!forestJson.platform) {
            return reply.status(400).send({ error: 'forestJson.platform is required' });
        }

        // Authorization check before any validation/hashing/storage work —
        // the file is already buffered in memory at this point (multipart
        // parsing needs to finish regardless), but nothing has touched R2 or
        // run the tarball through validateTgz yet, and a denial here means
        // none of that ever happens.
        const facts = await deps.internalApi.getPublishAuthorization({
            authorizationHeader: request.headers.authorization,
            scope: forestJson.author,
            name: forestJson.name,
            platform: forestJson.platform,
            isPublic: metadata.public === true,
        });

        if (!facts.authenticated) {
            return reply.status(401).send({ error: 'Unauthorized' });
        }

        const permission = decidePublishPermission({
            membershipLevel: facts.membershipLevel,
            packageAlreadyExists: facts.packageAlreadyExists,
            hasWriteGrant: facts.hasWriteGrant,
        });
        if (!permission.allowed) {
            return reply.status(403).send({ error: permission.reason });
        }

        // A business-rule block (free-tier limits) is deliberately separate
        // from decidePublishPermission — checked only after the public rule
        // has already allowed the request, so an unauthorized caller never
        // learns anything about an org's billing status. Two distinct
        // status codes: 429 (with Retry-After) for a publish cooldown,
        // 403 for an over-limit Studio.
        if (facts.blockedReason) {
            if (facts.retryAfterSeconds) {
                reply.header('Retry-After', String(facts.retryAfterSeconds));
                return reply.status(429).send({ error: facts.blockedReason });
            }
            return reply.status(403).send({ error: facts.blockedReason });
        }

        // Validate + hash — the actual trust-critical work. Each consumer
        // gets its own fresh stream over the same already-complete buffer;
        // hashAndPipe's sink also collects into a buffer, so its returned
        // hash and the bytes it stored describe the same content by
        // construction (see uploader.ts), not by trusting a second read.
        const validatePass = new PassThrough();
        validatePass.end(fileBuffer);
        const licenseCapture: { text?: string } = {};
        const validatePipeline = validateTgz(validatePass, { licenseCapture });
        const { sink: bufferSink, getBuffer } = createBufferingSink();

        let hashResult: { hash: string };
        try {
            const [, hashOutcome] = await Promise.all([
                validatePipeline,
                hashAndPipe(Readable.from(fileBuffer), bufferSink),
            ]);
            hashResult = hashOutcome as { hash: string };
        } catch (err) {
            return reply.status(400).send({ error: `File validation failed: ${(err as Error).message}` });
        }

        // What the license actually means is the backend's call, not this
        // service's — it rates the LICENSE text validateTgz just captured
        // against the declared license. A rejection here happens before
        // anything is written to R2: a detected mismatch is never persisted.
        const licenseVerdict = await deps.internalApi.verifyLicense({
            scope: forestJson.author,
            name: forestJson.name,
            declaredLicense: forestJson.license,
            licenseText: licenseCapture.text,
            isPublic: metadata.public === true,
        });
        if (!licenseVerdict.ok) {
            return reply.status(400).send({ error: licenseVerdict.reason });
        }

        // Only now, with the hash known and the license accepted, do we
        // touch R2 at all — one direct put to the real, content-addressed
        // key. Nothing temporary, nothing to clean up if an earlier step
        // had failed.
        const finalKey = `${metadata.public ? 'public' : 'private'}/${hashToFilename(hashResult.hash)}`;
        await putPackageObject(deps.s3, deps.bucketName, finalKey, getBuffer());

        try {
            await deps.internalApi.recordPublishedVersion({
                scope: forestJson.author,
                name: forestJson.name,
                platform: forestJson.platform,
                version: forestJson.version,
                hash: hashResult.hash,
                archiveRoot: forestJson.root,
                readme: metadata.readme,
                description: forestJson.description,
                declaredLicense: forestJson.license,
                licenseRating: licenseVerdict.rating,
                licenseCaveats: licenseVerdict.caveats,
                licenseVerified: licenseVerdict.verified,
                needsAiScan: licenseVerdict.needsAiScan,
                licenseText: licenseCapture.text,
                isPublic: metadata.public === true,
                // Normalize string shorthand to object form.
                dependencies: Object.fromEntries(
                    Object.entries(forestJson.dependencies).map(([k, v]) =>
                        [k, typeof v === 'string' ? { version: v } : v]
                    )
                ),
            }, request.headers.authorization);
        } catch (err) {
            if (err instanceof InternalApiError) {
                return reply.status(err.status).send({ error: err.apiError });
            }
            throw err;
        }

        return reply.status(200).send({ version: forestJson.version, hash: hashResult.hash });
    });
}
