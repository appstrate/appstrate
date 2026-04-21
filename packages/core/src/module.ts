// SPDX-License-Identifier: Apache-2.0

/**
 * Appstrate Module System — contract types.
 *
 * Published in @appstrate/core so that external modules can implement
 * the interface without depending on the API package.
 *
 * Hono is the only framework dependency — all Appstrate modules must provide
 * Hono routers. It is declared as an optional peer dependency.
 */

import type { Hono } from "hono";
import type { Logger } from "./logger.ts";
import type { OrgRole } from "./permissions.ts";
import type {
  Actor,
  ContainerOrchestrator,
  InlinePreflightInput,
  InlinePreflightResult,
  InlineRunBody,
  PlatformApplication,
  PlatformConnectionProviderGroup,
  PlatformModel,
  PlatformPackage,
  PubSub,
  RealtimeSubscriber,
  Run,
  RunLog,
} from "./platform-types.ts";

// ---------------------------------------------------------------------------
// Module contract
// ---------------------------------------------------------------------------

/** Metadata describing a module. */
export interface ModuleManifest {
  /** Unique identifier (e.g. "cloud", "oidc"). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Semantic version. */
  version: string;
  /** Module IDs this module depends on (loaded first). */
  dependencies?: string[];
}

/**
 * The contract every Appstrate module must implement.
 *
 * Lifecycle: resolve -> init -> createRouter -> (running) -> shutdown
 */
export interface AppstrateModule {
  manifest: ModuleManifest;

  /**
   * Called once at boot. Must initialize internal state (DB client, migrations, etc.).
   * Any error is treated as a fatal init failure — all declared modules are required.
   */
  init(ctx: ModuleInitContext): Promise<void>;

  /** Paths that bypass auth middleware (e.g. inbound webhook endpoints). */
  publicPaths?: string[];

  /**
   * Route prefixes owned by this module that require the app context middleware
   * (`X-App-Id` header resolution). Aggregated with core prefixes at boot.
   *
   * Only declare prefixes for app-scoped resources. Org-scoped or global
   * routes should be omitted.
   *
   * @example appScopedPaths: ["/api/webhooks"]
   */
  appScopedPaths?: string[];

  /**
   * Create and return a Hono router to be mounted at the HTTP origin root
   * (`/`). The router declares its routes with their **full paths** — the
   * platform does NOT inject an `/api` prefix.
   *
   * Convention: business endpoints MUST live under `/api/*` to stay
   * consistent with core (e.g. `/api/webhooks`, `/api/oauth/clients`).
   * The only paths that legitimately live outside `/api/*` are those
   * whose location is dictated by an external specification — RFC 5785
   * well-known URIs (`/.well-known/openid-configuration`,
   * `/.well-known/oauth-authorization-server`), `robots.txt`, etc.
   *
   * Route paths declared here must match the entries the module lists in
   * `publicPaths` and `appScopedPaths` (which also use full paths). Two
   * modules cannot register the same path — collisions surface as Hono
   * first-match-wins silent shadowing, so authors are responsible for
   * keeping prefixes distinct.
   *
   * Mount order: the platform calls `app.route("/", router)` for each
   * module **before** the SPA static fallback, so module-owned paths take
   * precedence over the SPA catch-all. Modules that return `undefined`
   * contribute nothing — the OSS zero-footprint invariant is preserved.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createRouter?(): Hono<any>;

  /**
   * Return OpenAPI 3.1 path definitions owned by this module.
   * Keys are path strings (e.g. "/api/webhooks"), values are OpenAPI path item objects.
   * Merged into the spec at boot — absent when the module is disabled.
   */
  openApiPaths?(): Record<string, unknown>;

  /**
   * Return OpenAPI 3.1 component schema definitions owned by this module.
   * Keys are schema names (e.g. "WebhookObject"), values are OpenAPI schema objects.
   * Merged into `components.schemas` at boot — absent when the module is disabled.
   */
  openApiComponentSchemas?(): Record<string, unknown>;

