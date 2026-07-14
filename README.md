# forest-trust-gateway

The public, independently buildable service that handles [Forest](https://forest.dev) package publish and download. The code that validates, hashes, and authorizes those two operations lives here, where it can be read, built, and tested by anyone.

## Design

- **Packages are content-addressed.** The SHA-256 of the uploaded tarball is the storage key and the integrity value the CLI verifies on install. The hash is computed here, by public code, from the exact bytes received.
- **File bytes go directly from the client to this service to storage.** The private backend never has custody of package contents.
- **Authorization rules run here.** The private backend answers narrow factual questions (membership level, existing grants, package visibility) over an internal API; this service applies the actual publish/access rules (`src/rules/publishPolicy.ts`, `src/rules/accessPolicy.ts`) against those facts.
- **License rating is not done here.** This service captures the packaged LICENSE file's text during archive validation and forwards it; the backend's verdict is enforced before anything is written to storage.

This service holds credentials for exactly one thing: writing package tarballs to storage. It has no database and no access to account, billing, or any other user data beyond the facts listed above.

## Routes

Served at **packages.forest.dev**:

- `POST /v1/package/upload`
- `GET /v1/package/:scope/:platform/:name/:version`

CI deploys this repo to that hostname, so the code answering those routes is verifiable against this repo's history.

## Structure

- `src/rules/` — pure decision logic and file-safety checks: `validateTgz` (archive safety + LICENSE text capture), `contentAddress`, `accessPolicy`, `publishPolicy`, `signedUrl`, `hashAndPipe`. Each has its own tests in `tests/rules/`.
- `src/routes/` — the two Fastify routes, thin orchestration over `src/rules/` and `internalApiClient.ts`.
- `src/internalApiClient.ts` — the full surface of what this service asks the backend: `getPublishAuthorization`, `verifyLicense`, `recordPublishedVersion`, `getAccessFacts`.

## Local development

```sh
npm install
npm test     # runs entirely against a mocked internal API — no external services needed
npm run dev  # requires a backend instance (BACKEND_INTERNAL_BASE_URL) plus storage credentials
```

## Environment

| Variable | Purpose |
|---|---|
| `R2_ENDPOINT`, `R2_ACCESS_KEY`, `R2_SECRET`, `R2_BUCKET_NAME`, `R2_REGION` | Storage credentials for writing package tarballs |
| `WORKER_SIG_KEY` | Signs private-package download URLs |
| `BACKEND_INTERNAL_BASE_URL` | Where the backend's internal API is reached |
| `INTERNAL_API_SECRET` | Shared secret sent with internal API calls |
| `CDN_BASE_URL` | Base URL for content-addressed download links, e.g. `https://registry.forest.dev` |

## License

MIT.
