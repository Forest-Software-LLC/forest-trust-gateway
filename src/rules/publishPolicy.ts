/*
    publishPolicy.ts

    The rule that decides whether a user may publish a package version under
    an organization ("Studio"). Pure decision over already-known facts — the
    backend runs the actual membership/package/grant lookups and free-tier
    limit checks; only the permission tiers themselves live here.

    Tiers:
      - membershipLevel 0: not an active member — always denied.
      - membershipLevel 1 (member): may publish a new version of an EXISTING
        package only if they hold an explicit write/admin grant on it.
        Creating a brand-new package always requires admin/owner.
      - membershipLevel 2+ (admin/owner): always allowed.
*/

export interface PublishPermissionFacts {
    membershipLevel: number;
    packageAlreadyExists: boolean;
    hasWriteGrant: boolean;
}

export type PublishPermissionResult =
    | { allowed: true }
    | { allowed: false, reason: string };

export function decidePublishPermission(facts: PublishPermissionFacts): PublishPermissionResult {
    if (facts.membershipLevel < 1) {
        return { allowed: false, reason: 'Insufficient permissions to publish under this organization' };
    }

    if (facts.membershipLevel < 2) {
        if (!facts.packageAlreadyExists) {
            return { allowed: false, reason: 'Creating a new package under this Studio requires the admin or owner rank' };
        }
        if (!facts.hasWriteGrant) {
            return { allowed: false, reason: 'Publishing this package requires a write grant or the admin rank in this Studio' };
        }
    }

    return { allowed: true };
}
