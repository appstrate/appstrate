# Built-in Modules

Built-in modules extend the Appstrate platform with optional features (webhooks, provider management, …). They follow the same `AppstrateModule` contract as external modules like `@appstrate/cloud`, but live inside the API package so they can share test infrastructure and be discovered automatically.

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
├── drizzle/
│   ├── migrations/
│   │   ├── 0000_initial.sql
│   │   └── meta/_journal.json
└── openapi/
    ├── paths.ts       # OpenAPI path items (merged into the platform spec)
    └── schemas.ts     # Component schemas (merged into components.schemas)
```

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

Everything else (`hooks`, `events`, `openApiComponentSchemas`, `openApiSchemas`, `emailOverrides`, `publicPaths`, `manifest.dependencies`) is optional.

## Database ownership rules

1. Module tables live in `apps/api/src/modules/<id>/schema.ts`. They have their own Drizzle migration tree and a dedicated tracking table `__drizzle_migrations_<id>` (hyphens replaced with underscores).
2. **Backward FKs (module → core)** use Drizzle `.references()` inline in the module schema — for example `orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" })`. Core tables always exist before any module migration runs at boot, so this is safe.
3. **Forward FKs (core → module)** cannot be expressed via Drizzle without leaking the module schema into core. When you need one (example: `runs.schedule_id → package_schedules.id`), add it via raw SQL inside the module's own migration. Core stays agnostic of module tables.
4. Core never imports from `apps/api/src/modules/`. If core code needs data from a module, use a hook (`resolveModel`, `beforeRun`) — never a direct import.

## Permissions

RBAC is a platform capability, not a module concern. Core's `apps/api/src/lib/permissions.ts` is the single typed source of truth for the `Permission` taxonomy — it already lists every resource the built-in modules use (`schedules`, `webhooks`, `models`, `provider-keys`), together with the role-to-permission matrix and the API key allowlist. Module manifests do not declare permissions or scopes.

Inside module routes, protect handlers with the same typed helper core uses: `requirePermission("schedules", "write")` (from `apps/api/src/middleware/require-permission.ts`). TypeScript will reject any resource/action pair that is not in `ResourceActions` — if you need a new resource, add it to `permissions.ts` in the same PR that adds the module. Treat this as part of the platform contract: core ships the vocabulary, modules implement the behavior.

The trade-off is that disabling a module leaves a handful of inert permission strings in the role sets (e.g. `schedules:*` still exists in `OWNER_PERMISSIONS` even when the scheduling module is off). That is harmless metadata — no route reads it, since the routes themselves are not loaded — and it keeps the type system honest for everything that is.

## Hooks and events

- **Hooks** (`callHook`, first-match-wins): `beforeRun`, `beforeSignup`, `resolveModel`. The first module that provides a hook is called, subsequent modules are skipped.
- **Events** (`emitEvent`, broadcast-to-all): `onRunStatusChange`, `onOrgCreate`, `onOrgDelete`. Handlers run for side effects only; errors in one handler are isolated and do not block others.

Names are defined in `packages/core/src/module.ts` (`ModuleHooks`, `ModuleEvents`). To add a new hook or event, update that file first so both platform and modules see the same contract.

## OpenAPI contributions

Modules that expose HTTP routes should also provide `openApiPaths()` (path items) and, if they use shared response/request shapes, `openApiComponentSchemas()` (component schemas) plus `openApiSchemas()` (Zod → OpenAPI registry entries for request-body validation). The loader merges contributions from every loaded module into the final spec; `scripts/verify-openapi.ts` replays the same merge at check time and flags any mismatch between declared paths and the baseline.

Because discovery is filesystem-based, adding a new endpoint only requires touching the module's own `openapi/` directory — no central list to update.

## Disabling a module

`APPSTRATE_MODULES` is comma-separated. Remove the module id (or package specifier) and the platform boots without importing a single byte of its code. The module's tables remain in the database (data is preserved), but no queries, routes, hooks, events, permissions, or feature flags are wired up. To drop the tables as well, write a separate migration or run a manual `DROP TABLE`.

This is the "zero footprint" guarantee: the only coupling between core and a module is through the `AppstrateModule` contract. If core ever needs to special-case a specific module id, that is a design failure — use hooks, events, or feature flags instead.