  /**
   * Return OpenAPI 3.1 tags owned by this module.
   * Merged into the spec `tags` array at boot — absent when the module is disabled.
   * Keeps core `openApiInfo.tags` free of module-specific entries.
   */
  openApiTags?(): Array<{ name: string; description?: string }>;

  /**
   * Return Zod ↔ OpenAPI schema registry entries owned by this module.
   * Used by verify-openapi to compare Zod request-body schemas against OpenAPI specs.
   */
  openApiSchemas?(): OpenApiSchemaEntry[];

  /**
   * Feature flags contributed by this module.
   * Merged into `AppConfig.features` at boot (simple `Object.assign`).
   * Absent modules contribute nothing — their flags stay at base defaults.
   *
   * @example features: { billing: true }
   */
  features?: Record<string, boolean>;

  /**
   * Custom authentication strategies contributed by this module.
   *
   * Strategies are tried in module load order, BEFORE core auth (Bearer ask_
   * API key → session cookie). The first strategy whose `authenticate()` returns
   * a non-null `AuthResolution` claims the request; subsequent strategies and
   * core auth are skipped.
   *
   * Strategies MUST return `null` fast when the request does not match their
   * signature (e.g. a JWT strategy should return `null` for anything not
   * starting with `Bearer ey...`). A strategy that claims every request would
   * shadow core API key auth — this is author discipline, not a framework
   * guarantee. See `apps/api/src/modules/README.md` for the full contract.
   */
  authStrategies?(): AuthStrategy[];

  /**
   * Plugins to contribute to the Better Auth instance.
   *
   * Returned values are passed through as `unknown[]` at this contract layer
   * to keep Better Auth types out of `@appstrate/core` (which is published on
   * npm). The boot integration site in `packages/db/src/auth.ts` narrows them
   * to Better Auth's `BetterAuthPluginList` before constructing the auth
   * instance.
   *
   * Called once at boot, after `init()`, during `createAuth()`. Modules that
   * want strong typing can import `BetterAuthPluginList` from
   * `@appstrate/db/auth` and annotate their return type.
   */
  betterAuthPlugins?(): unknown[];

  /**
   * Drizzle tables contributed to the Better Auth adapter.
   *
   * Better Auth's Drizzle adapter resolves `findOne({ model: "name" })` calls
   * against a flat `schema` record. When a module's plugins (e.g. the JWT or
   * OAuth provider plugin) operate on module-owned tables, those tables must
   * be registered with the adapter — otherwise the plugin fails with
   * `"Drizzle Adapter: The model X was not found in the schema object."`.
   *
   * Return a flat map whose keys are the camelCase model names Better Auth
   * expects (e.g. `"jwks"`, `"oauthClient"`, `"oauthAccessToken"`) and whose
   * values are the Drizzle table instances from the module's `schema.ts`.
   * The values are typed as `unknown` here to keep `drizzle-orm` out of the
   * published core surface — the boot integration site in
   * `packages/db/src/auth.ts` merges them into the adapter config as-is.
   *
   * Called once at boot, during `createAuth()`, immediately before the
   * Better Auth instance is constructed.
   */
  drizzleSchemas?(): Record<string, unknown>;

  /**
   * Named hooks (first-match-wins).
   * The platform invokes hooks by name — only the first module that provides
   * a given hook is called. For broadcast-to-all semantics, use `events`.
   *
   * Naming: `beforeX` (gates), `afterX` (post-lifecycle patches).
   *
   * Priority order: topological order from `manifest.dependencies`. Modules
   * without dependencies keep the order they appear in `MODULES`.
   *
   * Example: `MODULES=cloud,quota` — if both provide `beforeRun`,
   * cloud runs first. To force ordering, add `dependencies: ["cloud"]` on
   * quota so the topo sort always places cloud earlier.
   */
  hooks?: Partial<ModuleHooks>;

  /**
   * Named event handlers (broadcast-to-all).
   * Unlike hooks, events are emitted to ALL modules that listen for them.
   * Errors in individual handlers are isolated — they don't block other modules.
   *
   * Naming: `onX` (something happened, modules react).
   */
  events?: Partial<ModuleEvents>;

