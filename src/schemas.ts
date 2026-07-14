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

export const PackageMetadataSchema = z.object({
    public: z.boolean().optional(),
    readme: z.string().optional(),
});

const LicenseSchema = z.string().trim().min(1).max(120);

export const ForestJsonSchema = z.object({
    name: z.string().min(1),
    author: z.string(),
    root: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+(-[\w.-]+)?(\+[\w.-]+)?$/, {
        message: 'Version must be in format x.x.x'
    }).default('0.1.0'),
    dependencies: z.record(z.string().or(z.object({ alias: z.string(), version: z.string() }))).default({}),
    description: z.string().optional(),
    platform: z.string().min(1).optional(),
    license: LicenseSchema,
});

export type PackageMetadata = z.infer<typeof PackageMetadataSchema>;
export type ForestJson = z.infer<typeof ForestJsonSchema>;
