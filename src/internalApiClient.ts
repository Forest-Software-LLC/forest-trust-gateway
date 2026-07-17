/*
    internalApiClient.ts

    The gateway's only relationship with the backend: four narrow calls
    for FACTS, never a database connection of its own. In production these
    requests travel over a Cloudflare Service Binding (env.FOREST_API);
    the backend separately restricts who can reach its /internal/* routes,
    and the shared secret is defense in depth on top of that. Locally, it's
    just an HTTP call to wherever the backend is running (or, in tests, a
    mock that never calls anything).

    getPublishAuthorization/getAccessFacts return RAW FACTS, never a final
    allow/deny — the actual rule application happens in this service using
    src/rules' decidePublishPermission/decidePackageAccess. That split is
    the point: the rule is public and testable, the facts are whatever the
    backend reports.

    verifyLicense is different in kind: rating what a license means is a
    disclaimed legal judgment made by the backend — this service just
    forwards the captured LICENSE text and relays the verdict, called after
    hashing but before anything is written to R2 so a detected mismatch
    blocks persistence.
*/

export interface PublishAuthorizationFacts {
    authenticated: boolean;
    userId?: string;
    membershipLevel: number;
    packageAlreadyExists: boolean;
    hasWriteGrant: boolean;
    // A business-rule block (free-tier member limits, publish cooldowns) —
    // deliberately not modeled as part of decidePublishPermission's facts,
    // since it's a monetization concern, not a safety/authorization one. If
    // present, the gateway relays it as-is rather than interpreting it.
    blockedReason?: string;
    retryAfterSeconds?: number;
}

export interface AccessFacts {
    isPublic: boolean;
    isOwnerMatch: boolean;
    isOrganizationOwned: boolean;
    membershipRank: 'owner' | 'admin' | 'member' | null;
    hasPackageAccessGrant: boolean;
    hash: string | null;
    storagePath: string | null;
    // The concrete version a requested range/tag/omitted version resolved
    // to — the backend does the semver resolution, since it's the one with
    // the actual version list.
    resolvedVersion: string | null;
    // Everything below is metadata the CLI needs to actually install the
    // package — not part of the access decision itself, just carried
    // through once access is granted.
    description: string | null;
    dependencies: Record<string, DependencySpec> | null;
    license: string | null;
    licenseRating: string | null;
    licenseCaveats: string[] | null;
    licenseVerified: boolean | null;
    archiveRoot: string | null;
    ownerType: string | null;
    // Canonical identity
    name?: string | null;
    scope?: string | null;
}

export interface DependencySpec {
    version: string;
    alias?: string;
}

export interface RecordPublishedVersionInput {
    scope: string;
    name: string;
    platform: string;
    version: string;
    hash: string;
    archiveRoot: string;
    readme?: string;
    description?: string;
    declaredLicense: string;
    licenseRating: string;
    licenseCaveats: string[];
    licenseVerified: boolean;
    needsAiScan: boolean;
    licenseText?: string;
    isPublic: boolean;
    dependencies: Record<string, DependencySpec>;
}

export type LicenseVerdict =
    | { ok: true; rating: string; caveats: string[]; verified: boolean; needsAiScan: boolean }
    | { ok: false; reason: string };

export interface InternalApiClient {
    getPublishAuthorization(params: {
        authorizationHeader?: string;
        scope: string;
        name: string;
        platform: string;
        // The requested visibility — the backend gates private publishes
        // behind a Pro subscription (surfaced via blockedReason).
        isPublic: boolean;
    }): Promise<PublishAuthorizationFacts>;

    verifyLicense(params: {
        scope: string;
        name: string;
        declaredLicense: string;
        licenseText: string | undefined;
        isPublic: boolean;
    }): Promise<LicenseVerdict>;

    // The backend resolves the publishing author from the caller's identity,
    // so the Authorization header must be forwarded here too.
    recordPublishedVersion(input: RecordPublishedVersionInput, authorizationHeader?: string): Promise<void>;

    getAccessFacts(params: {
        authorizationHeader?: string;
        scope: string;
        name: string;
        platform: string;
        version?: string;
    }): Promise<AccessFacts>;
}

/*
    Real implementation. `fetchImpl` is injected so the same code works
    whether it's called via a Cloudflare Service Binding's fetch (production)
    or plain global fetch against a local forest-backend (dev). Neither this
    class nor its caller ever sees a Mongo connection string, a Redis URL, or
    any business-logic secret — only these three JSON responses.
*/
export class InternalApiError extends Error {
    readonly status: number;
    readonly apiError: string;

    constructor(status: number, apiError: string, path: string) {
        super(`Internal API call to ${path} failed: HTTP ${status} — ${apiError}`);
        this.status = status;
        this.apiError = apiError;
    }
}

export class BackendInternalApiClient implements InternalApiClient {
    private readonly baseUrl: string;
    private readonly internalSecret: string;
    private readonly fetchImpl: typeof fetch;

    constructor(baseUrl: string, internalSecret: string, fetchImpl: typeof fetch = fetch) {
        this.baseUrl = baseUrl;
        this.internalSecret = internalSecret;
        this.fetchImpl = fetchImpl;
    }

    private async postOrGet(method: 'GET' | 'POST', path: string, body?: unknown, authorizationHeader?: string) {
        const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'X-Internal-Secret': this.internalSecret,
                ...(authorizationHeader ? { Authorization: authorizationHeader } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        if (!res.ok) {
            if (res.status < 500) {
                const body = await res.json().catch(() => null) as { error?: string } | null;
                if (body?.error) {
                    throw new InternalApiError(res.status, body.error, path);
                }
            }
            throw new Error(`Internal API call to ${path} failed: HTTP ${res.status}`);
        }
        return res.json();
    }

    async getPublishAuthorization(params: { authorizationHeader?: string; scope: string; name: string; platform: string; isPublic: boolean }) {
        return this.postOrGet('POST', '/internal/publish-authorization', {
            scope: params.scope,
            name: params.name,
            platform: params.platform,
            isPublic: params.isPublic,
        }, params.authorizationHeader) as Promise<PublishAuthorizationFacts>;
    }

    async verifyLicense(params: { scope: string; name: string; declaredLicense: string; licenseText: string | undefined; isPublic: boolean }) {
        return this.postOrGet('POST', '/internal/verify-license', {
            scope: params.scope,
            name: params.name,
            declaredLicense: params.declaredLicense,
            licenseText: params.licenseText,
            isPublic: params.isPublic,
        }) as Promise<LicenseVerdict>;
    }

    async recordPublishedVersion(input: RecordPublishedVersionInput, authorizationHeader?: string) {
        await this.postOrGet('POST', '/internal/record-published-version', input, authorizationHeader);
    }

    async getAccessFacts(params: { authorizationHeader?: string; scope: string; name: string; platform: string; version?: string }) {
        const query = new URLSearchParams({
            scope: params.scope,
            name: params.name,
            platform: params.platform,
            ...(params.version ? { version: params.version } : {}),
        });
        return this.postOrGet('GET', `/internal/access-facts?${query}`, undefined, params.authorizationHeader) as Promise<AccessFacts>;
    }
}
