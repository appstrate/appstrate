# Built-in Modules

Built-in modules extend the Appstrate platform with optional features (currently: oidc, webhooks). They follow the same `AppstrateModule` contract as external modules published on npm, but live inside the API package so they can share test infrastructure and be discovered automatically.

## Auto-discovery

At boot, `apps/api/src/lib/modules/module-loader.ts` scans this directory and registers every subdirectory with an `index.ts` as a candidate built-in module. The module `id` equals the directory name. The loader does not read any hardcoded list — adding a new module is literally dropping a new folder here.

Only modules listed in the `MODULES` environment variable are actually initialized. Everything else is inert: no tables, no routes, no workers, no hook handlers.

The default value is `oidc,webhooks,mcp,core-providers,@appstrate/module-chat` — `oidc`/`webhooks`/`mcp`/`core-providers` are built-in dir modules and `@appstrate/module-chat` is a workspace npm module (all Apache-2.0 OSS), loaded out of the box. Override `MODULES` to extend (by appending external npm specifiers) or to remove any of them.

## Directory layout

```
apps/api/src/modules/<id>/
├── index.ts           # Default-exports an `AppstrateModule`
├── README.md          # Purpose, hooks/events, disable behavior
├── routes.ts          # (or routes/)  Hono router mounted under /api
├── service.ts         # Business logic, workers, lifecycle
├── lib/               # Module-private utilities (cron parser, helpers…)
├── test/              # Pure unit tests for module-internal logic (no DB/HTTP)
└── openapi/
    ├── paths.ts       # OpenAPI path items (merged into the platform spec)
    └── schemas.ts     # Component schemas (merged into components.schemas)
```

> A module owns **no** `schema.ts` / `drizzle/` — its tables live in the core
> schema (`packages/db/src/schema/`). See "Database ownership rules" below.

## Test placement

Module tests are split by dependency footprint, not by feature:

- **Colocate in `apps/api/src/modules/<id>/test/`** — pure unit tests of module-internal logic that do not need a database, a running Hono app, or the shared `test/helpers/` infrastructure (e.g. envelope builders, signing, cron parsing, schema coercion).
- **Keep in `apps/api/test/integration/`** — anything that touches the DB, calls the HTTP app via `getTestApp()`, or relies on shared factories (`seedPackage`, `createTestContext`, `truncateAll`). These depend on the global test preload (Docker infra, migrations) and must stay in the top-level test tree so they share one setup cost.

The rule is "colocate tests that can run in isolation, centralize tests that share infrastructure." Don't invent a parallel helper tree inside the module just to avoid an integration import.

## Required manifest shape

```ts
import type { AppstrateModule, ModuleInitContext } from "@appstrate/core/module";

const myModule: AppstrateModule = {
  manifest: { id: "my-feature", name: "My Feature", version: "1.0.0" },

  async init(ctx: ModuleInitContext) {
    // Modules own no tables — `ctx` provides redis/appUrl + platform services,
    // not a migrator. Start workers, warm caches, capture `ctx.services`, etc.
  },

  createRouter() {
    return createMyFeatureRouter(); // Hono<AppEnv>
  },

  openApiPaths() {
    return myFeaturePaths;
  },

  features: { myFeature: true },

  async shutdown() {
    // stop workers, close queues
  },
};

export default myModule;
```

