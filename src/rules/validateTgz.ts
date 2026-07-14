import { createGunzip } from 'zlib';
import tar from 'tar-stream';
import { PassThrough, Readable } from 'stream';
import { pipeline } from 'stream/promises';

interface TgzValidationOptions {
    maxFiles?: number;
    maxTotalSize?: number; // in bytes
    maxFileSize?: number; // in bytes
    maxPathDepth?: number;
    timeoutMs?: number;
    // When provided, the top-level LICENSE file's text is captured here during
    // the same pass (for license verification) — no second read of the archive.
    licenseCapture?: { text?: string };
}

const LICENSE_FILE_NAMES = new Set(['license', 'license.txt', 'license.md']);
const MAX_CAPTURED_LICENSE_BYTES = 64 * 1024;

export async function validateTgz(
    validatePass: PassThrough,
    {
        maxFiles = 1000,
        maxTotalSize = 10 * 1024 * 1024, // 10 MB
        maxFileSize = 10 * 1024 * 1024,  // 10 MB
        maxPathDepth = 16,
        timeoutMs = 5000,
        licenseCapture
    }: TgzValidationOptions = {}
) {
    const extract = tar.extract();
    let fileCount = 0;
    let totalSize = 0;

    let timeout : NodeJS.Timeout | null = null;

    extract.on('entry', (header, stream, next) => {
        // Destroying extract also destroys the in-flight entry stream with the
        // same error — unhandled there, it would crash the process
        stream.on('error', () => {});

        if (!timeout) {
            timeout = setTimeout(() => {
                extract.destroy(new Error('Validation timed out'));
            }, timeoutMs);
        }

        // Throwing inside an event handler doesn't reject the pipeline — it
        // escapes as an uncaught exception. Destroying the extract stream
        // routes the failure through the 'error' handler below instead.
        const fail = (message: string) => extract.destroy(new Error(message));

        fileCount++;
        if (fileCount > maxFiles) {
            return fail('Too many files in archive');
        }

        const { name, size } = header;

        // Reject paths with traversal or absolute paths
        if (name.includes('..') || name.startsWith('/')) {
            return fail(`Path traversal or unsafe path: ${name}`);
        }

        // Check depth (e.g., nested/a/b/c/file.txt -> depth 4)
        const depth = name.split('/').filter(Boolean).length;
        if (depth > maxPathDepth) {
            return fail(`File path too deep: ${name}`);
        }

        // Check size
        if (typeof size == 'number' && size > maxFileSize) {
           return fail(`File too large: ${name}`);
        }

        totalSize += size || 0;
        if (totalSize > maxTotalSize) {
            return fail('Total archive size exceeds limit');
        }

        const pathSegments = name.split('/').filter(Boolean);
        const isTopLevelLicense = pathSegments.length === 1
            && LICENSE_FILE_NAMES.has(pathSegments[0].toLowerCase());

        if (licenseCapture && isTopLevelLicense && licenseCapture.text === undefined) {
            const chunks: Buffer[] = [];
            let captured = 0;
            stream.on('data', (chunk: Buffer) => {
                captured += chunk.length;
                if (captured <= MAX_CAPTURED_LICENSE_BYTES) {
                    chunks.push(chunk);
                }
            });
            stream.on('end', () => {
                licenseCapture.text = Buffer.concat(chunks).toString('utf8');
                next();
            });
        } else {
            stream.on('end', next);
            stream.resume(); // Don't buffer into memory
        }
    });

    extract.on('finish', () => {
        if (timeout) {
            clearTimeout(timeout);
            timeout = null;
        }
        validatePass.end(); // Signal that validation is complete
    });

    extract.on('error', (err) => {
        if (timeout) {
            clearTimeout(timeout);
            timeout = null;
        }
        // The pipeline promise already rejects with err; destroying with the
        // error re-emits it on validatePass, where an unhandled 'error' would
        // crash the process. Swallow that duplicate emission.
        validatePass.on('error', () => {});
        validatePass.destroy(err);
    });

    return pipeline(
        validatePass,
        createGunzip(),
        extract
    )
}