  /**
   * Email template overrides (e.g. branded versions for Cloud).
   * Collected after init and merged into the email registry.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emailOverrides?: Record<string, any>;

  /**
   * Structured data to merge into `AppConfig` at boot.
   *
   * Unlike `features` (boolean flags only), this method can contribute
   * arbitrary structured fields (e.g. `{ oidc: { clientId, issuer } }`).
   * Called once at boot after `init()` — the result is deep-merged into
   * `AppConfig` alongside module features.
   */
  appConfigContribution?(): Promise<Record<string, unknown>> | Record<string, unknown>;

  /**
   * Public API surface exposed to other modules.
   *
   * Read by peers via `services.modules.get(id)?.api`. Typed as `unknown`
   * here so the core contract stays ignorant of any specific module's
   * shape; modules that consume a peer's API import that peer's published
   * typings (or cast at the call site) to recover strong typing.
   *
   * Example: the OIDC module exposes `verifyEndUserAccessToken` so any
   * module accepting OAuth2 Bearer JWTs can re-verify tokens without
   * re-implementing JWKS fetch + caching + signature parsing.
   */
  api?: unknown;

  /**
   * Additional OAuth2 scopes contributed by this module to the OIDC
   * vocabulary. Aggregated by the OIDC module at boot and included in:
   *   1. `.well-known/openid-configuration#scopes_supported`
   *   2. `assertValidScopes` (so operator-registered clients can request them)
   *   3. `GET /api/oauth/scopes`
   *
   * Scopes are NOT translated into core permissions — they remain opaque
   * strings that the contributing module's own middleware enforces by
   * reading the JWT's `scope` claim. Pick stable, namespaced strings
   * (e.g. `tasks:read`, `tasks:write`) that won't collide with other
   * modules' scopes.
   *
   * The `${string}:${string}` template literal is a compile-time guard
   * against single-word scopes (which are reserved for the OIDC identity
   * vocabulary `openid|profile|email|offline_access`). The platform
   * additionally enforces `^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$` at boot
   * — modules with malformed scopes fail-fast with a clear error.
   *
   * **Recommended pattern** — preserve compile-time narrowing inside the
   * contributing module by exporting a typed `as const` tuple alongside
   * the module export:
   *
   * ```ts
   * export const TASKS_SCOPES = ["tasks:read", "tasks:write"] as const;
   * export type TasksScope = (typeof TASKS_SCOPES)[number];
   *
   * const tasksModule: AppstrateModule = {
   *   manifest: { id: "tasks", name: "Tasks", version: "1.0.0" },
   *   oidcScopes: [...TASKS_SCOPES],
   *   // ...
   * };
   * ```
   *
   * Consumers of the module's middleware (or any code reading `jwt.scope`)
   * import `TasksScope` to recover the literal union — typing is lost only
   * at the core boundary, not within the module's own surface.
   *
   * No-op when the OIDC module is absent — declaring scopes on a platform
   * that doesn't load OIDC just goes unused.
   */
  oidcScopes?: ReadonlyArray<`${string}:${string}`>;