Everything else (`hooks`, `events`, `openApiComponentSchemas`, `openApiSchemas`, `emailOverrides`, `publicPaths`, `manifest.dependencies`) is optional. Use `publicPaths` for routes that bypass auth (e.g. inbound webhook callbacks). Modules that need `X-Application-Id` context for their routes gate it themselves (e.g. an explicit `applicationId` body/query field validated against the caller's org).

## Database ownership rules

**Modules own no tables.** All OSS tables — including those a module reads/writes
(e.g. OIDC's `oauth_clients`/`jwks`, webhooks' `webhooks`) — live in the **core
schema** (`packages/db/src/schema/`) and are created by the system migration
pipeline at boot. A module is pure behavior: routes, hooks, events, RBAC, Better
Auth plugins, model providers, OpenAPI. There is no module `schema.ts`, no
per-module migration tree, no `__drizzle_migrations_<id>`, and no `drizzleSchemas()`
or `ctx.applyMigrations` — those were removed in core 2.23.0.

1. A module's tables are defined in `packages/db/src/schema/<domain>.ts` and
   exported from the core barrel. The module imports them from `@appstrate/db/schema`.
2. Better Auth tables (jwks, oauth_clients, …) are resolved by the adapter
   directly from the core barrel — no module-side registration.
3. Core never imports from `apps/api/src/modules/`. If core needs data from a
   module, use a hook (`beforeRun`, `afterRun`) — never a direct import. A
   module reads another module's data via the platform API/events, never a
   cross-module SQL join.
4. **Need a separate tenant?** A module that must own a physically isolated
   database (e.g. the proprietary `@appstrate/cloud` module) runs its own
   database and migrations, and reads platform data through `ctx.services`
   (e.g. `services.runs.listLlmUsage`), never a cross-DB join.

## Permissions

The platform ships RBAC as a typed contract that **both** core and modules contribute to. The role-to-permission matrix lives in `apps/api/src/lib/permissions.ts` — it composes:

1. **Core resources** (`CoreResources` interface from `@appstrate/core/permissions`): the static platform catalog (`agents`, `runs`, `org`, `api-keys`, …). This set is fixed at core-release time and mapped to roles in `apps/api/src/lib/permissions.ts`.
2. **Module-contributed resources** (`AppstrateModule.permissionsContribution()` + `declare module "@appstrate/core/permissions" { interface ModuleResources { … } }`): **every** module — built-in (`webhooks`, `oidc`) and external — declares new resources through TypeScript declaration merging plus a runtime contribution. The platform aggregates them at boot, merges the grants into `resolvePermissions(role)`, and exposes them through the same RBAC machinery.

Built-in and external modules use the **exact same contribution pattern**. Built-ins do not extend `CoreResources` — that interface is reserved for the platform's own resource catalog. The only difference is where the module source lives (this directory vs. an npm package).

### The module pattern (built-in or external)

```ts
// 1. Type-level — declaration merging on ModuleResources
declare module "@appstrate/core/permissions" {
  interface ModuleResources {
    tasks: "read" | "write";
  }
}

// 2. Runtime — manifest field
const tasksModule: AppstrateModule = {
  manifest: { id: "tasks", name: "Tasks", version: "1.0.0" },
  permissionsContribution: () => [
    {
      resource: "tasks",
      actions: ["read", "write"],
      grantTo: ["owner", "admin", "member"],
      apiKeyGrantable: true, // can be carried by API keys
      endUserGrantable: true, // can be carried by end-user OIDC tokens
    },
  ],
  // ...
};

// 3. Route guards — typed helpers exported from core
import { requireModulePermission, requireCorePermission } from "@appstrate/core/permissions";

router.get(
  "/api/tasks",
  requireModulePermission("tasks", "read"), // typed against ModuleResources
  handler,
);
router.post(
  "/api/tasks/:id/cancel",
  requireCorePermission("agents", "run"), // typed against CoreResources
  handler,
);
```

Both built-in modules in this repo (`webhooks`, `oidc`) use this pattern — read their `index.ts` + `routes.ts` for reference.

**At boot, the platform validates each contribution** (resource name format, no collision with a core resource or another module, action format, role validity) and aggregates them into:

- `resolvePermissions(role)` — module entries for the listed roles are written into the per-role permission Set returned to the auth pipeline.
- `getApiKeyAllowedScopes()` — entries with `apiKeyGrantable: true` become grantable through API keys (filtered against the creator's role at issuance).
- `getModuleEndUserAllowedScopes()` — entries with `endUserGrantable: true` are accepted on end-user OIDC JWTs (in addition to the built-in `OIDC_ALLOWED_SCOPES`). Defaults to `false` — admin / destructive surfaces stay closed to embedding apps.

Disabling a module leaves **zero footprint**: the `declare module` augmentation widens types but contributes nothing at runtime (interface keys aren't iterated), and the runtime contribution is gone the moment `permissionsContribution()` stops being called. No dead scope strings in role sets, no dead entries in the API-key allowlist.

### Middleware symmetry: one guard path

Core routes use `requirePermission` (apps/api-internal, union-typed against core + module resources). Module routes use `requireCorePermission` / `requireModulePermission` (from `@appstrate/core/permissions`). All three **delegate to the same `makePermissionGuard`** in core — identical fail-closed semantics, identical error shape, identical audit logging (`permission_denied` via the handler registered at boot in `apps/api/src/lib/permission-audit.ts`). Modules cannot diverge from core on denial behavior.

### Adding a new core resource

Core resources are reserved for the platform itself. If the platform (not a module) needs a new resource, edit `CoreResources` in `@appstrate/core/permissions` → edit `CORE_RESOURCE_NAMES` in the same file (drift caught by a unit test) → wire the role grants + API-key allowlist in `apps/api/src/lib/permissions.ts` → call `requirePermission(...)` or `requireCorePermission(...)` at the route.

## Model providers

Modules contribute model providers (the LLM backends Appstrate knows how to authenticate against and talk to) via `modelProviders()` on the `AppstrateModule` contract. Each `ModelProviderDefinition` carries its wire format (`apiShape`, `defaultBaseUrl`, `forceStream`/`forceStore`), auth mode (`api_key` or `oauth2` + `oauth` config), model catalog, and an optional `hooks` block. The platform aggregates every loaded module's contributions into a runtime registry (`apps/api/src/services/model-providers/registry.ts`) and resolves by `providerId` — it never reaches into a module's internals.

Provider hooks (`ModelProviderHooks`):

- **`extractTokenIdentity(accessToken) → ModelProviderIdentity | null`** — runs once at credential import + after every refresh. Maps the provider's claim vocabulary (e.g. a JWT payload) into the platform's well-known abstract slots: `{ accountId?, email? }`. The platform persists the result and never re-decodes.
- **`buildApiKeyPlaceholder(accessToken) → string | null`** — builds the `MODEL_API_KEY` value the agent container sees, when the in-container LLM client expects a structurally meaningful shape (e.g. a JWT it will decode). Return `null` to fall back to the platform's generic dash-stripped placeholder. The real upstream credential never leaves the platform/sidecar boundary.
- **`validateCredential(ctx) → CredentialValidationResult`** — validates a credential **offline** (no network), used by the connection test (`POST /api/models/test`). Implement it together with `credentialValidation: "offline"` on the provider definition: the platform then runs this local check instead of issuing any API call (subscription providers decode the token to confirm it is well-formed + unexpired). Return `{ ok: true }` for a valid credential or `{ ok: false, error, message }` otherwise. API-key providers omit it and fall back to the generic `GET ${baseUrl}/models` probe.

Declarative gate: `requiredIdentityClaims: readonly (keyof ModelProviderIdentity)[]` on the provider definition makes the platform refuse to import a credential whose mandatory slots can't be resolved — fail-loud at import time instead of silently persisting a dead credential.

Reference module: `core-providers` (openai/anthropic/openai-compatible — API keys only, no hooks needed). Workspace OAuth modules under `packages/module-*/` show how to implement the three hooks together with `requiredIdentityClaims`. External operator-installed providers extend the catalog the same way.

## Orchestrators (execution backends)

Modules contribute execution backends via `orchestrators(): Record<string, OrchestratorRegistration>` — keys are `RUN_ADAPTER` values, registered by the loader at load time (before any orchestrator is instantiated). Core ships `docker` and `process`; the built-in `firecracker` module (opt-in, not in the default `MODULES`) is the reference contribution — it registers a single backend, `firecracker`, an HTTP client (`RemoteFirecrackerOrchestrator`) that proxies to an `appstrate-runner` host daemon (the daemon embeds the in-process `FirecrackerOrchestrator` as its engine; see `modules/firecracker/README.md`).

Each `OrchestratorRegistration` (`@appstrate/core/platform-types`) declares:

- **`isolatesWorkloads`** — security-sensitive: whether each run gets a real isolation boundary (container, microVM) keeping run credentials out of the host API process. The subscription-run policy refuses OAuth-subscription runs on any backend that does not declare it. The declaration is trusted (a module in `MODULES` is operator-installed code), but unknown/unregistered ids always degrade fail-closed to "no capability".
- **`supportsSidecarOnly`** — whether the backend can run a sidecar-only workload (connect-runs). Backends whose lifecycle is driven by the agent (one-shot microVM boot) declare `false`; connect fails fast.
- **`create()`** — builds the `RunOrchestrator` instance (singleton, created lazily at first `getOrchestrator()`).

A duplicate id across modules/core is a fatal boot error (never silently shadowed). `RUN_ADAPTER` is an open string in the env schema — the registry validates it at first resolution; an unknown id is fatal with the registered list and a `MODULES` hint. Heavy prerequisite checks (binaries, kernels, /dev/kvm) belong in the orchestrator's `initialize()`, NOT in module `init()`: a loaded module whose backend is not the selected `RUN_ADAPTER` must not fail boot.

## Telemetry provider

Core instruments its seams through the provider-agnostic façade
`@appstrate/core/telemetry` — a true no-op until a module installs a provider
via `installTelemetryProvider()`. The opt-in workspace module
`@appstrate/module-observability` (`packages/module-observability/`) is the
reference implementation: it installs the OpenTelemetry provider at `init()`
and contributes the HTTP SERVER-span middleware through the provider's
`httpMiddleware` slot (delegated per request by core's global
`apps/api/src/middleware/telemetry.ts`); it owns no tables and no routes.
Flush stays core-driven — `shutdownTelemetry()` is called from
`apps/api/src/lib/shutdown.ts`, so the module declares no `shutdown()` hook.

Modules that need the platform's TRUST_PROXY-honoring client-IP resolution use
`services.http.clientIp(c)` from `PlatformServices` instead of importing from
`apps/api` — that is how the observability middleware tags `client.address`.
Full design: `docs/architecture/OBSERVABILITY.md`.

## Hooks and events

- **Hooks** (`callHook`, first-match-wins): `beforeRun`, `afterRun`, `beforeSignup`. The first module that provides a hook is called, subsequent modules are skipped. `beforeRun` gates a run, `afterRun` returns a metadata patch persisted on the final run record, `beforeSignup` gates signup.
- **Events** (`emitEvent`, broadcast-to-all): `onRunStatusChange`, `onOrgCreate`, `onOrgDelete`. Handlers run for side effects only; errors in one handler are isolated and do not block others.

Names are defined in `packages/core/src/module.ts` (`ModuleHooks`, `ModuleEvents`). To add a new hook or event, update that file first so both platform and modules see the same contract.

## Auth strategies

Modules can contribute custom authentication strategies that run in the request pipeline **before** core auth (Bearer ask\_ API key → session cookie). This is how OIDC/JWT, mTLS, SAML, webhook-HMAC, and similar auth mechanisms plug in without touching `apps/api/src/index.ts`.

A strategy is a plain object implementing `AuthStrategy` from `@appstrate/core/module`:

```ts
import type { AppstrateModule, AuthStrategy } from "@appstrate/core/module";

const jwtStrategy: AuthStrategy = {
  id: "my-jwt",
  async authenticate({ headers, method, path }) {
    const auth = headers.get("authorization") ?? "";
    // Fast no-match path — return null immediately for anything not ours
    if (!auth.startsWith("Bearer ey")) return null;

    const payload = await verifyJwt(auth.slice(7));
    if (!payload) return null;

    return {
      user: { id: payload.sub, email: payload.email, name: payload.name },
      orgId: payload.org_id,
      orgRole: "admin",
      authMethod: "my-jwt",
      applicationId: payload.app_id,
      permissions: ["runs:read", "runs:write"],
      // Optional end-user impersonation
      endUser: {
        id: payload.enduser_id,
        applicationId: payload.app_id,
        role: payload.role ?? null,
      },
    };
  },
};

const myModule: AppstrateModule = {
  manifest: { id: "my-auth", name: "My Auth", version: "1.0.0" },
  async init() {},
  authStrategies() {
    return [jwtStrategy];
  },
};
```

**Strategy discipline — critically important.** Each strategy MUST return `null` as early as possible when the request is not for it. A strategy that claims every request would shadow core API key auth (`Bearer ask_…`) and the session cookie fallback. The framework does not enforce this — it is the strategy author's responsibility to write a fast-path check on the header shape (JWT strategies check `Bearer ey…`, mTLS checks client cert presence, etc.).

**Ordering.** Strategies are tried in module load order (topological sort by `manifest.dependencies`). First non-null resolution wins. Core auth (API key + cookie) runs only when every strategy has returned `null`.

**What a resolution sets on `c`.** Mirrors what core API-key auth sets: `user`, `orgId`, `orgSlug?`, `orgRole`, `authMethod`, `applicationId`, `permissions` (as a string set), optional `endUser`. Downstream middleware treats strategy-authenticated requests the same as API-key requests — org-context and permission-resolution middlewares are skipped because the strategy has already resolved everything.

**`permissions` type.** `readonly string[]` at the contract layer (not the typed `Permission[]` union) to keep the core RBAC catalog out of `@appstrate/core`. Use permission strings that match core's `resource:action` vocabulary — `requirePermission()` guards will 403 on unknown strings at request time.

## Better Auth plugins

Modules can contribute Better Auth plugins (e.g. `jwt`, `oauthProvider`, `passkey`, a future SAML plugin) via `betterAuthPlugins()`. The contributed plugins are merged with the platform's base plugins when the Better Auth singleton is constructed at boot:

```ts
import type { AppstrateModule } from "@appstrate/core/module";
import type { BetterAuthPluginList } from "@appstrate/db/auth";
import { jwt } from "better-auth/plugins/jwt";

const myModule: AppstrateModule = {
  manifest: { id: "my-auth", name: "My Auth", version: "1.0.0" },
  async init() {},
  betterAuthPlugins(): BetterAuthPluginList {
    return [jwt({ jwks: { keyPairConfig: { alg: "ES256" } } })];
  },
};
```

The return type is `unknown[]` at the core contract level (to keep Better Auth types out of `@appstrate/core`, which is published on npm). Modules that want strong typing can import `BetterAuthPluginList` from `@appstrate/db/auth` and annotate their return value — the boot integration site narrows `unknown[]` to the correct type via a cast.

**Lifecycle.** `createAuth()` runs exactly once at boot, after `loadModules()`. By then every module has been initialized and had the chance to declare its plugin contributions. The Better Auth singleton is then constructed with `[...basePlugins, ...modulePlugins]`. The `auth` export is a Proxy that forwards to the singleton — do not read properties off `auth` at module-evaluation time (before boot), only at request time inside handlers.

## End-user run visibility

Core enforces a single hard rule: when an end-user is in the request context (via `Appstrate-User` impersonation or via a module auth strategy setting `endUser` on `AuthResolution`), the runs endpoints (`list/get/logs` in `apps/api/src/routes/runs.ts`) filter strictly to `endUser.id`. There is no core knob, hook, or role vocabulary to widen this. Core has no opinion on RBAC.

A module that needs a different visibility model (team-wide, org-admin end-users, etc.) expresses it out-of-band — typically by exposing its own routes under its own prefix (e.g. `/api/<mod>/runs`) that call the `listPackageRuns` service directly with whatever filters the module decides. Core stays strict and predictable; modules compose alternative UX on top.

Applications embedding Appstrate headlessly that want an "admin dashboard" view simply don't send `Appstrate-User` on admin calls — a raw API key request has no `endUser` context, so the self-filter doesn't apply and the caller sees every run in the application (which `applicationId` still scopes).

## OpenAPI contributions

Modules that expose HTTP routes should also provide `openApiPaths()` (path items) and, if they use shared response/request shapes, `openApiComponentSchemas()` (component schemas) plus `openApiSchemas()` (Zod → OpenAPI registry entries for request-body validation). The loader merges contributions from every loaded module into the final spec; `scripts/verify-openapi.ts` replays the same merge at check time and flags any mismatch between declared paths and the baseline.

Because discovery is filesystem-based, adding a new endpoint only requires touching the module's own `openapi/` directory — no central list to update.

## Disabling a module

`MODULES` is comma-separated. Remove the module id (or package specifier) and the platform boots without importing a single byte of its code. `MODULES=none` boots with zero modules (the empty string resolves to the default set — the env getter coalesces empty to unset, per the compose `${VAR:-}` pattern). The module's tables remain in the database (data is preserved), but no queries, routes, hooks, events, permissions, or feature flags are wired up. To drop the tables as well, write a separate migration or run a manual `DROP TABLE`.

This is the "zero footprint" guarantee: the only coupling between core and a module is through the `AppstrateModule` contract. If core ever needs to special-case a specific module id, that is a design failure — use hooks, events, or feature flags instead.
