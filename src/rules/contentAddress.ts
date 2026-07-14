/*
    contentAddress.ts

    The entire content-addressing guarantee, made explicit and testable: a
    package version's storage location IS its hash, not something assigned
    separately. This is deliberately a one-line function rather than an
    inline expression — the point isn't complexity, it's that the rule
    deciding where a package's bytes live is a named, public, tested thing
    rather than an implicit fact buried in a larger handler.
*/

export function hashToFilename(sha256Hex: string): string {
    return `${sha256Hex}.tgz`;
}

// A version can only be published once per package — this is the rule that
// enforces it, given whatever versions are already on record.
export function isDuplicateVersion(existingVersions: string[], version: string): boolean {
    return existingVersions.includes(version);
}
