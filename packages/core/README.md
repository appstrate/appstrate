# `@appstrate/core`

Shared library of [Appstrate](https://github.com/appstrate/appstrate) — the
open-source platform for running autonomous AI agents in sandboxed containers.

This package is what you build **against**, not the platform itself. It carries
the contracts that the platform, its modules and its satellite services all have
to agree on: the AFPS manifest schemas, the module interface, the RBAC catalog,
the storage abstraction and the naming/versioning rules.

```sh
npm install @appstrate/core
```

**Requires Bun ≥ 1.3.9.** The package ships raw TypeScript sources rather than a
compiled bundle, so Node cannot import it directly.

## No barrel export

Every module is imported by subpath. This is deliberate — it keeps consumers from
pulling the whole surface (and its Zod/AJV/pino dependencies) to use one helper.

```ts
import { createLogger } from "@appstrate/core/logger";
import { agentManifestSchema } from "@appstrate/core/validation";
import type { AppstrateModule } from "@appstrate/core/module";
```

## Main surfaces

**Extending the platform**

| Subpath            | What it does                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `./module`         | The Appstrate Module System contract. Implement this to add a module (model providers, routes, hooks) without depending on the API package.      |
| `./permissions`    | RBAC contract — the core resource catalog plus the extension point modules use to register their own permissions with full TypeScript narrowing. |
| `./platform-types` | Shared platform-facing types.                                                                                                                    |

**AFPS packages**

| Subpath                                                      | What it does                                                                            |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `./validation`                                               | Zod schemas for agent, skill and integration manifests, layered on `@afps-spec/schema`. |
| `./integration`                                              | AFPS integration manifest — schema, types, and the install-time scope/tool helpers.     |
| `./naming` · `./semver` · `./dist-tags` · `./version-policy` | Scope/name rules, version resolution, dist-tag and version-policy semantics.            |
| `./dependencies` · `./integrity` · `./zip`                   | Dependency resolution, integrity digests, package ZIP parsing.                          |
| `./system-packages`                                          | System-package catalog helpers.                                                         |

**Runtime & agents**

| Subpath                                           | What it does                              |
| ------------------------------------------------- | ----------------------------------------- |
| `./mcp-server` · `./mcp-server-bundle`            | MCP server definition and bundling.       |
| `./runtime-tools-catalog` · `./runtime-tool-defs` | Built-in runtime tools exposed to agents. |
| `./runtime-event-drain`                           | Runtime event draining.                   |
| `./sidecar-types`                                 | Sidecar protocol types.                   |
| `./chat-contract` · `./chat-turn-metadata`        | Chat surface contract.                    |
| `./token-usage` · `./token-budget`                | Token accounting and budgeting.           |
| `./run-and-wait-client`                           | Client for the run-and-wait flow.         |

**Infrastructure**

| Subpath                                                                    | What it does                                                                                  |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `./storage` · `./storage-s3` · `./storage-fs`                              | Storage abstraction with S3 (configurable endpoint, so MinIO/R2 work) and filesystem drivers. |
| `./logger`                                                                 | Structured pino logging. Appstrate code never uses `console.*`.                               |
| `./cache`                                                                  | Read-through TTL cache with request coalescing and a replica invalidation bus.                |
| `./telemetry`                                                              | OpenTelemetry façade — a no-op unless an observability module is loaded.                      |
| `./env` · `./errors` · `./api-errors` · `./safe-json` · `./sse` · `./html` | Environment access, error taxonomy, JSON/SSE/HTML helpers.                                    |
| `./ssrf`                                                                   | SSRF guards (re-exported from `@appstrate/afps-shared`).                                      |
| `./jwt` · `./pairing-token` · `./oauth-bearer-swap`                        | Token minting, device pairing, OAuth bearer swapping.                                         |

The full list lives in the `exports` map of `package.json`.

## Versioning

`@appstrate/core` depends on
[`@appstrate/afps-shared`](https://www.npmjs.com/package/@appstrate/afps-shared)
by caret range. When a change spans both, **publish `afps-shared` first** —
otherwise this package cannot resolve its own dependency on install.

Publishing is triggered by pushing a `core@X.Y.Z` git tag; CI handles the rest
(`.github/workflows/publish-core.yml`). The full procedure — release ordering,
the consumer lockstep gate and how to bypass it — is in
[docs/deployment/RELEASING_CORE.md](../../docs/deployment/RELEASING_CORE.md).

See [CHANGELOG.md](./CHANGELOG.md) for the release history, including breaking
changes between major versions.

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
