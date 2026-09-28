/*
    publishVisibility.ts

    The rule deciding which visibility a publish is stored and recorded
    under. Pure decision over the request's flag and the backend's facts.

    A publish never changes visibility, so an EXISTING package always gets
    its stored visibility. Downloads build the storage path from it, which
    makes anything else undownloadable. The request's `public` flag only
    picks a NEW package's visibility (omitted means private).

    A flag that contradicts the stored visibility is refused rather than
    corrected: the publisher thinks they are changing something they are not.
*/

export interface PublishVisibilityFacts {
    // metadata.public as sent
    requestedPublic: boolean | undefined;
    packageAlreadyExists: boolean;
    // Absent for a new package, or from an older backend; the request's flag
    // then decides.
    storedPublic: boolean | undefined;
}

export type PublishVisibilityResult =
    | { allowed: true, isPublic: boolean }
    | { allowed: false, reason: string };

export function decidePublishVisibility(facts: PublishVisibilityFacts): PublishVisibilityResult {
    if (facts.packageAlreadyExists && facts.storedPublic !== undefined) {
        if (facts.requestedPublic !== undefined && facts.requestedPublic !== facts.storedPublic) {
            const stored = facts.storedPublic ? 'public' : 'private';
            return {
                allowed: false,
                reason: `This package is ${stored}, and a publish never changes visibility. Publish it as ${stored}, or leave visibility unset.`,
            };
        }
        return { allowed: true, isPublic: facts.storedPublic };
    }
    return { allowed: true, isPublic: facts.requestedPublic === true };
}