  /**
   * RBAC contribution: declare resources owned by this module and how the
   * core org roles grant their actions.
   *
   * Aggregated by the platform at boot and merged into:
   *   1. `resolvePermissions(role)` — adds module entries to the per-role
   *      permission set written to `c.get("permissions")`.
   *   2. `API_KEY_ALLOWED_SCOPES` — module entries become grantable
   *      through API keys (filtered against creator's role at issuance).
   *   3. `requirePermission(resource, action)` — runtime check is purely
   *      Set membership, so module entries gate routes the same way core
   *      permissions do.
   *
   * Pair this with a TypeScript declaration-merging block on
   * `@appstrate/core/permissions#ModuleResources` so call sites
   * like `requirePermission("tasks", "read")` stay typed end-to-end:
   *
   * ```ts
   * declare module "@appstrate/core/permissions" {
   *   interface ModuleResources { tasks: "read" | "write" }
   * }
   *
   * const tasksModule: AppstrateModule = {
   *   manifest: { id: "tasks", name: "Tasks", version: "1.0.0" },
   *   permissionsContribution: () => [
   *     {
   *       resource: "tasks",
   *       actions: ["read", "write"],
   *       grantTo: ["owner", "admin", "member"],
   *       apiKeyGrantable: true,
   *     },
   *   ],
   *   // ...
   * };
   * ```
   *
   * Constraints enforced at boot (fail-fast):
   *   - resource name matches `^[a-z][a-z0-9_-]*$`
   *   - action names match `^[a-z][a-z0-9_-]*$`
   *   - resource does NOT collide with any core resource (org, agents, …)
   *     or any other module's resource
   *
   * No-op on platforms that don't load this module — neither the type
   * augmentation nor the runtime grants reach core, preserving the
   * zero-footprint invariant.
   */
  permissionsContribution?(): ModulePermissionContribution[];

  /** Called during graceful shutdown (reverse init order). */
  shutdown?(): Promise<void>;
}

/**
 * One resource's RBAC contribution from a module — declares the actions
 * available, which org roles grant them, and whether they can be issued
 * through API keys. See `AppstrateModule.permissionsContribution`.
 */
export interface ModulePermissionContribution {
  /** Resource name (e.g. "tasks"). Must be unique across loaded modules and disjoint from core resources. */
  resource: string;
  /** Actions the module supports for this resource (e.g. ["read", "write"]). */
  actions: readonly string[];
  /**
   * Org roles that grant every listed action. The platform writes the
   * union into `resolvePermissions(role)`. Omit a role to leave it
   * without access (e.g. `viewer` typically only sees `:read`).
   *
   * Granular per-action grants (e.g. owner gets write, member gets read
   * only) are supported by listing the resource multiple times with
   * different `actions`/`grantTo` combinations.
   */
  grantTo: ReadonlyArray<OrgRole>;
  /**
   * When `true`, every `<resource>:<action>` produced by this entry is
   * added to the API-key allowlist so org admins can mint keys with
   * these scopes. Defaults to `false` — module permissions are
   * session-only unless explicitly opted in.
   */
  apiKeyGrantable?: boolean;
  /**
   * When `true`, every `<resource>:<action>` produced by this entry can be
   * carried by an end-user OAuth2/OIDC token (the embedding-app flow). The
   * platform's OIDC strategy filters end-user JWT scopes against this
   * allowlist before writing them to `c.get("permissions")` — without the
   * opt-in, a module's resource is unreachable through end-user tokens
   * even if the JWT advertises it.
   *
   * Defaults to `false` — module permissions are dashboard/instance/API-key
   * only unless explicitly opted in. Use this for modules whose data is
   * meant to be addressed per-end-user (per-user data streams, end-user
   * profiles, notifications…). Avoid for admin/destructive surfaces (those should
   * stay session-only or API-key-only).
   *
   * No-op on platforms that don't load the OIDC module — the flag is
   * simply ignored when no end-user pipeline exists.
   */
  endUserGrantable?: boolean;
}

// ---------------------------------------------------------------------------
// Hook & event type maps — the typed contract
//
// Naming conventions:
//   Hooks (first-match-wins):  beforeX, afterX
//   Events (broadcast-to-all): onX
// ---------------------------------------------------------------------------

/**
 * Context passed alongside the `beforeSignup` hook's `email` argument. The
 * second argument is optional for backward compatibility: existing modules
 * that declare `async (email) => {...}` continue to work unchanged
 * (JavaScript silently drops extra arguments).
 *
 * Modules that need to read request-scoped state (e.g. a signed cookie
 * pinning an OAuth client for the in-flight signup) should read from
 * `ctx.headers`. The headers are `null` when BA creates the user outside
 * an HTTP context (seeds, admin scripts).
 */
export interface BeforeSignupContext {
  headers: Headers | null;
}

/**
 * Context passed to the `afterSignup` hook. Includes the committed BA user
 * id so modules can attach the user to their own tables (e.g. OIDC
 * auto-joining the user to an org based on the in-flight OAuth client).
 */
