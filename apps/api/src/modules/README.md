# Built-in Modules

Built-in modules extend the Appstrate platform with optional features (currently: webhooks). They follow the same `AppstrateModule` contract as external modules like `@appstrate/cloud`, but live inside the API package so they can share test infrastructure and be discovered automatically.

## Auto-discovery

At boot, `apps/api/src/lib/modules/module-loader.ts` scans this directory and registers every subdirectory with an `index.ts` as a candidate built-in module. The module `id` equals the directory name. The loader does not read any hardcoded list — adding a new module is literally dropping a new folder here.

Only modules listed in the `APPSTRATE_MODULES` environment variable are actually initialized. Everything else is inert: no tables, no routes, no workers, no hook handlers.

## Directory layout

```
apps/api/src/modules/<id>/
├── index.ts           # Default-exports an `AppstrateModule`
├── README.md          # Purpose, owned tables, hooks/events, disable behavior
├── schema.ts          # Drizzle tables owned by this module
├── routes.ts          # (or routes/)  Hono router mounted under /api
├── service.ts         # Business logic, workers, lifecycle
├── lib/               # Module-private utilities (cron parser, helpers…)
├── test/              # Pure unit tests for module-internal logic (no DB/HTTP)
├── drizzle/
│   ├── migrations/
│   │   ├── 0000_initial.sql
│   │   └── meta/_journal.json
└── openapi/
    ├── paths.ts       # OpenAPI path items (merged into the platform spec)
    └── schemas.ts     # Component schemas (merged into components.schemas)
```

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
    await ctx.applyMigrations("my-feature", resolve(import.meta.dir, "drizzle/migrations"));
    // start workers, warm caches, etc.
  },

  createRouter() {
    return createMyFeatureRouter(); // Hono<AppEnv>
  },

  /**
   * Route prefixes that require the `X-App-Id` header and go through the
   * app context middleware. Aggregated with core prefixes at boot — core
   * has no hardcoded knowledge of module paths.
   */
  appScopedPaths: ["/api/my-feature"],

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

Everything else (`hooks`, `events`, `openApiComponentSchemas`, `openApiSchemas`, `emailOverrides`, `publicPaths`, `appScopedPaths`, `manifest.dependencies`) is optional. Use `publicPaths` for routes that bypass auth (e.g. inbound webhook callbacks), and `appScopedPaths` for routes that require `X-App-Id`.

## Database ownership rules

1. Module tables live in `apps/api/src/modules/<id>/schema.ts`. They have their own Drizzle migration tree and a dedicated tracking table `__drizzle_migrations_<id>` (hyphens replaced with underscores).
2. **Backward FKs (module → core)** use Drizzle `.references()` inline in the module schema — for example `orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" })`. Core tables always exist before any module migration runs at boot, so this is safe.
3. **Forward FKs (core → module)** cannot be expressed via Drizzle without leaking the module schema into core. When you need one, add it via raw SQL inside the module's own migration. Core stays agnostic of module tables.
4. Core never imports from `apps/api/src/modules/`. If core code needs data from a module, use a hook (`beforeRun`, `afterRun`) — never a direct import.

## Permissions

RBAC is a platform capability, not a module concern. Core's `apps/api/src/lib/permissions.ts` is the single typed source of truth for the `Permission` taxonomy — it already lists every resource the built-in modules use (`webhooks`), together with the role-to-permission matrix and the API key allowlist. Module manifests do not declare permissions or scopes.

Inside module routes, protect handlers with the same typed helper core uses: `requirePermission("webhooks", "write")` (from `apps/api/src/middleware/require-permission.ts`). TypeScript will reject any resource/action pair that is not in `ResourceActions` — if you need a new resource, add it to `permissions.ts` in the same PR that adds the module. Treat this as part of the platform contract: core ships the vocabulary, modules implement the behavior.

The trade-off is that disabling a module leaves a handful of inert permission strings in the role sets (e.g. `webhooks:*` still exists in `OWNER_PERMISSIONS` even when the webhooks module is off). That is harmless metadata — no route reads it, since the routes themselves are not loaded — and it keeps the type system honest for everything that is.

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

`APPSTRATE_MODULES` is comma-separated. Remove the module id (or package specifier) and the platform boots without importing a single byte of its code. The module's tables remain in the database (data is preserved), but no queries, routes, hooks, events, permissions, or feature flags are wired up. To drop the tables as well, write a separate migration or run a manual `DROP TABLE`.

This is the "zero footprint" guarantee: the only coupling between core and a module is through the `AppstrateModule` contract. If core ever needs to special-case a specific module id, that is a design failure — use hooks, events, or feature flags instead.
