/*
    access.ts

    GET /v1/package/:scope/:platform/:name/:version — the package version
    info + download URL endpoint, served at packages.forest.dev. Resolves
    the requested version, checks access, and returns the content-addressed
    (and, for private packages, signed) download URL alongside the metadata
    the CLI needs to install.

    Denied packages 404 rather than 403 — a private package a caller can't
    access doesn't confirm its own existence.
*/

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { decidePackageAccess, generateSignedUrl } from '../rules/index.ts';
import { PlatformSchema } from '../schemas.ts';
import type { InternalApiClient } from '../internalApiClient.ts';

const paramsSchema = z.object({
    scope: z.string(),
    platform: PlatformSchema,
    name: z.string(),
    // A concrete version, a semver range, or a tag — the backend resolves
    // it (invalid/omitted range falls back to latest-stable) and reports
    // back the concrete version it landed on via resolvedVersion, which is
    // what the response actually uses.
    version: z.string(),
});

export interface AccessRouteDeps {
    internalApi: InternalApiClient;
    workerSigKey: string;
    cdnBaseUrl: string; // e.g. https://registry.forest.dev
    signedUrlExpirySec?: number;
}

export function registerAccessRoute(fastify: FastifyInstance, deps: AccessRouteDeps) {
    fastify.get('/v1/package/:scope/:platform/:name/:version', async (request: FastifyRequest, reply: FastifyReply) => {
        const parsed = paramsSchema.safeParse(request.params);
        if (!parsed.success) {
            return reply.status(400).send({ error: 'Invalid path parameters' });
        }
        const { scope, platform, name, version } = parsed.data;

        const facts = await deps.internalApi.getAccessFacts({
            authorizationHeader: request.headers.authorization,
            scope,
            name,
            platform,
            version,
        });

        const allowed = decidePackageAccess({
            isPublic: facts.isPublic,
            isOwnerMatch: facts.isOwnerMatch,
            isOrganizationOwned: facts.isOrganizationOwned,
            membershipRank: facts.membershipRank,
            hasPackageAccessGrant: facts.hasPackageAccessGrant,
        });

        // A private package a caller can't access doesn't confirm its own
        // existence — denied and nonexistent are indistinguishable.
        if (!allowed || !facts.hash || !facts.storagePath) {
            return reply.status(404).send({ error: 'Package not found' });
        }

        const rawUrl = `${deps.cdnBaseUrl}/${facts.storagePath}`;
        const accessUrl = facts.isPublic
            ? rawUrl
            : generateSignedUrl(rawUrl, deps.workerSigKey, deps.signedUrlExpirySec ?? 300);

        if (!facts.isPublic) {
            // Private tarballs sit behind the CDN worker's HMAC gate — the
            // signed URL expires in minutes, so this response must never be
            // shared-cached, unlike the route's normal week-long cache.
            reply.header('Cache-Control', 'private, no-store');
        } else if (facts.licenseRating === 'pending') {
            // The AI license review resolves seconds after publish — don't
            // pin a 'pending' rating into the shared cache for a week.
            reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=60');
        }

        return reply.status(200).send({
            // Canonical identity: names resolve case-insensitively, so the
            // URL's casing may differ from the stored one. The CLI uses these
            // to canonicalize what the user typed; null/absent (old backend
            // or a cached pre-field response) means "no canonical known".
            // Note differently-cased URLs are distinct edge-cache keys — the
            // shared cache may hold the same package under several casings,
            // all with identical canonical content.
            name: facts.name ?? null,
            scope: facts.scope ?? null,
            version: facts.resolvedVersion,
            description: facts.description,
            dependencies: facts.dependencies,
            license: facts.license,
            licenseRating: facts.licenseRating || 'unknown',
            licenseCaveats: facts.licenseCaveats || [],
            licenseVerified: facts.licenseVerified === true,
            accessUrl,
            archiveRoot: facts.archiveRoot,
            public: facts.isPublic,
            integrity: facts.hash,
            ownerType: facts.ownerType,
        });
    });
}
