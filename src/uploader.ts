/*
    uploader.ts

    R2 access, scoped to exactly what this service needs: writing package
    tarballs. This service should be issued its own credentials, scoped
    (if the storage provider's policies support it) to only the packages
    bucket — never shared with any other service.

    Packages are capped at 10MB (enforced by src/rules/validateTgz), so
    publishing buffers the whole tarball in memory rather than juggling a
    temp-key-then-rename dance: the content-addressed key is only known once
    hashAndPipe finishes, so this collects into a buffer as the hash tee's
    sink, then does one direct put to the real key. Simpler and correct —
    no orphaned temp objects, nothing to clean up on failure.
*/

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Writable } from 'stream';

export interface UploaderConfig {
    region: string;
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucketName: string;
    // Local-dev S3 stand-ins (MinIO) need path-style addressing; R2 in prod
    // uses the default virtual-host style.
    forcePathStyle?: boolean;
}

export function createS3Client(config: UploaderConfig): S3Client {
    return new S3Client({
        region: config.region || 'auto',
        endpoint: config.endpoint,
        credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
        },
        forcePathStyle: config.forcePathStyle ?? false,
    });
}

/*
    A Writable sink for src/rules/hashAndPipe that just collects
    everything it receives — hashAndPipe's whole point is that the hash it
    returns is provably the hash of exactly what this sink got, so once it
    resolves, `getBuffer()` and the hash describe the same bytes by
    construction, not by trusting a second read.
*/
export function createBufferingSink(): { sink: Writable; getBuffer: () => Buffer } {
    const chunks: Buffer[] = [];
    const sink = new Writable({
        write(chunk, _enc, callback) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            callback();
        },
    });
    return { sink, getBuffer: () => Buffer.concat(chunks) };
}

export async function putPackageObject(s3: S3Client, bucketName: string, key: string, body: Buffer): Promise<void> {
    await s3.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: body,
        ContentType: 'application/gzip',
    }));
}
