import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { createS3Client } from './uploader.ts';
import { BackendInternalApiClient } from './internalApiClient.ts';
import { registerPublishRoute } from './routes/publish.ts';
import { registerAccessRoute } from './routes/access.ts';

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} must be set`);
    return value;
}

async function main() {
    const fastify = Fastify({ logger: true });
    // The fileSize limit matters doubly here: publish.ts buffers the upload
    // fully in memory before validating, so without this cap a hostile
    // client could exhaust the container's RAM long before validateTgz's
    // own (post-buffering) 10MB check ever ran.
    await fastify.register(multipart, {
        limits: {
            fileSize: 10 * 1024 * 1024, // 10 MB
        },
    });

    const s3 = createS3Client({
        region: process.env.R2_REGION || 'auto',
        endpoint: requireEnv('R2_ENDPOINT'),
        accessKeyId: requireEnv('R2_ACCESS_KEY'),
        secretAccessKey: requireEnv('R2_SECRET'),
        bucketName: requireEnv('R2_BUCKET_NAME'),
    });

    const internalApi = new BackendInternalApiClient(
        requireEnv('BACKEND_INTERNAL_BASE_URL'),
        requireEnv('INTERNAL_API_SECRET')
    );

    const cdnBaseUrl = requireEnv('CDN_BASE_URL');
    const workerSigKey = requireEnv('WORKER_SIG_KEY');
    const bucketName = requireEnv('R2_BUCKET_NAME');

    registerPublishRoute(fastify, { internalApi, s3, bucketName, cdnBaseUrl });
    registerAccessRoute(fastify, { internalApi, workerSigKey, cdnBaseUrl });

    const port = Number(process.env.PORT || 8081);
    await fastify.listen({ port, host: '0.0.0.0' });
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
