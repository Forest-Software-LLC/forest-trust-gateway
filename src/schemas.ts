/*
    schemas.ts

    The forest.json / package metadata contract the CLI publishes against.
    Field-for-field compatible with what the backend accepts; kept in sync
    manually (accepted, low-churn duplication).

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

export const ForestJsonSchema = z.object({
    name: z.string().min(1),
    author: z.string(),
    // Optional at the field level so uefn manifests may omit it (a uefn
    // package has no entry-point file — the folder IS the package); the
    // superRefine below keeps it required for every other platform.
    root: z.string().min(1).optional(),
    version: z.string().regex(/^\d+\.\d+\.\d+(-[\w.-]+)?(\+[\w.-]+)?$/, {
        message: 'Version must be in format x.x.x'
    }).default('0.1.0'),
    dependencies: z.record(z.string().or(z.object({ alias: z.string().optional(), version: z.string() }))).default({}),
    description: z.string().optional(),
    // Presence is still enforced by the publish route's explicit check (so
    // its error message stays stable); this only constrains the VALUE.
    platform: PlatformSchema.optional(),
    license: LicenseSchema,
}).superRefine((val, ctx) => {
    if (val.platform !== 'uefn' && !val.root) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['root'], message: 'root is required' });
    }
});

export type PackageMetadata = z.infer<typeof PackageMetadataSchema>;
export type ForestJson = z.infer<typeof ForestJsonSchema>;
