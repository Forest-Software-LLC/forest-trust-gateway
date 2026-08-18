/*
    robloxRules.ts

    Roblox-platform filename rules for the publish path — the roblox branch
    of validateTgz's entry-inspector hook (uefn has its own in uefnRules.ts).

    The one rule: no runtime scripts. Under the Rojo naming convention a
    file called `x.server.lua(u)` syncs into Studio as a Script and
    `x.client.lua(u)` as a LocalScript — both EXECUTE as soon as the place
    runs, without the package ever being require()d. That makes them a
    drive-by code-execution vector inside an installed dependency, so
    package code must be ModuleScripts (plain .lua/.luau) only.

    This gate applies to native forest publishes only. The wally mirror
    ingests through PUT /internal/mirror-tarball, which never runs
    validateTgz — mirrored packages are deliberately exempt.
*/

import type { TgzEntryInspector } from './validateTgz.ts';

// Matching is case-insensitive (see the lowercase below) where Rojo's own
// suffix match is case-sensitive — false positives over false negatives.
// A bare `server.lua`/`client.lua` does NOT match: without the leading dot
// separator it's an ordinary ModuleScript name.
const RUNTIME_SCRIPT_SUFFIX_RE = /\.(server|client)\.luau?$/;

export function checkRobloxEntryName(name: string, type: string | undefined): string | null {
    if (type === 'directory') return null;
    const base = name.split('/').filter(Boolean).pop() ?? '';
    if (RUNTIME_SCRIPT_SUFFIX_RE.test(base.toLowerCase())) {
        return `Runtime script not allowed: ${name} - Package code must be ModuleScripts (plain .lua/.luau).`;
    }
    return null;
}

export function makeRobloxEntryInspector(): TgzEntryInspector {
    return { inspectName: checkRobloxEntryName };
}
