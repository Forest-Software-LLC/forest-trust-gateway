/*
    uefnRules.ts

    UEFN (Verse) package validation — the platform branch of the publish
    path's tarball rules (forest-backend docs/uefn-adapter.md §8).

    LEXICAL ONLY: no Verse compiler exists outside UEFN, so these checks are
    regex-level scans of .verse text. Accepted lenience, documented per rule:
    comments/strings are NOT stripped (a `using` inside a comment counts —
    false positives over false negatives), matching is case-insensitive where
    the compiler is case-sensitive, and bare-scope imports
    (`using { ForestPackages.X }`) evade the two-segment reference check.
    Install-time scoped markers + the consumer's own compiler are the real
    enforcement; these rules exist to fail fast with better messages.

    Dependency EXISTENCE/platform is deliberately NOT checked at publish
    (Roblox parity): resolution is platform-scoped at install time, which is
    what satisfies doc §8.7's same-platform requirement.

    Identifier rules and platform constants come from the shared contract
    (forest-shared-resources, tag-pinned git dependency) — no mirrored
    definitions here.
*/

import { mapScopeToVerseIdentifier, EPIC_PATH_ROOTS, RECEIPT_FILE_NAME } from 'forest-shared-resources/verse';
import type { TgzEntryInspector } from './validateTgz.ts';

// Re-exported so rules/index.ts keeps a single import surface.
export { mapScopeToVerseIdentifier };

const LICENSE_FILE_NAMES = new Set(['license', 'license.txt', 'license.md']);

// Filename/entry-type rules, applied per tar entry DURING extraction (via
// the TgzEntryInspector hook). v1 UEFN packages are Verse-code-only:
// .verse/.md/.json/LICENSE. Dotfiles (.gitignore etc.) are rejected by the
// allowlist — doc §8.1. Order matters: receipt/digest/binary checks precede
// the allowlist so they get their specific messages.
export function checkUefnEntryName(name: string, type: string | undefined): string | null {
    if (type === 'directory') return null;
    // A symlink named x.verse would satisfy the extension allowlist while
    // carrying no scannable content — only regular files pass.
    if (type !== undefined && type !== 'file') {
        return `Unsupported archive entry type "${type}": ${name}`;
    }
    const base = name.split('/').filter(Boolean).pop() ?? '';
    const lower = base.toLowerCase();
    if (lower === RECEIPT_FILE_NAME) {
        return `Install receipt files (${RECEIPT_FILE_NAME}) must not be published — remove it and re-pack.`;
    }
    if (lower.endsWith('.digest.verse')) {
        return `Epic-generated digest files are not allowed: ${name}`;
    }
    if (lower.endsWith('.uasset') || lower.endsWith('.umap')) {
        return `Binary UE assets are not allowed (UEFN packages are Verse-code-only): ${name}`;
    }
    if (lower.endsWith('.verse') || lower.endsWith('.md') || lower.endsWith('.json') || LICENSE_FILE_NAMES.has(lower)) {
        return null;
    }
    return `File type not allowed for UEFN packages: ${name} (allowed: .verse, .md, .json, LICENSE)`;
}

// --- Lexical content scan ----------------------------------------------------

// `using { ... }` — the interior may list several comma-separated paths and
// the character class spans newlines.
const USING_RE = /using\s*\{\s*([^}]*?)\s*\}/g;
// `(/absolute/path:)Fn` qualified access.
const ABS_QUALIFIER_RE = /\(\s*(\/[^\s):]*)\s*:/g;
// Any `ForestPackages.Scope.Name` reference — covers both the using form and
// the dotted-qualifier form in one pattern.
const FOREST_REF_RE = /\bForestPackages\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g;
const PUBLIC_RE = /<\s*public\s*>/;

// Referencing Epic's APIs is fine — shipping them is not. Exact-case prefix
// match: a wrong-cased Epic root gets rejected here, but it wouldn't have
// compiled in the author's project either. Roots come from the shared
// contract (EPIC_PATH_ROOTS).
function isAllowedAbsolute(path: string): boolean {
    return EPIC_PATH_ROOTS.some(root => path === root || path.startsWith(root + '/'));
}