export interface AfterSignupContext {
  headers: Headers | null;
}

/** Known hooks and their signatures. */
export interface ModuleHooks {
  /** Pre-run gate — return a rejection to block the run, or null/undefined to allow. */
  beforeRun: (params: BeforeRunParams) => Promise<RunRejection | null>;
  /**
   * Pre-signup gate — throw to reject signup (e.g. domain allowlist,
   * free-tier quota, per-client org-signup policy).
   *
   * Unlike other hooks in this map, `beforeSignup` is dispatched to EVERY
   * loaded module rather than first-match-wins (the platform calls all
   * handlers in turn; any thrown error aborts the signup). This lets
   * unrelated modules — e.g. cloud billing + OIDC auto-provisioning —
   * coexist cleanly.
   */
  beforeSignup: (email: string, ctx?: BeforeSignupContext) => Promise<void>;
  /**
   * Post-signup side effect — runs after the BA user row is committed with
   * the freshly minted `user.id`. Symmetric with `beforeSignup`: dispatched
   * to EVERY loaded module. Used by OIDC to auto-join the new user to the
   * org pinned by the in-flight OAuth client so the subsequent /authorize
   * redirect lands on the client's callback instead of the dashboard
   * onboarding flow.
   */
  afterSignup: (user: { id: string; email: string }, ctx?: AfterSignupContext) => Promise<void>;
  /**
   * Post-run hook — called on terminal status before the final run record is
   * persisted. Symmetric with `beforeRun`. Modules return a metadata patch
   * stored as `runs.metadata` (e.g. `{ creditsUsed }` from cloud billing), or
   * null to leave it untouched.
   */
  afterRun: (params: RunStatusChangeParams) => Promise<Record<string, unknown> | null>;
}

