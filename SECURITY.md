# Security & Verification

This repo exists so that Forest's core supply-chain claims can be **checked, not trusted**. This document lists each claim and the concrete way to verify it yourself.

## The claims, and how to check them

### 1. Packages are content-addressed, and the client verifies integrity itself

The SHA-256 of a package tarball is its storage key, its download URL, and the `integrity` value pinned in `forest-lock.json`. The CLI recomputes the hash of every tarball it downloads and refuses to install on a mismatch.

**Verify:** download any package tarball and hash it — the digest is the filename. Read the CLI's lockfile verification in [forest-cli](https://github.com/forest-software-llc/forest-cli). This property is enforced *client-side*, which means it holds **even if every server in the pipeline were compromised**: swapped bytes fail the hash check on the user's machine.

### 2. The code that validates, hashes, and authorizes uploads/downloads is this repo

Upload and download are served at `packages.forest.dev` by this codebase. File bytes go from the client to this service to storage — they never pass through the closed-source backend, which only answers narrow factual questions (documented in [src/internalApiClient.ts](src/internalApiClient.ts)) and has no custody of package contents at any point.

**Verify:** read [src/routes/publish.ts](src/routes/publish.ts) and [src/routes/access.ts](src/routes/access.ts). Every network call the service can make to the backend is in `internalApiClient.ts` — there is no other integration surface.

### 3. What's deployed is what's in this repo

Deploys happen exclusively from this repo's `main` branch via [GitHub Actions](.github/workflows/deploy.yml). The workflow builds the container image, deploys it, and attests the image digest with GitHub build provenance.

**Verify:**
- The Actions logs for every deploy are public.
- Verify the deployed image digest against the attestation:
  ```sh
  gh attestation verify oci://registry.cloudflare.com/<account>/forest-trust-gateway-gatewaycontainer@sha256:<digest> --repo forest-software-llc/forest-trust-gateway
  ```
  (The digest for each deploy is printed in that deploy's public Actions log.)
- `main` is branch-protected: no force pushes, CI must pass.

### 4. The rules are testable offline

`npm ci && npm test` runs the entire suite — archive safety, hashing, publish/access policy, URL signing — against a mocked backend. No accounts, no credentials, no network.

**Verify:** clone and run it.

## What still requires trust

Honesty about the boundary matters more than the boundary itself:

- **The hosting platform.** Cloudflare runs the attested image; we can prove *what* was deployed, not *what the platform does with it*. This is true of every hosted service.
- **Routing.** That `packages.forest.dev` routes to this Worker is account configuration, observable only indirectly (behavioral consistency with this code).
- **The facts the backend reports.** Permission facts (org membership, grants) come from the closed backend. A malicious backend could lie about *who may publish* — but not about *what bytes you receive*, because of claim 1.

The design goal is that the worst a fully compromised private backend can do is deny service or mis-authorize a publish under a scope it controls — never silently alter package contents.

## Reporting a vulnerability

Email **hi@forestpm.dev**. Please do not open public issues for exploitable vulnerabilities; we'll coordinate disclosure and credit.
