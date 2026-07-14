import type {
    InternalApiClient,
    PublishAuthorizationFacts,
    AccessFacts,
    RecordPublishedVersionInput,
    LicenseVerdict,
} from '../src/internalApiClient.ts';

/*
    A configurable stand-in for forest-backend's internal API — this is what
    lets the gateway be built and tested with no live backend, no Mongo, no
    Cloudflare Service Binding at all. Each test wires in exactly the facts
    (and, for publish, the license verdict) it wants to assert against.
*/
export class MockInternalApiClient implements InternalApiClient {
    public recordedCalls: RecordPublishedVersionInput[] = [];
    public recordedAuthHeaders: (string | undefined)[] = [];
    public verifyLicenseCalls: { scope: string; name: string; declaredLicense: string; licenseText: string | undefined; isPublic: boolean }[] = [];
    private publishFacts: PublishAuthorizationFacts;
    private accessFacts: AccessFacts;
    private licenseVerdict: LicenseVerdict;

    constructor(publishFacts: PublishAuthorizationFacts, accessFacts: AccessFacts, licenseVerdict: LicenseVerdict = allowedLicenseVerdict) {
        this.publishFacts = publishFacts;
        this.accessFacts = accessFacts;
        this.licenseVerdict = licenseVerdict;
    }

    public publishAuthorizationCalls: { authorizationHeader?: string; scope: string; name: string; platform: string; isPublic: boolean }[] = [];

    async getPublishAuthorization(params: { authorizationHeader?: string; scope: string; name: string; platform: string; isPublic: boolean }): Promise<PublishAuthorizationFacts> {
        this.publishAuthorizationCalls.push(params);
        return this.publishFacts;
    }

    async verifyLicense(params: { scope: string; name: string; declaredLicense: string; licenseText: string | undefined; isPublic: boolean }): Promise<LicenseVerdict> {
        this.verifyLicenseCalls.push(params);
        return this.licenseVerdict;
    }

    async recordPublishedVersion(input: RecordPublishedVersionInput, authorizationHeader?: string): Promise<void> {
        this.recordedCalls.push(input);
        this.recordedAuthHeaders.push(authorizationHeader);
    }

    async getAccessFacts(): Promise<AccessFacts> {
        return this.accessFacts;
    }
}

export const allowedLicenseVerdict: LicenseVerdict = {
    ok: true,
    rating: 'safe',
    caveats: [],
    verified: true,
    needsAiScan: false,
};

export const rejectedLicenseVerdict: LicenseVerdict = {
    ok: false,
    reason: 'License mismatch: forest.json declares MIT, but the packaged LICENSE file appears to be GPL-3.0.',
};

export const deniedPublishFacts: PublishAuthorizationFacts = {
    authenticated: true,
    membershipLevel: 0,
    packageAlreadyExists: false,
    hasWriteGrant: false,
};

export const allowedPublishFacts: PublishAuthorizationFacts = {
    authenticated: true,
    membershipLevel: 2,
    packageAlreadyExists: false,
    hasWriteGrant: false,
};

export const deniedAccessFacts: AccessFacts = {
    isPublic: false,
    isOwnerMatch: false,
    isOrganizationOwned: false,
    membershipRank: null,
    hasPackageAccessGrant: false,
    hash: null,
    storagePath: null,
    resolvedVersion: null,
    description: null,
    dependencies: null,
    license: null,
    licenseRating: null,
    licenseCaveats: null,
    licenseVerified: null,
    archiveRoot: null,
    ownerType: null,
};

export const publicAccessFacts: AccessFacts = {
    isPublic: true,
    isOwnerMatch: false,
    isOrganizationOwned: false,
    membershipRank: null,
    hasPackageAccessGrant: false,
    hash: 'abc123',
    storagePath: 'public/abc123.tgz',
    resolvedVersion: '1.2.0',
    description: 'A test package',
    dependencies: { 'some-dep': { version: '^1.0.0', alias: 'some-dep' } },
    license: 'MIT',
    licenseRating: 'safe',
    licenseCaveats: [],
    licenseVerified: true,
    archiveRoot: 'src/init.luau',
    ownerType: 'user',
};
