# Built-in Modules

Built-in modules extend the Appstrate platform with optional features. They follow the same `AppstrateModule` contract as external modules published on npm, but live inside the API package so they can share test infrastructure and be discovered automatically.

**This file is the owner of two facts other docs point at**: which directories are built-in modules, and the database-ownership rule below. The directories at the time of writing are `core-providers`, `firecracker`, `mcp`, `oidc` and `webhooks` — `ls apps/api/src/modules/` is the authority, because the loader reads the directory and not a list (see Auto-discovery). Of those, `firecracker` is opt-in and absent from the `MODULES` default.

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

An **out-of-tree** module (its own repo, `@appstrate/core` from npm) declares nothing extra: put `@appstrate/core` in its `package.json` like any dependency, and the platform reads the range from there.

The loader checks that range against the platform's `CORE_VERSION` at boot. It exists because the module→platform direction is invisible to `tsc`: a stale module calling a platform service whose signature moved (core 6.0.0 made `checkUsageAllowed`'s `subscription` flag required) fails **silently**, not loudly (issue #973). When no range is resolvable the loader warns and boots anyway. In-tree modules (`workspace:*`) are exempt — `tsc` already gates them.

A mismatch refuses to boot by default, naming the module and both versions. `MODULE_CONTRACT_ENFORCE=warn` downgrades it to a log line — the escape hatch for an operator running a module that has not been republished against the core major the platform ships.

Everything else (`hooks`, `events`, `openApiComponentSchemas`, `openApiSchemas`, `emailOverrides`, `publicPaths`, `manifest.dependencies`) is optional. Use `publicPaths` for routes that bypass auth (e.g. inbound webhook callbacks). Modules that need `X-Space-Id` context for their routes gate it themselves (e.g. an explicit `spaceId` body/query field validated against the caller's org).

## Database ownership rules

**Modules own no tables.** All OSS tables — including those a module reads/writes
(e.g. OIDC's `oauth_clients`/`jwks`, webhooks' `webhooks`) — live in the **core
schema** (`packages/db/src/schema/`) and are created by the system migration
pipeline at boot. A module is pure behavior: routes, hooks, events, RBAC, Better
Auth plugins, model providers, OpenAPI. The module contract carries no schema
or migration surface at all: no module `schema.ts`, no per-module migration
tree, no `__drizzle_migrations_<id>` table.

1. A module's tables are defined in `packages/db/src/schema/<domain>.ts` and
   exported from the core barrel. The module imports them from `@appstrate/db/schema`.
2. Better Auth tables (jwks, oauth_clients, …) are resolved by the adapter
   directly from the core barrel — no module-side registration.
3. Core never imports from `apps/api/src/modules/`. If core needs data from a
   module, use a hook (`beforeUsage`) or an event — never a direct import. A
   module reads another module's data via the platform API/events, never a
   cross-module SQL join.
4. **Need a separate tenant?** A module that must own a physically isolated
   database (e.g. the proprietary `@appstrate/cloud` module) runs its own
   database and migrations, and reads platform data through `ctx.services`
   (e.g. `services.usage.list`), never a cross-DB join.

## Permissions

The platform ships RBAC as a typed contract that **both** core and modules contribute to. The role-to-permission matrix lives in `apps/api/src/lib/permissions.ts` — it composes:

1. **Core resources** (`CoreResources` interface from `@appstrate/core/permissions`): the static platform catalog (`agents`, `runs`, `org`, `api-keys`, …). Each one declares its LEVEL in `CORE_RESOURCE_LEVELS` next to its actions; org-level resources are mapped to org roles and space-level ones to the four space-role presets, both in `apps/api/src/lib/permissions.ts`.
2. **Module-contributed resources** (`AppstrateModule.permissionsContribution()` + `declare module "@appstrate/core/permissions" { interface ModuleResources { … } }`): **every** module — built-in (`webhooks`, `oidc`) and external — declares new resources through TypeScript declaration merging plus a runtime contribution. The platform aggregates them at boot, merges the grants into `orgPermissions(role)` / `presetPermissions(preset)`, and exposes them through the same RBAC machinery.

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
      // Space-level: the rows carry a `space_id`, so space roles grant it.
      level: "space",
      presets: ["admin", "builder", "operator"],
      apiKeyGrantable: true, // can be carried by API keys
      endUserGrantable: true, // can be carried by end-user OIDC tokens
    },
    {
      resource: "task-settings",
      actions: ["write"],
      // Org-level: one row per org, so org roles grant it.
      level: "org",
      grantTo: ["owner", "admin"],
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

The built-in modules that contribute permissions (`webhooks`, `oidc`, `mcp`) use this pattern — read their `index.ts` + `routes.ts` for reference.

`level` is the discriminant (RBAC spec §3.4). Every permission string belongs
to exactly one level: `level: "org"` takes `grantTo` (org roles) and
`level: "space"` takes `presets` (space-role presets — `admin`, `builder`,
`operator`, `viewer`). There is no default and no fallback; pick the level from
where the resource's rows live. Listing the same resource twice with different
`actions` is how per-action granularity is expressed, and both entries must
declare the same level.

**At boot, the platform validates each contribution** (resource name format, no collision with a core resource or another module, action format, one level per resource, role/preset validity) and aggregates them into:

- `orgPermissions(role)` / `presetPermissions(preset)` — module entries reach the org role or the space preset they listed.
- `getApiKeyAllowedScopes()` — entries with `apiKeyGrantable: true` become grantable through API keys (filtered against the creator's role at issuance).
- `getModuleEndUserAllowedScopes()` — entries with `endUserGrantable: true` are accepted on end-user OIDC JWTs (in addition to the built-in `OIDC_ALLOWED_SCOPES`). Defaults to `false` — admin / destructive surfaces stay closed to embedding apps.

Disabling a module leaves **zero footprint**: the `declare module` augmentation widens types but contributes nothing at runtime (interface keys aren't iterated), and the runtime contribution is gone the moment `permissionsContribution()` stops being called. No dead scope strings in role sets, no dead entries in the API-key allowlist.

### `permissionsContribution` vs `principalPermissions`

Two contribution members, one question: **is the population that holds this
permission a ROLE, or a LIST the module maintains?**

|               | `permissionsContribution()`                           | `principalPermissions`            |
| ------------- | ----------------------------------------------------- | --------------------------------- |
| Grants to     | an org role (`grantTo`) or a space preset (`presets`) | one `(orgId, userId)`             |
| Level         | org or space                                          | **org only**                      |
| Vocabulary    | declares NEW resources                                | reuses strings that already exist |
| Evaluated for | every caller                                          | session-shaped callers only       |
| Cost          | a boot-time table                                     | one cached lookup per principal   |

`permissionsContribution` is the common case and the two compose: a module
declares its resource and its role grants there, then hands **extra copies of
those same strings** to named principals here. There is no third case — a
per-principal grant never invents vocabulary.

```ts
const billingModule: AppstrateModule = {
  manifest: { id: "billing", name: "Billing", version: "1.0.0" },
  permissionsContribution: () => [
    { resource: "billing", actions: ["read"], level: "org", grantTo: ["owner", "admin", "member"] },
    { resource: "billing", actions: ["manage"], level: "org", grantTo: ["owner", "admin"] },
  ],
  // …and these people hold both without being admins.
  principalPermissions: {
    mayGrant: ["billing:read", "billing:manage"],
    resolve: async ({ orgId, userId }) =>
      (await isBillingManager(orgId, userId)) ? ["billing:read", "billing:manage"] : [],
  },
  // ...
};
```

Reach for `principalPermissions` when the answer is a row in the module's own
table — billing managers, an SSO group mapping — and the alternative would be
inventing an org role for them. That alternative is what the surface exists to
avoid: an org role is platform vocabulary, and `billing` is not.

**Two boot rules, both fail-fast and both naming the module and the string.**
Every `mayGrant` entry must be a known ORG-level permission (the core catalog,
or a `level: "org"` contribution of some loaded module) — a space-level string
is granted per space and this surface has no space. And no entry may be
`apiKeyGrantable` / `endUserGrantable`: the surface is evaluated for
session-shaped callers only, so a delegated credential's ceiling can never
carry the grant and declaring one would advertise access no key can obtain.

**At runtime**: the resolver is called once per principal per cache miss, its
answer is filtered to `mayGrant` (an undeclared string is dropped and logged,
never granted), and a throwing resolver contributes nothing rather than failing
the request — a module's outage must not lock a caller out of the permissions
their own role gives them.

**Invalidation is yours.** Results are cached per `(orgId, userId)` with a 10s
TTL. The platform cannot know when your table changed, so call
`invalidatePrincipalPermissions(orgId, userId?)` from
`@appstrate/core/principal-permissions` after every write the resolver reads —
omit `userId` to drop the whole org. The TTL is only the backstop for a lost
bus broadcast, not the invalidation mechanism.

### A space-level resource on a route the platform does not space-scope

`SPACE_SCOPED_PREFIXES` (`apps/api/src/middleware/space-context.ts`) is
**core-only by design** — a module never adds a row to it. So a module that
gates a `level: "space"` resource on its own route family must enter a space
itself, before its guard runs:

```ts
import { enterSpaceContext, requireModulePermission } from "@appstrate/core/permissions";

router.use("/api/tasks/*", async (c, next) => {
  await enterSpaceContext(c); // pinned space → X-Space-Id (400 when neither)
  return next();
});
router.get("/api/tasks", requireModulePermission("tasks", "read"), handler);
```

Pass an explicit id (`enterSpaceContext(c, spaceId)`) when the route addresses a
space of its own — the `webhooks` module does, from its `spaceId` body/query
field, and again from the row's own space on its by-id routes.

A caller that names no space at all is a **400**, exactly as it is on a core
space-scoped route. The org's default space answers only the trusted in-process
MCP re-entry (the internal-dispatch marker), which is the one caller that
physically cannot carry a header. A module route is not a weaker door than a
core one: falling back to the default space for a session or CLI caller would
put them in a space they never asked for.

That makes the entry a decision, not a reflex. A router whose family mixes
space-level and ORG-level resources must enter only when the caller identifies
a space (`c.get("spaceId") ?? c.req.header("X-Space-Id")`) and skip otherwise —
`webhooks` does, because a `level: "org"` webhook is space-less and its
permission is org-level, so an unconditional entry would 400 a caller who needs
no space. Skipping leaves `permissions` at the org half, which is the correct
authority for those rows; a route that then wants either half gates on both
strings rather than on one (`requireAnyWebhookRead` in
`modules/webhooks/routes.ts`).

This is not optional: a caller outside a space holds **org-level strings only**,
so a space-level guard on a route that never entered a space can never pass. It
fails closed, which is the right default and the wrong behaviour. `chat`, `mcp`
and `webhooks` are the three in-repo examples. A caller with no role in the
resolved space is refused there (403 `not_a_space_member`, or 404 for a
`private` space) — the same answer the core middleware gives.

### Middleware symmetry: one guard path

Core routes use `requirePermission` (apps/api-internal, union-typed against core + module resources). Module routes use `requireCorePermission` / `requireModulePermission` (from `@appstrate/core/permissions`). All three **delegate to the same `makePermissionGuard`** in core — identical fail-closed semantics, identical error shape, identical audit logging (`permission_denied` via the handler registered at boot in `apps/api/src/lib/permission-audit.ts`). Modules cannot diverge from core on denial behavior.

### Adding a new core resource

Core resources are reserved for the platform itself. If the platform (not a module) needs a new resource, edit `CoreResources` in `@appstrate/core/permissions` → add its actions to `CORE_RESOURCE_ACTIONS` and its level to `CORE_RESOURCE_LEVELS` in the same file (drift caught by the `satisfies` clauses plus a unit test) → wire the org-role grants or space-role presets + API-key allowlist in `apps/api/src/lib/permissions.ts` → call `requirePermission(...)` or `requireCorePermission(...)` at the route.

## Model providers

Modules contribute model providers (the LLM backends Appstrate knows how to authenticate against and talk to) via `modelProviders()` on the `AppstrateModule` contract. Each `ModelProviderDefinition` carries its wire format (`apiShape`, `defaultBaseUrl`, `forceStream`/`forceStore`), auth mode (`api_key` or `oauth2` + `oauth` config), model catalog, and an optional `hooks` block. The platform aggregates every loaded module's contributions into a runtime registry (`apps/api/src/services/model-providers/registry.ts`) and resolves by `providerId` — it never reaches into a module's internals.

Provider hooks (`ModelProviderHooks`):

- **`extractTokenIdentity(accessToken) → ModelProviderIdentity | null`** — runs once at credential import + after every refresh. Maps the provider's claim vocabulary (e.g. a JWT payload) into the platform's well-known abstract slots: `{ accountId?, email? }`. The platform persists the result and never re-decodes.
- **`buildApiKeyPlaceholder(accessToken) → string | null`** — builds the `MODEL_API_KEY` value the agent container sees, when the in-container LLM client expects a structurally meaningful shape (e.g. a JWT it will decode). Return `null` to fall back to the platform's generic dash-stripped placeholder. The real upstream credential never leaves the platform/sidecar boundary.
- **`validateCredential(ctx) → CredentialValidationResult`** — validates a credential **offline** (no network), used by the connection test (`POST /api/models/test`). Offline validation is inferred from the **presence of this hook** — there is no flag on the provider definition to set. When it is present the platform runs this local check instead of issuing any API call (subscription providers decode the token to confirm it is well-formed + unexpired). Return `{ ok: true }` for a valid credential or `{ ok: false, error, message }` otherwise. API-key providers omit it and fall back to the generic `GET ${baseUrl}/models` probe. (Model _discovery_ without live probing is the separate, orthogonal `modelDiscovery: { mode: "static" }` field.)

Declarative gate: `requiredIdentityClaims: readonly (keyof ModelProviderIdentity)[]` on the provider definition makes the platform refuse to import a credential whose mandatory slots can't be resolved — fail-loud at import time instead of silently persisting a dead credential.

Reference module: `core-providers` (openai/anthropic/openai-compatible — API keys only, no hooks needed). Workspace OAuth modules under `packages/module-*/` show how to implement the three hooks together with `requiredIdentityClaims`. External operator-installed providers extend the catalog the same way.

## Orchestrators (execution backends)

Modules contribute execution backends via `orchestrators(): Record<string, OrchestratorRegistration>` — keys are `RUN_ADAPTER` values, registered by the loader at load time (before any orchestrator is instantiated). Core ships `docker` and `process`; the built-in `firecracker` module (opt-in, not in the default `MODULES`) is the reference contribution — it registers a single backend, `firecracker`, an HTTP client (`RemoteFirecrackerOrchestrator`) that proxies to an `appstrate-runner` host daemon (the daemon embeds the in-process `FirecrackerOrchestrator` as its engine; see `modules/firecracker/README.md`).

Each `OrchestratorRegistration` (`@appstrate/core/platform-types`) declares:

- **`isolatesWorkloads`** — security-sensitive: whether each run gets a real isolation boundary (container, microVM) keeping run credentials out of the host API process. The subscription-run policy refuses OAuth-subscription runs on any backend that does not declare it. The declaration is trusted (a module in `MODULES` is operator-installed code), but unknown/unregistered ids always degrade fail-closed to "no capability".
- **`supportsSidecarOnly`** — whether the backend can run a sidecar-only workload (connect-runs). Backends whose lifecycle is driven by the agent (one-shot microVM boot) declare `false`; connect fails fast.
- **`agentResources`** — optional resource contract: `semantics` is `limits` or `sizing`, `maxAgentCpu` optionally caps agent CPU, and `writableRootTmpfsPercent` optionally reports the guest-RAM percentage capping the writable root (including the workspace). The registry validates numeric fields at registration (`maxAgentCpu` must convert safely to nanoCPU; the tmpfs percentage is an integer from 1 to 100). Absence and unknown backends fail closed to no resource semantics.
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

A hook's dispatch mode is **fixed by the contract, per hook name** — it is not a
property of the call site. `packages/core/src/module.ts` splits the map in two
(`FirstMatchHooks` / `BroadcastHooks`); the platform's two dispatchers are typed
to accept only their own half, so the wrong-mode call does not compile.

- **First-match-wins hooks** (`callHook`, `FirstMatchHooks`): `beforeUsage`.
  Only the first module providing it is called; its answer is authoritative.
  `beforeUsage` gates metered LLM usage on a surface — a discriminated union
  over `run` (agent run) and `chat` (chat turn). One verdict is wanted, so a
  second implementer would need a merge rule the contract does not define.
- **Broadcast hooks** (`callAllHooks`, `BroadcastHooks`): `beforeSignup`,
  `afterSignup`. **Every** module providing them is called, in load order, and
  errors **propagate** — a throwing `beforeSignup` aborts user creation. These
  are gates several modules may legitimately veto (a metering module's
  free-tier policy and OIDC's per-client org policy are independent), so
  dispatching them first-match-wins would silently disable all but the first.
- **Events** (`emitEvent`, broadcast-to-all): `onRunStatusChange`,
  `onRunConnectionMissing`, `onOrgCreate`, `onOrgDelete`. Handlers run for side
  effects only; errors in one handler are **isolated** and do not block others —
  that isolation is the difference from a broadcast hook.

Names are defined in `packages/core/src/module.ts` (`FirstMatchHooks` /
`BroadcastHooks` / `ModuleHooks`, `ModuleEvents`). To add a new hook or event,
update that file first — including its `scripts/verify-module-contract.ts`
ledger entry — so both platform and modules
see the same contract. A hook or event no module implements fails that check as
dead surface.

### `beforeUsage` — admission (core 5.0.0+)

The hook is dispatched for **every** run and **every** chat turn, not for a subset the platform pre-selected. Each dispatch carries neutral execution facts, and the module turns them into a decision:

- **`credentialSource`** — whose credential is spent on inference: `"system"` (platform-supplied credential or system model preset), `"org"` (the organization's own BYOK key or OAuth subscription), or — `run` only — `null` when a remote-origin run resolves its model later on its own host (any inference it then routes through the system model proxy is admitted at that seam instead).
- **`executionPlane`** — whose compute runs the work: `"platform"` (a sandbox the platform operates, or its own chat process — always the case for `chat`) or `"remote"` (caller-supplied host).
- **`timeoutSeconds`** (`run` only) — the effective post-ceiling upper bound on platform compute occupancy, or `null` at a seam that does not own the run's compute and must therefore contribute nothing for it (NOT "unknown, assume the worst" — that double-counts).

**Deciding that an operation consumes nothing is the module's job**, not the platform's. The platform used to skip the hook whenever the organization brought its own credential; that assumption breaks as soon as platform compute is accounted for, since a BYOK run still occupies a platform-operated sandbox. A module that only cares about platform-supplied inference reproduces the old outcome by returning `null` when `credentialSource !== "system"`.

An operation the organization supplies entirely by itself — `credentialSource !== "system"` **and** `executionPlane !== "platform"`, i.e. a remote BYOK run — should be short-circuited with `null` before the handler reads any of its own state (no DB round-trip, no account lookup): there is nothing for the platform to account for.

Three seams dispatch it: run preflight (once per run launch), the chat surface (once per turn, subscription turns included), and `/api/llm-proxy` (once per raw proxy call that carries a validated run context — BYOK calls included, carrying `credentialSource: "org"`). The one call that dispatches nothing is a raw BYOK proxy call with **no** run or chat context: `BeforeUsageParams` has no context-less shape to report, and requiring a context there would break headless BYOK API keys. A platform-supplied call with no context is refused outright (400 `usage_context_required`).

## Auth strategies

Modules can contribute custom authentication strategies that run in the request pipeline **before** core auth (Bearer ask\_ API key → session cookie). This is how OIDC/JWT, mTLS, SAML, webhook-HMAC, and similar auth mechanisms plug in without touching `apps/api/src/index.ts`.

A strategy is a plain object implementing `AuthStrategy` from `@appstrate/core/module`. The `@appstrate/core/bearer` subpath used below first ships in core **6.0.0** — on an earlier core, parse the `Authorization` header yourself (same RFC 9110 §11.4 rule as the comment in the example).

```ts
import type { AppstrateModule, AuthStrategy } from "@appstrate/core/module";
import { parseBearer } from "@appstrate/core/bearer"; // core >= 6.0.0

const jwtStrategy: AuthStrategy = {
  id: "my-jwt",
  async authenticate({ headers, method, path }) {
    // Always parse the header with `parseBearer` — never
    // `auth.startsWith("Bearer ")`. RFC 9110 §11.4 makes the auth-scheme a
    // case-insensitive token separated from the credentials by `1*SP`, so a
    // conformant `authorization: bearer ey…` must match too.
    const token = parseBearer(headers.get("authorization"));
    // Fast no-match path — return null immediately for anything not ours
    if (!token?.startsWith("ey")) return null;

    const payload = await verifyJwt(token);
    if (!payload) return null;

    return {
      user: { id: payload.sub, email: payload.email, name: payload.name },
      orgId: payload.org_id,
      orgRole: "admin",
      authMethod: "my-jwt",
      spaceId: payload.space_id,
      permissions: ["runs:read", "runs:write"],
      // Optional end-user impersonation. `EndUserContext` is exactly
      // `{ id, spaceId, name?, email? }` — core has no end-user role
      // vocabulary, so there is no `role` field to set here.
      endUser: {
        id: payload.enduser_id,
        spaceId: payload.space_id,
        email: payload.email,
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

**What a resolution sets on `c`.** Mirrors what core API-key auth sets: `user`, `orgId`, `orgSlug?`, `orgRole`, `authMethod`, `spaceId`, `permissions` (as a string set), optional `endUser`. Downstream middleware treats strategy-authenticated requests the same as API-key requests — org-context and permission-resolution middlewares are skipped because the strategy has already resolved everything.

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

Applications embedding Appstrate headlessly that want an "admin dashboard" view simply don't send `Appstrate-User` on admin calls — a raw API key request has no `endUser` context, so the self-filter doesn't apply and the caller sees every run in the space (which `spaceId` still scopes).

## OpenAPI contributions

Modules that expose HTTP routes should also provide `openApiPaths()` (path items) and, if they use shared response/request shapes, `openApiComponentSchemas()` (component schemas) plus `openApiSchemas()` (Zod → OpenAPI registry entries for request-body validation). The loader merges contributions from every loaded module into the final spec; `scripts/verify-openapi.ts` replays the same merge at check time and flags any mismatch between declared paths and the baseline.

Because discovery is filesystem-based, adding a new endpoint only requires touching the module's own `openapi/` directory — no central list to update.

## Idempotency — in-tree modules can opt in, out-of-tree modules cannot

The platform mounts `idempotencyGuard` (`apps/api/src/middleware/idempotency-guard.ts`) globally, **before** `registerModuleRoutes(app)`. Every mutating route a module registers is therefore subject to it: a request carrying `Idempotency-Key` on an unsafe method (`POST`/`PUT`/`PATCH`/`DELETE`) is refused with `400 idempotency_not_supported` unless the matched route mounts `idempotency()`.

**Built-in dir modules opt in by relative import**, and two already do — `webhooks/routes.ts` (`POST /api/webhooks`) and `oidc/routes.ts` (`POST /api/oauth/clients`) both mount `idempotency()` from `../../middleware/idempotency.ts` and declare `$ref: "#/components/parameters/IdempotencyKey"` on that operation in their own `openapi/paths.ts`. Copy that pair — mount **and** declare — if a built-in route needs de-duplication.

**Out-of-tree modules cannot.** `idempotency()` lives in `apps/api/src/middleware/` and is exported from no package — not `@appstrate/core`, not anywhere an npm module can import (unlike `services.http.rateLimit()`, which the same routes get through `PlatformServices`). So `@appstrate/module-chat`, `@appstrate/module-claude-code`, `@appstrate/module-codex`, `@appstrate/cloud` and any operator-installed module are permanently in "refuse" mode on every mutating route they expose. Nothing breaks today — none of them advertises the header — but the asymmetry is real: they are held to a policy they have no way to satisfy.

Until that changes, for an out-of-tree module:

- **Do not declare an `Idempotency-Key` parameter in your `openApiPaths()`.** It would be a promise the runtime refuses; the drift test (`apps/api/test/integration/middleware/idempotency-contract.test.ts`) matches the parameter by name — inline or `$ref` — and fails on a declaration with no mount. (`openapi/paths/llm-proxy.ts` carried exactly that false promise for three operations.)
- **Do not tell clients to stamp the header on your routes.** They will get a `400`.
- If you genuinely need request de-duplication, implement it in your own handler under your own header/body field, or open an issue: exposing `idempotency()` on `PlatformServices.http` next to `rateLimit()` is the obvious shape, and it is a deliberate core API-surface decision (a `@appstrate/core` minor + module lockstep), not something to work around locally.

Note also that the drift test discovers modules through the test preload (built-ins under `apps/api/src/modules/*` plus workspace `packages/module-*`). An operator-installed out-of-tree module is not in that process and is not checked by it — sound only for as long as such a module has no way to mount `idempotency()`. Exposing the middleware to modules means giving that check a second, module-side home.

## Disabling a module

`MODULES` is comma-separated. Remove the module id (or package specifier) and the platform boots without importing a single byte of its code. `MODULES=none` boots with zero modules (the empty string resolves to the default set — the env getter coalesces empty to unset, per the compose `${VAR:-}` pattern). The module's tables remain in the database (data is preserved), but no queries, routes, hooks, events, permissions, or feature flags are wired up. To drop the tables as well, write a separate migration or run a manual `DROP TABLE`.

This is the "zero footprint" guarantee: the only coupling between core and a module is through the `AppstrateModule` contract. If core ever needs to special-case a specific module id, that is a design failure — use hooks, events, or feature flags instead.
