/*
    schemas.ts

    The forest.json / package metadata contract the CLI publishes against.
    Field-for-field compatible with what the backend accepts; kept in sync
    manually (accepted, low-churn duplication). `packagesDir` duplicates the
    backend's validatePackagesDir rule verbatim (anchored regex, 64-char cap,
    Windows reserved device names) — change them together.

    The `license` field is deliberately just a shape check (a non-empty
    string), not an SPDX validator — what the value actually means is a
    rating question, answered by the backend's verify-license call; this
    schema only guards against an empty/malformed field.
*/

import { z } from 'zod';

// Platforms this registry serves. Constraining here (vs. the old free-form
// string) means an unknown platform fails the schema parse with a 400 instead
// of leaking to the backend and dying on its Mongoose enum — an intentional
// improvement; roblox payloads are unchanged.
export const SUPPORTED_PLATFORMS = ['roblox', 'uefn'] as const;
export const PlatformSchema = z.enum(SUPPORTED_PLATFORMS);

export const PackageMetadataSchema = z.object({
    public: z.boolean().optional(),
    readme: z.string().optional(),
    // uefn only: the UEFN compatibilityVersion the package was authored
    // against, detected by the CLI from the project's .uefnproject at publish
    // time (publish-environment info, not manifest-authored). Passed through
    // to the backend for display/warn only.
    compatVersion: z.string().max(40).optional(),
});

const LicenseSchema = z.string().trim().min(1).max(120);

// Windows reserved device names (CON, PRN, AUX, NUL, COM1-COM9, LPT1-LPT9)
// can never exist as folders on a Windows consumer's disk, so a package
// published with one would be uninstallable there. Matched case-insensitively.
const WINDOWS_RESERVED_DIR_NAMES = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

// Descriptions render in web search results and embeds:
// force single-line plain text (newlines/tabs collapse to spaces, other
// control chars (including ANSI escapes) are dropped before the length
// check so a description that only overflows via control chars still passes.
const sanitizeDescription = (value: string) =>
    value.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim();

export const ForestJsonSchema = z.object({
    name: z.string().min(1),
    author: z.string(),
    // Optional at the field level so uefn manifests may omit it (a uefn
    // package has no entry-point file — the folder IS the package); the
    // superRefine below keeps it required for every other platform.
    // Backslashes are normalized to forward slashes: Windows publishers
    // write OS-style paths, but this value becomes the stored archiveRoot
    // that every installer matches against tar entry paths (always
    // forward-slashed) — a raw backslash breaks extraction on mac/linux.
    root: z.string().min(1).transform((s) => s.replace(/\\/g, '/')).optional(),
    version: z.string().regex(/^\d+\.\d+\.\d+(-[\w.-]+)?(\+[\w.-]+)?$/, {
        message: 'Version must be in format x.x.x or x.x.x-<prerelease>+<build>'
    }).default('0.1.0'),
    dependencies: z.record(z.string().or(z.object({ alias: z.string().optional(), version: z.string() }))).default({}),
    description: z.string()
        .transform(sanitizeDescription)
        .pipe(z.string().max(200, 'description must be 200 characters or fewer'))
        .optional(),
    // Presence is still enforced by the publish route's explicit check (so
    // its error message stays stable); this only constrains the VALUE.
    platform: PlatformSchema.optional(),
    license: LicenseSchema,
    // roblox only: the folder name this package's own dependencies install
    // into (absent = the default `Packages`) the superRefine below rejects it on uefn, where the
    // shared ForestPackages mount name is the platform contract.
    packagesDir: z.string()
        .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, {
            message: 'packagesDir must start with a letter and contain only letters, digits, hyphens, and underscores',
        })
        .max(64, 'packagesDir must be 64 characters or fewer')
        .refine((s) => !WINDOWS_RESERVED_DIR_NAMES.test(s), {
            message: 'packagesDir must not be a Windows reserved device name',
        })
        .optional(),
}).superRefine((val, ctx) => {
    if (val.platform !== 'uefn' && !val.root) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['root'], message: 'root is required' });
    }
    if (val.platform === 'uefn' && val.packagesDir !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['packagesDir'], message: 'packagesDir is not supported on uefn: the shared ForestPackages mount name is part of the platform contract' });
    }
});

export type PackageMetadata = z.infer<typeof PackageMetadataSchema>;
export type ForestJson = z.infer<typeof ForestJsonSchema>;
