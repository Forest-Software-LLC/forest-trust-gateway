import { createGunzip } from 'zlib';
import tar from 'tar-stream';
import { PassThrough, Readable } from 'stream';
import { pipeline } from 'stream/promises';

// Per-platform hook into the extraction pass. `inspectName` can reject an
// entry by name/type (returning an error message fails the whole archive,
// mid-extraction); `shouldCapture`/`onFile` collect selected files' text for
// a post-extraction content pass (e.g. the UEFN lexical scan). With no
// inspector supplied, behavior is byte-identical to before the hook existed.
export interface TgzEntryInspector {
    inspectName?(name: string, type: string | undefined): string | null;
    shouldCapture?(name: string): boolean;
    onFile?(name: string, content: string): void;
    // Per-file cap for captured entries. Overflow FAILS the archive rather
    // than truncating — a truncated file could hide content past the cap
    // from the post-pass scan.
    maxCaptureBytes?: number;
}

const DEFAULT_MAX_CAPTURE_BYTES = 256 * 1024;

interface TgzValidationOptions {
    maxFiles?: number;
    maxTotalSize?: number; // in bytes
    maxFileSize?: number; // in bytes
    maxPathDepth?: number;
    timeoutMs?: number;
    // When provided, the top-level LICENSE file's text is captured here during
    // the same pass (for license verification) — no second read of the archive.
    licenseCapture?: { text?: string };
    entryInspector?: TgzEntryInspector;
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
        licenseCapture,
        entryInspector
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

        if (entryInspector?.inspectName) {
            const nameError = entryInspector.inspectName(name, header.type ?? undefined);
            if (nameError) {
                return fail(nameError);
            }
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
        } else if (entryInspector?.shouldCapture?.(name)) {
            // Disjoint from the license branch: capture targets (e.g.
            // *.verse) never match LICENSE_FILE_NAMES. Total memory is
            // already bounded by maxTotalSize.
            const cap = entryInspector.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
            const chunks: Buffer[] = [];
            let captured = 0;
            stream.on('data', (chunk: Buffer) => {
                captured += chunk.length;
                if (captured > cap) {
                    return fail(`File too large to scan: ${name}`);
                }
                chunks.push(chunk);
            });
            stream.on('end', () => {
                entryInspector.onFile?.(name, Buffer.concat(chunks).toString('utf8'));
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