/** Known events and their signatures. Handlers may be sync or async. */
export interface ModuleEvents {
  /** Run status changed — broadcast on every run lifecycle transition. */
  onRunStatusChange: (params: RunStatusChangeParams) => void | Promise<void>;
  /** Org created — broadcast after a new organization is created. */
  onOrgCreate: (orgId: string, userEmail: string) => void | Promise<void>;
  /** Org deleted — broadcast before an organization is deleted. */
  onOrgDelete: (orgId: string) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// OpenAPI contribution types
// ---------------------------------------------------------------------------

/** Entry for the Zod ↔ OpenAPI schema registry (used by verify-openapi). */
export interface OpenApiSchemaEntry {
  /** HTTP method (uppercase, e.g. "POST"). */
  method: string;
  /** OpenAPI path (e.g. "/api/webhooks"). */
  path: string;
  /** Zod schema converted to JSON Schema via z.toJSONSchema(). */
  jsonSchema: Record<string, unknown>;
  /** Human-readable description for reporting. */
  description: string;
}

// ---------------------------------------------------------------------------
// Auth strategy contribution types
//
// Generic framework-agnostic interface. OIDC/JWT, mTLS, SAML, webhook-HMAC,
// etc. all implement the same `AuthStrategy` shape. Naming intentionally
// avoids OIDC vocabulary — this is a general auth-pipeline extension point.
// ---------------------------------------------------------------------------

/** Request context passed to an `AuthStrategy.authenticate()` call. */
export interface AuthStrategyRequest {
  /** Raw request headers (direct ref to `c.req.raw.headers`). */
  headers: Headers;
  /** HTTP method (uppercase, e.g. "POST"). */
  method: string;
  /** Request path (e.g. "/api/runs"). */
  path: string;
}

/**
 * Resolution returned by a successful `AuthStrategy.authenticate()` call.
 * Mirrors the shape the core auth middleware sets on `c` via `c.set(...)`.
 *
 * `permissions` is `readonly string[]` (not the typed `Permission` union) to
 * avoid dragging the RBAC permission catalog into `@appstrate/core`. At
 * request time, `requirePermission(resource, action)` validates membership;
 * invalid strings from a strategy surface as a 403 at the guard site.
 */
export interface AuthResolution {
  user: { id: string; email: string; name: string };
  orgId?: string;
  orgSlug?: string;
  orgRole?: OrgRole;
  /**
   * Strategy-chosen identifier for this auth method (e.g. "oidc", "mtls",
   * "webhook-hmac"). Written to `c.set("authMethod", ...)`. NOT constrained
   * to the core values `"session" | "api_key"`.
   */
  authMethod: string;
  /**
   * Optional application binding. End-user strategies (API-key impersonation,
   * OIDC end_user flow) pin this so core's strict end-user filter has the
   * owning app in context. Dashboard strategies (OIDC dashboard flow) leave
   * it undefined — app context is then supplied per-request via the
   * `X-App-Id` header handled by `requireAppContext()`.
   */
  applicationId?: string;
  /** Permission strings already resolved by the strategy. */
  permissions: readonly string[];
  /** Optional end-user impersonation context (mirrors `c.get("endUser")`). */
  endUser?: EndUserContext;
  /** Strategy-specific metadata to attach via `c.set` under `extra` namespace. */
  extra?: Record<string, unknown>;
  /**
   * When true, the auth pipeline defers org resolution to the `X-Org-Id`
   * middleware (same path as session auth) and derives permissions from
   * `orgRole` after org-context resolves. Strategies that authenticate a
   * platform user without binding to a specific org at token-verification
   * time should set this to `true`.
   */
  deferOrgResolution?: boolean;
}

/**
 * End-user impersonation context. Set on the Hono request context under
 * `endUser` by auth strategies that resolve an end-user (cookie auth with
 * `Appstrate-User` header, OIDC JWT, etc.). Consumed by core routes that
 * filter runs to the end-user's own data.
 */
export interface EndUserContext {
  id: string;
  applicationId: string;
  name?: string;
  email?: string;
}

/**
 * A custom authentication strategy. Implementations parse request headers
 * (JWT, mTLS cert, HMAC sig, …), resolve the caller, and return an
 * `AuthResolution`.
 *
 * Discipline: return `null` as early as possible when the request is clearly
 * not for this strategy. A strategy that claims `true` on every request would
 * shadow core API-key auth — authors are responsible for fast no-match paths.
 */
export interface AuthStrategy {
  /** Stable id for logging / telemetry (e.g. "oidc-jwt", "mtls"). */
  id: string;
  /**
   * Attempt to authenticate a request. Return `AuthResolution` to claim the
   * request, `null` to pass to the next strategy / core auth. Throwing is
   * allowed for hard auth errors (e.g. malformed JWT) and will surface as a
   * 500 unless the strategy wraps it in an `ApiError`.
   */
  authenticate(req: AuthStrategyRequest): Promise<AuthResolution | null>;
}

// ---------------------------------------------------------------------------
// Lifecycle types — shared between platform and modules
// ---------------------------------------------------------------------------

/** Parameters passed to the `beforeRun` hook. */
export interface BeforeRunParams {
  orgId: string;
  packageId: string;
  runningCount: number;
}

/** Structured rejection returned by `beforeRun` when a module blocks a run. */
export interface RunRejection {
  code: string;
  message: string;
  /** HTTP status hint (e.g. 402 for payment required, 429 for rate limit). Defaults to 403. */
  status?: number;
}

/** Parameters passed to the `onRunStatusChange` event. */
export interface RunStatusChangeParams {
  orgId: string;
  runId: string;
  packageId: string;
  applicationId: string;
  status: "started" | "success" | "failed" | "timeout" | "cancelled";
  /** Cost in dollars (only on terminal status). */
  cost?: number;
  /** Duration in ms (only on terminal status). */
  duration?: number;
  /** Model source: "system" or "org" (only on terminal status). */
  modelSource?: string | null;
  /**
   * Whether the underlying `packages` row is a shadow package (inline run).
   * Omitted for classic runs (treat as false). Consumers — e.g. the
   * webhooks module — surface this to subscribers so downstream systems
   * can distinguish inline vs cataloged executions without an extra DB
   * round-trip.
   */
  packageEphemeral?: boolean;
  /** Additional data for webhook payloads (result, error, etc.). */
  extra?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Init context — platform services injected into modules
// ---------------------------------------------------------------------------

export interface ModuleInitContext {
  /** PostgreSQL connection string, or null in PGlite mode. */
  databaseUrl: string | null;
  /** Redis connection string, or null when Redis is absent. */
  redisUrl: string | null;
  /** Public-facing URL of the platform (for OAuth callbacks, etc.). */
  appUrl: string;
  /** Whether running in embedded DB mode (PGlite). */
  isEmbeddedDb: boolean;
  /**
   * Apply Drizzle migrations for a module.
   * Handles both PostgreSQL and PGlite. Each module gets its own migration
   * tracking table (`__drizzle_migrations_<moduleId>`), with hyphens in
   * `moduleId` replaced by underscores so the identifier is a valid SQL name
   * (e.g. `my-module` → `__drizzle_migrations_my_module`).
   *
   * @param moduleId - Module identifier (e.g. "webhooks", "cloud")
   * @param migrationsDir - Absolute path to the module's migrations directory
   * @param opts.requireCoreTables - Optional list of core table names that MUST
   *   exist before the module migration runs. Modules that use backward FK
   *   references should declare them here so a broken boot order fails loudly.
   */
  applyMigrations: (
    moduleId: string,
    migrationsDir: string,
    opts?: { requireCoreTables?: readonly string[] },
  ) => Promise<void>;
  /** Lazy email sender (breaks circular deps at module load time). */
  getSendMail: () => Promise<(to: string, subject: string, html: string) => void>;
  /** Query helper: get org admin emails. */
  getOrgAdminEmails: (orgId: string) => Promise<string[]>;
  /**
   * Typed platform capabilities injected at init. Modules capture this
   * reference and consume services through it without importing
   * apps/api internals.
   *
   * DTO payloads expose stable public fields (id, source, name, …) with an
   * open index signature so apps/api rows remain assignable without casts
   * while modules get meaningful types for the fields they care about.
   *
   * ## Security
   *
   * `services` grants modules privileged access to the platform — they can
   * abort runs, emit events, subscribe to the realtime bus, talk to the
   * container orchestrator, and read/write run state across orgs. Modules
   * are therefore trusted code on par with `apps/api` itself. Only load
   * modules you control or have audited — never treat `MODULES=` as a
   * safe extension point for untrusted packages.
   */
  services: PlatformServices;
}

// ---------------------------------------------------------------------------
// PlatformServices — injected platform capabilities
//
// Namespaced sub-objects for discoverability. Keep the surface minimal —
// only capabilities with stable cross-module demand belong here. Signatures
// fix arity, argument names, and return cardinality (object vs array vs
// void). DTO payloads use minimal public shapes from `platform-types.ts`
// (PlatformPackage, PlatformModel, PlatformApplication, …) — concrete
// apps/api rows remain assignable thanks to their open index signature.
// ---------------------------------------------------------------------------

/** Updates accepted by `runs.update`. Open shape — future fields OK. */
export interface RunUpdate {
  status?: string;
  result?: Record<string, unknown>;
  state?: Record<string, unknown>;
  error?: string;
  [key: string]: unknown;
}

/** Log level accepted by `runs.appendLog`. */
export type RunLogLevel = "debug" | "info" | "warn" | "error";

export interface PlatformServices {
  /** Structured JSON logger (pino). */
  logger: Logger;
  /** Container orchestrator singleton accessor. Synchronous — instance is cached. */
  orchestrator: { get(): ContainerOrchestrator };
  /** Pub/Sub adapter accessor. Always async — Redis impl loads lazily. */
  pubsub: { get(): Promise<PubSub> };
  /** Tier/mode detection — surfaces which optional infrastructure is present. */
  env: {
    hasRedis(): boolean;
    hasExternalDb(): boolean;
  };
  /** Org-scoped model catalog operations. */
  models: {
    load(orgId: string, modelDbId: string): Promise<PlatformModel | null>;
    listForOrg(orgId: string): Promise<PlatformModel[]>;
  };
  /** Package catalog accessors. */
  packages: {
    get(
      packageId: string,
      orgId: string,
      opts?: { includeEphemeral?: boolean },
    ): Promise<PlatformPackage | null>;
    isInlineShadow(packageId: string): boolean;
    /**
     * Free-text search across the org catalog (system packages + the
     * caller's org). Matches `id` and manifest fields (`name`,
     * `displayName`, `description`) via case-insensitive substring.
     * Ephemeral shadow rows are excluded. Callers requesting `limit`
     * results should pass `limit + 1` to derive `hasMore` without a
     * separate count — the service caps the returned rows at `limit`.
     */
    search(args: {
      query: string;
      orgId: string;
      kind: "agent" | "skill" | "tool" | "provider";
      limit?: number;
    }): Promise<PlatformPackage[]>;
  };
  /** Application helpers. */
  applications: {
    getDefault(orgId: string): Promise<PlatformApplication | null>;
  };
  /** Connection manager helpers. */
  connections: {
    /** Returns `{ providers: [...] }` — not a bare array. */
    listAllForActor(actor: Actor): Promise<{ providers: PlatformConnectionProviderGroup[] }>;
  };
  /**
   * Run lifecycle operations (append log, update, abort).
   *
   * `appendLog` / `update` take a single args object so future fields are
   * non-breaking and the three id parameters (`runId` / `orgId` /
   * `applicationId`) cannot be silently swapped at the call site.
   */
  runs: {
    /**
     * Org-scoped run snapshot read. Returns `null` on a cross-org id or
     * a nonexistent run — 404 semantics without existence leak.
     */
    get(args: { runId: string; orgId: string }): Promise<Run | null>;
    /**
     * Log tail for a run, org-scoped. `order: "asc"` (default) is
     * chronological insertion order (`id ASC`); `"desc"` returns the
     * most recent entries first for tailing use cases.
     */
    listLogs(args: {
      runId: string;
      orgId: string;
      limit?: number;
      order?: "asc" | "desc";
    }): Promise<RunLog[]>;
    /** Returns the inserted log row id. */
    appendLog(args: {
      runId: string;
      orgId: string;
      type: string;
      event?: string | null;
      message?: string | null;
      data?: Record<string, unknown> | null;
      level?: RunLogLevel;
    }): Promise<number>;
    update(args: {
      runId: string;
      orgId: string;
      applicationId: string;
      updates: RunUpdate;
    }): Promise<void>;
    abort(runId: string): void;
  };
  /**
   * Inline run lifecycle — preflight (validate without side effects) and
   * `run` (preflight + insert shadow package + fire pipeline). `run` mirrors
   * what `POST /api/runs/inline` does server-side; modules that schedule
   * one-shot agent executions (slash commands, webhooks, module-owned cron)
   * call it directly without duplicating the shadow-insert + pipeline dance.
   */
  inline: {
    preflight(params: InlinePreflightInput): Promise<InlinePreflightResult>;
    /**
     * Trigger an inline agent run end-to-end. Returns once the pipeline
     * has accepted the run; the client streams progress via the existing
     * realtime SSE endpoint.
     *
     * Throws on validation / pipeline failures (same shape `POST /api/runs/inline`
     * surfaces as a `problem+json` body).
     */
    run(params: {
      orgId: string;
      applicationId: string;
      actor: Actor | null;
      body: InlineRunBody;
      apiKeyId?: string;
    }): Promise<{ runId: string; packageId: string }>;
  };
  /** Realtime SSE subscriber registry. */
  realtime: {
    addSubscriber(sub: RealtimeSubscriber): void;
    removeSubscriber(id: string): void;
  };
  /** Module registry accessors (for cross-module lookups and event emission). */
  modules: {
    get(id: string): AppstrateModule | null;
    emit<K extends keyof ModuleEvents>(
      event: K,
      ...args: Parameters<ModuleEvents[K]>
    ): Promise<void>;
  };
}
