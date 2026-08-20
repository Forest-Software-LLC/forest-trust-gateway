/*
    robloxRules.ts

    Roblox package validation, the platform branch of the publish path's
    tarball rules.

    1. Model files (.rbxm) must be code-free instance trees. The binary
       scanner lives in forest-shared-resources/rbxm; this module wires it
       into the extraction pass and turns scan results into publish errors.
       .rbxmx not supported.

    2. Code-first floor: a package shipping models must also ship
       non-trivial Luau source.
*/

import {
    scanRbxm,
    checkRbxmPolicy,
    RbxmParseError,
    MODEL_FILE_EXTENSIONS,
    REJECTED_MODEL_EXTENSIONS,
    MIN_LUAU_SOURCE_BYTES_WITH_MODELS,
} from 'forest-shared-resources/rbxm';
import type { TgzEntryInspector } from './validateTgz.ts';

export interface RobloxScanState {
    // path -> raw bytes for every .rbxm in the tarball
    rbxmFiles: Map<string, Buffer>;
    luauSourceBytes: number;
}

export function makeRobloxScanState(): RobloxScanState {
    return { rbxmFiles: new Map(), luauSourceBytes: 0 };
}

function extensionOf(name: string): string {
    const base = name.split('/').filter(Boolean).pop() ?? '';
    const dot = base.lastIndexOf('.');
    return dot === -1 ? '' : base.slice(dot).toLowerCase();
}

export function makeRobloxEntryInspector(state: RobloxScanState): TgzEntryInspector {
    return {
        inspectName: (name, type) => {
            if (type === 'directory') return null;
            if (REJECTED_MODEL_EXTENSIONS.includes(extensionOf(name))) {
                return `XML model files are not supported: ${name} (re-save as binary .rbxm)`;
            }
            // Regular files only; a symlink named x.rbxm has no scannable content
            if (MODEL_FILE_EXTENSIONS.includes(extensionOf(name)) && type !== undefined && type !== 'file') {
                return `Unsupported archive entry type "${type}": ${name}`;
            }
            return null;
        },
        onEntry: (name, size, type) => {
            if (type !== undefined && type !== 'file') return;
            const ext = extensionOf(name);
            if (ext === '.lua' || ext === '.luau') {
                state.luauSourceBytes += size;
            }
        },
        shouldCaptureBinary: (name) => MODEL_FILE_EXTENSIONS.includes(extensionOf(name)),
        onBinaryFile: (name, content) => {
            state.rbxmFiles.set(name, content);
        },
        // Real bound is validateTgz maxTotalSize; must not truncate below it
        maxBinaryCaptureBytes: 10 * 1024 * 1024,
    };
}

// Post-extraction pass over captured model files. Author-facing error
// messages; empty means pass.
export function validateRobloxPackage(state: RobloxScanState): string[] {
    const errors: string[] = [];

    for (const [name, bytes] of state.rbxmFiles) {
        let scan;
        try {
            scan = scanRbxm(bytes);
        } catch (err) {
            if (err instanceof RbxmParseError) {
                errors.push(`${name}: not a valid Roblox binary model file (${err.message}).`);
                continue;
            }
            throw err;
        }
        errors.push(...checkRbxmPolicy(scan, name));
    }

    if (state.rbxmFiles.size > 0 && state.luauSourceBytes < MIN_LUAU_SOURCE_BYTES_WITH_MODELS) {
        errors.push(
            'Packages that ship model files must be code-first: include meaningful Luau source, '
            + 'not just models. forest is a package manager, not an asset store.'
        );
    }

    return errors;
}