export interface UefnPackageInput {
    // path -> utf8 content for every .verse file in the tarball
    files: Map<string, string>;
    ownScope: string;
    ownName: string;
    // forest.json dependency keys, "scope/name" form
    dependencyKeys: string[];
}

export interface UefnValidationResult {
    errors: string[];
    warnings: string[];
}

export function validateUefnPackage(input: UefnPackageInput): UefnValidationResult {
    const errors = new Set<string>();
    const warnings: string[] = [];

    // Declared deps + own identity in the same shape references take:
    // mapped-scope '.' name, lowercased (lenient — Verse itself is
    // case-sensitive, but a wrong-cased using fails the author's compile).
    const declared = new Set<string>();
    const declaredDisplay = new Map<string, string>(); // key -> "scope/name" for messages
    for (const key of input.dependencyKeys) {
        const [scope, name] = key.split('/');
        if (!scope || !name) continue;
        const refKey = `${mapScopeToVerseIdentifier(scope.toLowerCase())}.${name.toLowerCase()}`;
        declared.add(refKey);
        declaredDisplay.set(refKey, key);
    }
    const ownRef = `${mapScopeToVerseIdentifier(input.ownScope.toLowerCase())}.${input.ownName.toLowerCase()}`;

    let sawPublic = false;

    for (const [file, content] of input.files) {
        if (!sawPublic && PUBLIC_RE.test(content)) sawPublic = true;

        for (const match of content.matchAll(USING_RE)) {
            for (const rawSegment of match[1].split(',')) {
                const segment = rawSegment.trim();
                if (!segment) continue;
                if (segment.startsWith('/')) {
                    if (!isAllowedAbsolute(segment)) {
                        errors.add(
                            `${file}: absolute Verse path "${segment}" — absolute paths embed the author's `
                            + `project prefix and break in consumer projects. Use ForestPackages.Scope.Name references.`
                        );
                    }
                } else if (segment.split('.')[0].trim() === 'Assets') {
                    // The asset-reflection digest is regenerated per-project;
                    // packages referencing it break in every consumer (§8.6)
                    errors.add(`${file}: imports the project asset digest ("${segment}") — UEFN packages must be asset-independent.`);
                }
            }
        }

        for (const match of content.matchAll(ABS_QUALIFIER_RE)) {
            const path = match[1];
            if (!isAllowedAbsolute(path)) {
                errors.add(
                    `${file}: absolute qualified access "(${path}:)" — absolute paths embed the author's `
                    + `project prefix and break in consumer projects.`
                );
            }
        }

        for (const match of content.matchAll(FOREST_REF_RE)) {
            const refKey = `${match[1].toLowerCase()}.${match[2].toLowerCase()}`;
            if (refKey === ownRef) {
                // Works in the author's project, but couples the code to its
                // published name — breaks under scope rename/claim (§8.4b)
                errors.add(
                    `${file}: references its own published path "ForestPackages.${match[1]}.${match[2]}" — `
                    + `use location-independent module references instead.`
                );
            } else if (!declared.has(refKey)) {
                errors.add(
                    `${file}: "ForestPackages.${match[1]}.${match[2]}" is imported but no matching `
                    + `dependency is declared in forest.json.`
                );
            }
        }
    }

    if (input.files.size > 0 && !sawPublic) {
        warnings.push(
            'No <public> definition found — this package exports nothing and will be uninstallable in practice.'
        );
    }

    return { errors: [...errors], warnings };
}

// Wires the filename rules + .verse capture into validateTgz's extraction
// pass for uefn publishes.
export function makeUefnEntryInspector(verseFiles: Map<string, string>): TgzEntryInspector {
    return {
        inspectName: checkUefnEntryName,
        shouldCapture: (name) => name.toLowerCase().endsWith('.verse'),
        onFile: (name, content) => { verseFiles.set(name, content); },
        maxCaptureBytes: 256 * 1024,
    };
}
