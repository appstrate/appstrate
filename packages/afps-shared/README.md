# `@appstrate/afps-shared`

Zero-internal-dependency leaf package holding the primitives that both
[`@appstrate/core`](https://www.npmjs.com/package/@appstrate/core) (platform side)
and the AFPS runtime (in-sandbox side) need to agree on byte-for-byte.

It exists so those two layers cannot drift: an integrity hash, an SSRF verdict or
a capability-token signature computed on one side must validate on the other.
If you are building on Appstrate, you almost certainly want `@appstrate/core`
instead — this package is its foundation, published separately because the
runtime cannot depend on the platform.

```sh
npm install @appstrate/afps-shared
```

**Requires Bun ≥ 1.3.9.** The package ships raw TypeScript sources rather than a
compiled bundle, so Node cannot import it directly. There is no barrel export —
import each module by subpath.

## Exports

| Subpath                              | What it does                                                                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./guarded-fetch`                    | The single outbound-request primitive for any URL whose host comes from a less-trusted input (manifest URLs, OAuth endpoints). Wraps the SSRF checks below. |
| `./ssrf` · `./ssrf-dns`              | SSRF host/address validation, including DNS resolution so a hostname cannot rebind to a private range between check and connect.                            |
| `./signed-token`                     | Keyring-HMAC capability tokens — the one codec behind every short-lived, URL-carried capability (upload URLs, document previews, hosted connect sessions).  |
| `./unzip-bounded`                    | Memory-bounded ZIP decompression for untrusted archives (AFPS bundles, package ZIPs, integration bundles).                                                  |
| `./integrity`                        | Package integrity digests.                                                                                                                                  |
| `./companion-files`                  | Companion-file enforcement, shared between the platform ZIP-import path and the runtime bundle loader.                                                      |
| `./credential-template`              | Credential-template placeholder substitution.                                                                                                               |
| `./delivery-http`                    | Shared HTTP delivery contract.                                                                                                                              |
| `./semver-resolve`                   | Version-range resolution against a published version list.                                                                                                  |
| `./api-tool-naming` · `./mcp-naming` | Deterministic tool and MCP-server naming.                                                                                                                   |
| `./file-field`                       | File-field parsing helpers.                                                                                                                                 |
| `./token-usage`                      | Token-usage accounting shapes.                                                                                                                              |
| `./backoff`                          | Retry backoff computation.                                                                                                                                  |

```ts
import { guardedFetch } from "@appstrate/afps-shared/guarded-fetch";

// Refuses private ranges, link-local addresses and DNS-rebinding attempts.
const res = await guardedFetch(untrustedUrlFromManifest);
```

## Versioning

`@appstrate/core` depends on this package by caret range, so **a release here
must be published before any `@appstrate/core` release that bumps its
range** — otherwise `npm install @appstrate/core` cannot resolve.

Publishing is triggered by pushing an `afps-shared@X.Y.Z` git tag; CI handles the
rest (`.github/workflows/publish-afps-shared.yml`).

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
