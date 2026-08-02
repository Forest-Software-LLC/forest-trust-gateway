/*
    dependencyVisibility.ts

    The rule deciding whether a package's declared dependencies are
    installable by everyone who can install the package itself. Pure
    decision over facts the backend resolved (which dependencies are
    private, and which belong to the publishing scope).

    Two rules, never publish something only its
    author can install:

      - A PUBLIC package may not depend on a private package at all, not
        even one of its own scope's. Public means anyone can install it, and
        nobody outside the owning scope can fetch a private tarball.

      - A PRIVATE package may only depend on private packages owned by its
        own scope. Its readers are granted access to this scope's packages,
        not to some other scope's, so a cross-scope private dependency
        installs only for whoever happens to hold both grants.

    Public dependencies are always fine, in either direction.

    Dependencies that did not resolve to a package are ignored here. A
    nonexistent dependency already fails at install time, publish has never
    checked existence, and inventing that failure now would reject manifests
    that publish fine today.

    Note this only inspects DIRECT dependencies, which is sufficient: every
    version was itself published through this same rule, so a private
    dependency owned by this scope cannot itself carry a foreign private
    dependency. The invariant holds transitively by induction.
*/

export interface DependencyVisibilityFact {
    key: string;
    resolved: boolean;
    isPublic: boolean;
    ownedByAuthor: boolean;
}

export interface DependencyVisibilityFacts {
    isPublic: boolean;
    dependencies: DependencyVisibilityFact[];
}

export type DependencyVisibilityResult =
    | { allowed: true }
    | { allowed: false, reason: string };

export function decideDependencyVisibility(facts: DependencyVisibilityFacts): DependencyVisibilityResult {
    const privateDeps = facts.dependencies.filter(dep => dep.resolved && !dep.isPublic);

    if (privateDeps.length === 0) {
        return { allowed: true };
    }

    if (facts.isPublic) {
        return {
            allowed: false,
            reason: `A public package cannot depend on private packages, because anyone installing it must be able to install its dependencies too. Private dependencies declared: ${formatKeys(privateDeps)}.`,
        };
    }

    const foreignDeps = privateDeps.filter(dep => !dep.ownedByAuthor);
    if (foreignDeps.length > 0) {
        return {
            allowed: false,
            reason: `A private package can only depend on private packages owned by the same scope. These private dependencies belong to another scope: ${formatKeys(foreignDeps)}.`,
        };
    }

    return { allowed: true };
}

function formatKeys(deps: DependencyVisibilityFact[]): string {
    return deps.map(dep => dep.key).sort().join(', ');
}
