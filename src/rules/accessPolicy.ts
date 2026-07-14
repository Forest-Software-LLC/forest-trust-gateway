/*
    accessPolicy.ts

    The rule that decides who can access a private package. This is a pure
    decision over already-known facts — it does not query anything. The
    backend is responsible for gathering these facts and calling this
    function with the result; none of those lookups belong here, since they
    require live database access this service deliberately has none of.

    Precondition: when there is no authenticated user, the caller must pass
    isOwnerMatch: false, membershipRank: null, hasPackageAccessGrant: false —
    i.e. every fact defaults to "no", since an absent user can never satisfy
    any ownership/membership/grant check.
*/

export type OrgMembershipRank = 'owner' | 'admin' | 'member' | null;

export interface PackageAccessFacts {
    isPublic: boolean;
    isOwnerMatch: boolean;
    isOrganizationOwned: boolean;
    membershipRank: OrgMembershipRank;
    hasPackageAccessGrant: boolean;
}

export function decidePackageAccess(facts: PackageAccessFacts): boolean {
    if (facts.isPublic) return true;

    if (facts.isOwnerMatch) return true;

    if (facts.isOrganizationOwned) {
        if (facts.membershipRank === 'owner' || facts.membershipRank === 'admin') {
            return true;
        }
        if (facts.hasPackageAccessGrant) {
            return true;
        }
    }

    return false;
}
