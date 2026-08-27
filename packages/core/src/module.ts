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

import { z } from "zod";
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { ValidationFieldError } from "./api-errors.ts";
import type { Logger } from "./logger.ts";
import type { ModuleResource, ModuleResources, OrgRole } from "./permissions.ts";
import type { ModelApiShape } from "./sidecar-types.ts";
import type {
  ChatAttachmentRequest,
  ChatUsageRecord,
  ResolvedChatAttachment,
  SubscriptionChatResolution,
} from "./chat-contract.ts";
import type { OrchestratorRegistration } from "./platform-types.ts";
import type { ModelGenerationCapabilitiesOverride } from "./model-generation.ts";

// ---------------------------------------------------------------------------
// Module contract
// ---------------------------------------------------------------------------

/**
 * The `@appstrate/core` version this build ships — the platform half of the
 * module contract, exported so the loader can compare it against the
 * `@appstrate/core` range a module declares in its own `package.json`.
 *
 * Hardcoded rather than read from `package.json`: core is consumed over npm by
 * external repos where an ESM JSON import is a portability hazard (import
 * attributes, bundler support). `packages/core/test/core-version.test.ts`
 * asserts it equals the published `version` field, so it cannot drift.
 */
export const CORE_VERSION = "6.2.0";

/** Metadata describing a module. */
export interface ModuleManifest {
  /** Unique identifier (e.g. "webhooks", "oidc"). */
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
   * `publicPaths` (which also use full paths). Two modules cannot register
   * the same path — collisions surface as Hono first-match-wins silent
   * shadowing, so authors are responsible for keeping prefixes distinct.
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
   * Declare which of this module's own component schemas have no shared-type
   * twin, keyed by schema name with the reason as value.
   *
   * `verify-openapi` step 7b is fail-closed: every component schema in the spec
   * must either be registered against a shared-type or be explicitly exempt with
   * a justification. Without this hook a module's schemas can only be exempted
   * from the CORE registry (`apps/api/src/openapi/response-type-registry.ts`),
   * so contributing a module-owned wire schema means editing a core file — the
   * one thing the module contract exists to avoid.
   *
   * Only names this module also contributes via {@link openApiComponentSchemas}
   * belong here: an entry naming a schema absent from the built spec is reported
   * as stale, exactly like a stale core entry.
   *
   * @example openApiExemptSchemas: () => ({ WidgetObject: "admin wire; SPA uses the generated spec type" })
   */
  openApiExemptSchemas?(): Record<string, string>;

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
   * @example features: { metering: true }
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
   * signature (e.g. a JWT strategy should return `null` for any bearer token
   * not starting with `ey...`). Parse the header with an RFC 9110 §11.4
   * conformant parser — never `startsWith("Bearer ")`, which rejects the
   * case-insensitive auth-scheme the RFC mandates. `parseBearer` from
   * `@appstrate/core/bearer` does this, but the subpath first ships in core
   * **6.0.0**; on an earlier core, parse the header yourself. A strategy that
   * claims every request would
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
   * Named hooks. Each hook name has ONE dispatch mode, fixed by which half of
   * the contract declares it:
   *
   *   - {@link FirstMatchHooks} — only the first module providing the hook is
   *     called; its answer is authoritative.
   *   - {@link BroadcastHooks} — every module providing the hook is called and
   *     a throwing handler aborts the operation.
   *
   * Unlike `events`, a hook returns a value and/or gates the operation.
   *
   * Naming: `beforeX` (gates), `afterX` (post-lifecycle side effects).
   *
   * Priority order: topological order from `manifest.dependencies`. Modules
   * without dependencies keep the order they appear in `MODULES`.
   *
   * Example: `MODULES=admission,metering` — if both provide `beforeUsage`
   * (first-match-wins), `admission` runs first and `metering` is never
   * consulted. To force ordering, add `dependencies: ["admission"]` on
   * `metering` so the topo sort always places `admission` earlier.
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
   * Email template overrides (e.g. an operator's own branded versions).
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

  /**
   * Model providers contributed by this module.
   *
   * Each `ModelProviderDefinition` pins identity, wire format, auth metadata,
   * and selectable models for one LLM provider (OAuth-subscription or API-key).
   * The platform's runtime registry aggregates contributions from every loaded
   * module — disabling a module removes its providers without any other
   * code change.
   *
   * Provider-specific behaviors (header injection, token-derived identity,
   * post-refresh enrichment) belong on the definition's `hooks` field
   * rather than the global `ModuleHooks` map: the platform dispatches by
   * `providerId`, not by hook name, so a module's hook only runs for its
   * own providers.
   *
   * Called once at boot, immediately after `init(ctx)`. Adding a provider
   * later (e.g. on credential creation) is not supported — providers are
   * declarative.
   *
   * @example
   * ```ts
   * modelProviders: () => [{
   *   providerId: "my-oauth-provider",
   *   displayName: "My OAuth Provider",
   *   apiShape: "openai-completions",
   *   authMode: "oauth2",
   *   oauth: { clientId: "...", ... },
   *   featuredModels: [...],
   *   hooks: { extractTokenIdentity: (jwt) => ({ accountId: "...", email: "..." }) },
   * }]
   * ```
   */
  modelProviders?(): readonly ModelProviderDefinition[];

  /**
   * Execution backends (run orchestrators) contributed by this module,
   * keyed by `RUN_ADAPTER` value.
   *
   * Collected once at load time, before any orchestrator is instantiated.
   * Two modules (or a module and core) declaring the same id is a fatal
   * boot error — the second registration would silently shadow the first
   * at `RUN_ADAPTER` resolution time.
   *
   * Security note: the registration's `isolatesWorkloads` capability is
   * trusted as declared. A module listed in `MODULES` is operator-installed
   * code running in the API process — the declaration carries the same
   * trust as the platform's own backends. Unknown/unregistered ids always
   * degrade to "no capability" (fail-closed).
   *
   * @example
   * ```ts
   * orchestrators: () => ({
   *   firecracker: {
   *     isolatesWorkloads: true,
   *     supportsSidecarOnly: false,
   *     create: () => new FirecrackerOrchestrator(),
   *   },
   * })
   * ```
   */
  orchestrators?(): Record<string, OrchestratorRegistration>;

  /** Called during graceful shutdown (reverse init order). */
  shutdown?(): Promise<void>;
}

/**
 * One resource's RBAC contribution from a module — declares the actions
 * available, which org roles grant them, and whether they can be issued
 * through API keys. See `AppstrateModule.permissionsContribution`.
 *
 * Distributes over {@link ModuleResources}: the `resource` literal PINS the
 * legal `actions` for that entry, so the runtime contribution can no longer
 * drift from the compile-time `declare module` augmentation that guards the
 * call sites. When both halves were plain `string`, a typo (`"taks"`, or an
 * action the augmentation never declared) produced a permission that type-
 * checked at the guard — `requireModulePermission("tasks", "read")` reads the
 * augmentation — yet was never granted at boot, because the contribution wrote
 * `taks:read` into the role set. The result was a permanent 403 with nothing
 * failing anywhere; consumers documented the invariant by hand instead.
 *
 * A module that contributes permissions MUST therefore ship the `declare
 * module` block: without it `ModuleResources` stays empty, this type resolves
 * to `never`, and `permissionsContribution()` cannot return anything.
 */
export type ModulePermissionContribution = {
  [R in Extract<ModuleResource, string>]: {
    /**
     * Resource name (e.g. "tasks") — a key of the module's `ModuleResources`
     * augmentation. Must be unique across loaded modules and disjoint from
     * core resources (both enforced at boot).
     */
    resource: R;
    /**
     * Actions to grant for this resource, narrowed to those the augmentation
     * declares for `R` (e.g. `["read", "write"]`).
     */
    actions: readonly Extract<ModuleResources[R], string>[];
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
  };
}[Extract<ModuleResource, string>];

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

/**
 * Hooks dispatched FIRST-MATCH-WINS: the platform calls the first loaded
 * module that provides one and never consults the rest, so the first module's
 * verdict is authoritative.
 *
 * A hook belongs here iff exactly one answer is wanted. A gate that several
 * modules may legitimately want to veto belongs in {@link BroadcastHooks} —
 * first-match-wins would silently disable every implementer but one.
 */
export interface FirstMatchHooks {
  /**
   * Pre-usage admission gate — called before an org spends metered LLM usage on
   * a given surface (an agent run or a chat turn). Return a rejection to block
   * the usage, or null/undefined to allow. The {@link BeforeUsageParams} context
   * discriminates run vs. chat so a module can apply per-surface policy.
   *
   * First-match-wins is deliberate: the admission answer is a single verdict
   * (`UsageRejection | null`) the caller turns into one HTTP status. Two modules
   * answering would need a merge rule the contract does not define. Core cannot
   * host the decision itself — the policy lives in the metering module's own
   * database.
   */
  beforeUsage: (params: BeforeUsageParams) => Promise<UsageRejection | null>;
}

/**
 * Hooks BROADCAST to EVERY loaded module, in load order, with errors
 * PROPAGATING (unlike {@link ModuleEvents}, where a throwing handler is
 * isolated and logged): the first handler that throws aborts the operation.
 *
 * A hook belongs here iff every module's verdict must be honoured. These are
 * the gates where first-match-wins would be a security regression — the second
 * and later implementers would be silently skipped.
 */
export interface BroadcastHooks {
  /**
   * Pre-signup gate — throw to reject signup (e.g. domain allowlist,
   * usage limits, per-client org-signup policy).
   *
   * Broadcast, not first-match-wins: unrelated modules — e.g. a metering
   * module's free-tier gate + OIDC's per-client signup policy — must both get
   * to refuse. Any thrown error aborts the signup. It is a hook rather than an
   * event because Better Auth creates the user BELOW the module layer, so
   * `packages/db` cannot import a module to ask.
   */
  beforeSignup: (email: string, ctx: BeforeSignupContext) => Promise<void>;
  /**
   * Post-signup side effect — runs after the BA user row is committed with
   * the freshly minted `user.id`. Symmetric with `beforeSignup`: broadcast to
   * EVERY loaded module. Used by OIDC to auto-join the new user to the
   * org pinned by the in-flight OAuth client so the subsequent /authorize
   * redirect lands on the client's callback instead of the dashboard
   * onboarding flow.
   */
  afterSignup: (user: { id: string; email: string }, ctx: AfterSignupContext) => Promise<void>;
}

/**
 * Every known hook, both dispatch modes — what a module declares under
 * `AppstrateModule.hooks`. The dispatch mode of each name is fixed by which
 * of {@link FirstMatchHooks} / {@link BroadcastHooks} declares it, and the
 * platform's two dispatchers accept only their own half.
 */
export interface ModuleHooks extends FirstMatchHooks, BroadcastHooks {}

/** Known events and their signatures. Handlers may be sync or async. */
export interface ModuleEvents {
  /**
   * Run status changed — broadcast on every run lifecycle transition. The run
   * pipeline cannot import a module, and core must not know who reacts
   * (webhooks today, an analytics or notification module tomorrow).
   */
  onRunStatusChange: (params: RunStatusChangeParams) => void | Promise<void>;
  /**
   * Run kickoff was blocked because one or more integration connections were
   * missing or under-scoped — broadcast when `validateAgentReadiness` returns
   * integration field errors. No run row exists yet at this point; the payload
   * carries the would-be kickoff context (agent, actor) plus the field-level
   * errors that triggered the block. Useful for surfacing under-provisioned
   * agents to downstream dashboards without polling for 4xx responses.
   */
  onRunConnectionMissing: (params: RunConnectionMissingParams) => void | Promise<void>;
  /** Org created — broadcast after a new organization is created. */
  onOrgCreate: (orgId: string, userEmail: string) => void | Promise<void>;
  /**
   * Org deleted — broadcast BEFORE an organization is deleted, and awaited
   * ahead of the cascade so a listener can still read the org's rows.
   */
  onOrgDelete: (orgId: string) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Model provider contribution types
//
// A `ModelProviderDefinition` describes a single LLM provider Appstrate
// knows how to talk to. Modules contribute providers via
// `AppstrateModule.modelProviders()`; the platform aggregates them into a
// runtime registry consulted by the LLM proxy, OAuth flow, token resolver,
// and refresh worker.
//
// Behavior that varies per provider but stays declarative (apiShape,
// forceStream, base URL, OAuth endpoints, model catalog, sidecar wire-
// format quirks) lives in the definition itself. Behavior that requires
// arbitrary code (JWT decoding, post-refresh enrichment, inference
// probe construction) lives in `hooks`, which the platform dispatches
// per provider definition rather than by hook name.
// ---------------------------------------------------------------------------

/** Per-1M-token cost (USD). All cache fields optional — providers may omit pricing. */
export interface ModelCost {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cache-read tokens (Anthropic-style prompt caching). */
  cacheRead?: number;
  /** USD per 1M cache-write tokens (Anthropic-style prompt caching). */
  cacheWrite?: number;
}

/**
 * Zod validator for {@link ModelCost}. `cacheRead` / `cacheWrite` are optional —
 * providers without prompt caching simply omit them.
 */
export const modelCostSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative().optional(),
  cacheWrite: z.number().nonnegative().optional(),
});

/** OAuth2 endpoints + client config for OAuth-authenticated providers. */
export interface ModelProviderOAuthConfig {
  /** Public OAuth client_id — typically shared with the provider's official CLI. */
  clientId: string;
  /** /authorize endpoint. */
  authorizationUrl: string;
  /** Token exchange endpoint. */
  tokenUrl: string;
  /** Token refresh endpoint (often equal to tokenUrl). */
  refreshUrl: string;
  /** Scopes requested at /authorize. */
  scopes: readonly string[];
  /** PKCE code challenge method. All current providers require S256. */
  pkce: "S256";
}

/**
 * Well-known identity slots a provider may surface from an OAuth access
 * token. Modules map their provider-specific claim names into these
 * abstract slots, so the platform never needs to know any provider's
 * internal claim vocabulary.
 *
 * `accountId` is the stable account/tenant identifier the provider uses
 * for routing — persisted on the credential row and used at connect time
 * for required-claim validation; the platform never forwards it as an
 * upstream header (Pi's SDK derives any routing header from the token
 * itself). `email` is the user identity associated with the credential.
 */
export interface ModelProviderIdentity {
  accountId?: string;
  email?: string;
}

/**
 * Context passed to {@link ModelProviderHooks.validateCredential}. The
 * platform supplies the decrypted credential material it already holds —
 * the module validates it OFFLINE (no network), so the platform never
 * issues a subscription API call to test a token.
 */
export interface CredentialValidationContext {
  /** OAuth access token or API key the credential carries. */
  apiKey: string;
  /** Abstract account/tenant id surfaced by `extractTokenIdentity`, when present. */
  accountId?: string;
  /** Token expiry in epoch ms, when known (`null`/unset = unknown). */
  expiresAt?: number | null;
}

/**
 * Pure-data result of an OFFLINE credential validation. Returned by
 * {@link ModelProviderHooks.validateCredential}. `ok: true` means the
 * credential is structurally valid and unexpired; `ok: false` carries a
 * stable error code + message the platform surfaces as a `TestResult`
 * (latency 0 — no request was made). Defined in core (not shared-types)
 * to keep the module contract dependency-free.
 */
export type CredentialValidationResult =
  { ok: true } | { ok: false; error: string; message: string };

/**
 * Shared OFFLINE expiry gate for subscription-credential `validateCredential`
 * hooks. Rejects when no expiry source is known (a dead token with no expiry
 * metadata must not pass) and when the expiry is in the past. The caller owns
 * the provider-specific pre-conditions (bearer well-formedness, required JWT
 * claims) and resolves `expiresAtMs` from whatever sources it trusts (the
 * credential row's `expiresAt`, a token `exp` claim, …); this helper carries
 * only the expiry rule + its stable error code/messages so the two
 * subscription modules can't drift on wording or behavior.
 */
export function validateOfflineExpiry(
  expiresAtMs: number | null | undefined,
): CredentialValidationResult {
  if (expiresAtMs === undefined || expiresAtMs === null) {
    return {
      ok: false,
      error: "AUTH_FAILED",
      message: "credential expiry could not be verified",
    };
  }
  if (expiresAtMs <= Date.now()) {
    return {
      ok: false,
      error: "AUTH_FAILED",
      message: "subscription token has expired — reconnect the subscription",
    };
  }
  return { ok: true };
}

/**
 * Provider-scoped hooks. All hooks are optional. The platform dispatches
 * each by `providerId` — a module's hook only runs for providers it
 * declared, never globally.
 */
export interface ModelProviderHooks {
  /**
   * Decode an OAuth access token into the well-known
   * {@link ModelProviderIdentity} slots. Called once at credential creation
   * and after every refresh; the result is persisted on the credential row
   * so the proxy doesn't re-decode on every request.
   *
   * Returns the populated subset of identity slots, or `null` if the token
   * carries no decodable identity. The platform uses
   * `requiredIdentityClaims` (on the provider definition) to enforce that
   * mandatory slots are populated after extraction.
   *
   * The module is responsible for translating its provider-specific claim
   * vocabulary into these abstract slots — the platform never sees the
   * raw claim names.
   */
  extractTokenIdentity?: (accessToken: string) => ModelProviderIdentity | null;

  /**
   * Build the `apiKey` placeholder that lands in the agent container's
   * `MODEL_API_KEY` env var, when the in-container LLM client expects a
   * structurally meaningful value (e.g. a JWT it will decode to read a
   * routing claim). Returns `null` to fall back to the platform's generic
   * placeholder.
   *
   * The real upstream credential never leaves the platform/sidecar
   * boundary — the placeholder is what the agent container sees. Modules
   * whose in-container shape only needs an opaque token should not
   * implement this hook.
   */
  buildApiKeyPlaceholder?: (accessToken: string) => string | null;

  /**
   * Validate a credential OFFLINE — with NO network call. Subscription
   * providers (`claude-code`, `codex`) implement this so the platform can
   * confirm a token is structurally valid and unexpired by decoding it
   * locally, instead of spending a subscription request against the
   * vendor's backend. Real per-model availability is validated at the
   * first agent run (on the Pi engine).
   *
   * When present, the platform's connection test calls this hook and
   * NEVER issues a subscription API request. API-key providers omit it
   * and fall back to the generic `GET ${baseUrl}/models` discovery probe.
   */
  validateCredential?: (ctx: CredentialValidationContext) => CredentialValidationResult;
}

/**
 * Declarative model-list selector resolved against the platform's vendored
 * pricing catalog instead of being hand-enumerated.
 *
 * Why this exists: a hand-curated id list is a snapshot that rots silently.
 * The subscription providers (`claude-code`, `codex`) cannot probe their
 * upstream to enumerate models — `docs/architecture/SUBSCRIPTION_COMPLIANCE.md`
 * forbids ANY platform-side API call for that — so their lists used to be
 * frozen prose that fell behind the catalog by whole model generations. A
 * selector re-derives the list from the catalog on every read, so the weekly
 * catalog refresh carries new generations through automatically.
 *
 * Resolution lives entirely platform-side (`apps/api/src/services/
 * model-providers/model-selection.ts`) — this type is only the declaration.
 *
 * Deliberately two knobs and no more. Anything that cannot be said with
 * `catalogFamilies` × `generations` — an exclusion, a hard cap, a hand-picked
 * ordering — is a sign the served set is NOT "the vendor's current
 * generations", and the honest declaration for that is an explicit array
 * (see {@link ModelIdSelection}), which carries its own reviewability.
 */
export interface CatalogModelSelector {
  /**
   * Catalog id prefixes, in priority order (e.g. `"claude-opus"`). A catalog
   * id belongs to the family when it reads `<family>-<version>` with a purely
   * numeric version, dashed or dotted (`claude-opus-4-8`, `claude-opus-5`).
   * A qualifier suffix disqualifies it (`claude-opus-5-thinking` is a variant
   * of a generation, not a generation), and so do dated aliases
   * (`claude-opus-4-20250514`) — they duplicate a canonical id under a
   * snapshot name.
   */
  readonly catalogFamilies: readonly string[];
  /**
   * How many generations to keep per family, newest first. The resolved list
   * interleaves families by generation index (newest of every family, then
   * every second-newest), so its head is one current model per family.
   */
  readonly generations: number;
}

/**
 * Either an explicit id list or a {@link CatalogModelSelector}. An explicit
 * array stays the right answer whenever the set is defined by something the
 * catalog does not model (e.g. the Codex ChatGPT sign-in set, which is
 * defined by OpenAI documentation and deliberately narrower than the OpenAI
 * API catalog).
 */
export type ModelIdSelection = readonly string[] | CatalogModelSelector;

/** Narrow a {@link ModelIdSelection} to its selector arm. */
export function isCatalogModelSelector(value: ModelIdSelection): value is CatalogModelSelector {
  return !Array.isArray(value);
}

/**
 * A model provider Appstrate knows how to talk to.
 *
 * Aggregated by the platform from every loaded module's
 * `modelProviders()` contribution. The runtime registry resolves by
 * `providerId`; the platform never reaches into a module's internal state.
 *
 * Two `authMode` flavours:
 *  - `"api_key"` — user provides a bearer token; no OAuth config required
 *  - `"oauth2"` — OAuth2/PKCE flow, `oauth` block required
 */
export interface ModelProviderDefinition {
  /** Stable id used as `provider_id` in DB rows and as registry lookup key. */
  providerId: string;
  /** Human-readable name for picker UIs. */
  displayName: string;
  /** Icon hint consumed by the UI (matches the existing AFPS provider iconUrl format). */
  iconUrl: string;
  /** Short marketing description for picker cards. */
  description?: string;
  /** Provider-side documentation URL surfaced as a "learn more" link. */
  docsUrl?: string;
  /**
   * Surface this provider in the "Featured" section of the model picker
   * (above an "Other providers" divider). Defaults to `false` — niche or
   * self-hosted entries (OpenAI-compatible, OpenRouter, xAI…) stay below
   * the fold without being hidden. The flag is advisory metadata only,
   * never gates writes — operators can always select any entry.
   */
  featured?: boolean;

  // — Inference wire format —
  /** Shape the runtime serializes against. */
  apiShape: ModelApiShape;
  /** Default base URL the sidecar forwards LLM traffic to. */
  defaultBaseUrl: string;
  /** Whether the user can override `defaultBaseUrl` per credential row. */
  baseUrlOverridable: boolean;

  // — Auth —
  authMode: "api_key" | "oauth2";
  /** Required iff `authMode === "oauth2"`. */
  oauth?: ModelProviderOAuthConfig;

  // — Catalog —
  /**
   * Catalog key used to look up per-model metadata (`label`,
   * `contextWindow`, `maxTokens`, `capabilities`, `cost`). Defaults to
   * `providerId` when omitted — set this when an OAuth-flavoured
   * provider reuses an underlying API catalog (e.g. `codex` →
   * `"openai"`, `claude-code` → `"anthropic"`).
   */
  catalogProviderId?: string;

  /**
   * Provider-transport restrictions applied after catalog lookup. Use this
   * when a wrapper reuses vendor metadata but its execution backend is
   * stricter (for example, ChatGPT Codex vs the OpenAI API).
   */
  generationOverride?: ModelGenerationCapabilitiesOverride;

  /**
   * Catalog model ids to surface in the picker's "Featured" section AND
   * auto-seed in `org_models` on first connection. Every id MUST exist
   * in the resolved catalog (`catalogProviderId ?? providerId`) — boot
   * fails loudly otherwise. For providers whose catalog covers the
   * whole product (openai/anthropic/mistral/google-ai/cerebras/groq/
   * xai), the picker also exposes every other catalog model under
   * "All models". For providers backed by a foreign catalog
   * (`catalogProviderId` set), the picker shows ONLY these ids — the
   * underlying API has more models than the OAuth product actually
   * exposes. Empty for openrouter (live-search) and openai-compatible
   * (Custom only).
   *
   * Accepts either an explicit id array or a {@link CatalogModelSelector}
   * derived from the catalog at read time. A selector is the right choice
   * when the product tracks the vendor's current generation (`claude-code`);
   * an array is right when the served set is defined outside the catalog
   * (`codex` — the ChatGPT sign-in set is narrower than the OpenAI API
   * catalog). Either way the boot check applies to the RESOLVED ids.
   */
  featuredModels: ModelIdSelection;

  /**
   * Candidate model ids for discovery — the source list for whichever
   * {@link modelDiscovery} strategy applies. For the default (probe) strategy
   * the platform probes each one against the connected credential (1-token
   * inference request) and persists the ids that respond 2xx; for the static
   * strategy it serves these directly (∩ catalog), resolved on read and never
   * persisted. Unlike
   * {@link featuredModels}, ids here do NOT have to exist in the resolved
   * catalog. When omitted, the platform uses `featuredModels`. Irrelevant for
   * api_key providers whose full catalog is exposed.
   *
   * Same {@link ModelIdSelection} duality as {@link featuredModels}: a
   * {@link CatalogModelSelector} typically declares more `generations` here
   * than in the featured list, so a plan still serving a previous generation
   * keeps it selectable.
   */
  modelDiscoveryCandidates?: ModelIdSelection;

  /**
   * Model-discovery strategy. When omitted, discovery is **empirical** (probe):
   * the platform issues a 1-token inference request per candidate and persists
   * the ids that respond 2xx as the credential's `availableModelIds`.
   *
   * `{ mode: "static" }` declares that the platform must issue ZERO API calls to
   * discover models: the served set is {@link modelDiscoveryCandidates}
   * (∩ catalog), WITHOUT per-model live probing. Set by subscription providers
   * (`claude-code`, `codex`) so a user's subscription token is never spent
   * enumerating models — real per-model availability is validated at the
   * first agent run (on the Pi engine).
   *
   * Nothing is written to `availableModelIds` under this mode. With no probe,
   * the answer is a pure function of (definition, catalog) and therefore
   * identical for every credential of the provider; a persisted copy would
   * carry no per-credential information and could only go stale — which is
   * exactly how users kept being offered a model list two generations old.
   * The platform resolves it on read instead, so a catalog refresh corrects
   * every existing credential at once.
   *
   * Offline credential VALIDATION (no upstream probe to test a token) is a
   * separate, orthogonal concern inferred from the PRESENCE of
   * {@link ModelProviderHooks.validateCredential} — it is NOT keyed off this
   * field.
   */
  modelDiscovery?: { mode: "static" };

  // — Behavior —
  /** Provider-scoped hooks (identity extraction, placeholder, offline validation). */
  hooks?: ModelProviderHooks;
  /**
   * Well-known {@link ModelProviderIdentity} slots the platform MUST refuse
   * to import without. Lets a provider declare that, for example, an
   * `accountId` is mandatory (because its backend uses it as a routing
   * header) — without hardcoding provider ids or claim names in the core
   * import flow. When omitted, the import succeeds with whatever the hook
   * returned (or nothing if the hook is absent).
   */
  requiredIdentityClaims?: readonly (keyof ModelProviderIdentity)[];
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
  /**
   * Raw `Request` object. Strategies that need IP resolution (for audit
   * logging or rate limiting) call into helpers keyed on the Request
   * identity (`getClientIpFromRequest`) — those helpers consult a per-
   * Request WeakMap populated by an early Hono middleware so they work
   * even when `TRUST_PROXY=false` and no forwarded header is present.
   */
  request: Request;
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
   * `X-Application-Id` header handled by `requireAppContext()`.
   */
  applicationId?: string;
  /** Permission strings already resolved by the strategy. */
  permissions: readonly string[];
  /** Optional end-user impersonation context (mirrors `c.get("endUser")`). */
  endUser?: EndUserContext;
  /** Strategy-specific metadata to attach via `c.set` under `extra` namespace. */
  extra?: Record<string, unknown>;
  /**
   * Declares this caller a first-party, server-minted loopback bearer: a request
   * the server constructed for itself (process-local secret, never persisted or
   * transmitted, not reachable from a browser). The bearer-only proxy surfaces
   * gate on THIS capability rather than on a specific module id, so a strategy
   * opts into the trusted-loopback path by declaring it here. Only set it on a
   * strategy whose token never leaves the process. Propagated to
   * `c.get("firstPartyLoopback")`.
   */
  firstPartyLoopback?: boolean;
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

/**
 * Parameters passed to the `beforeUsage` hook — a discriminated union over the
 * usage surface. `run` carries the agent package id and the projected in-flight
 * count INCLUDING the run being admitted (so a module can apply
 * concurrency-aware admission without treating the first run as zero cost);
 * `chat` carries the session id (null for an ephemeral turn with no persisted
 * session).
 *
 * Both surfaces additionally report two neutral execution facts —
 * `credentialSource` (whose credential is spent on inference) and
 * `executionPlane` (whose compute runs the work) — and a run also reports the
 * upper bound on how long it may occupy that compute (`timeoutSeconds`).
 *
 * These are FACTS, not verdicts. The platform never classifies an operation as
 * exempt and skips the hook on its behalf: it dispatches on every metered usage
 * attempt and lets the module apply its own policy to the reported facts. That
 * separation is what keeps the contract stable — a module that only cares about
 * platform-supplied inference simply ignores operations where
 * `credentialSource !== "system"`, while a module that also accounts for
 * platform compute reads `executionPlane` and `timeoutSeconds`, with no change
 * to this type and no change to where the hook fires.
 */
export type BeforeUsageParams =
  | {
      orgId: string;
      context: "run";
      packageId: string;
      runningCount: number;
      /**
       * Whose credential is spent on the inference this run performs.
       *
       * - `"system"` — a platform-supplied credential is used (a
       *   `SYSTEM_PROVIDER_KEYS` entry, or a system model preset). The
       *   organization consumes a resource it does not own.
       * - `"org"` — the organization spends its OWN credential: a BYOK API key
       *   it configured, or a provider subscription it authorized over OAuth.
       *   No platform-supplied credential is consumed for inference.
       * - `null` — not determinable at admission time. A remote-origin run
       *   resolves its model later, on its own host, so the platform cannot
       *   know here which credential it will end up using. This is not a
       *   coverage gap: if such a run later routes inference through the
       *   platform's system model proxy, that seam dispatches its own
       *   `beforeUsage` with a `credentialSource` that IS known there.
       *
       * Naming note: this matches the `llm_usage.credential_source` ledger
       * column, which is what a metering module reconciles a run against after
       * the fact. The `runs.model_source` database column is the same concept
       * under an older, persisted name — deliberately not renamed.
       */
      credentialSource: "system" | "org" | null;
      /**
       * Whose compute runs the work.
       *
       * - `"platform"` — the run executes on infrastructure the platform
       *   operates and is responsible for (a sandboxed container or microVM).
       * - `"remote"` — the caller supplies the host. The platform orchestrates
       *   and records the run but contributes no compute of its own.
       *
       * Reported separately from `credentialSource` because the two are
       * genuinely independent: an organization can bring its own credential and
       * still occupy platform compute, or supply its own host while using a
       * platform-supplied credential. A module that collapses them into a
       * single signal will mis-admit one of those combinations.
       */
      executionPlane: "platform" | "remote";
      /**
       * The upper bound on how long this run may occupy platform compute.
       *
       * - a number — the run's EFFECTIVE timeout in seconds: the agent's
       *   declared timeout after the platform ceiling has been applied. It is a
       *   ceiling, NOT a prediction of the actual duration; most runs finish
       *   well before it.
       * - `null` — not determinable at this admission point, and deliberately
       *   so: the seam admitting the operation is not the seam that owns its
       *   compute. Concretely, the system-proxy seam admits the inference of an
       *   ALREADY-RUNNING run; that run's compute was already accounted for
       *   when the run itself was admitted (platform plane), or is not
       *   platform-supplied at all (remote plane). A consumer must therefore
       *   read `null` as "contribute no compute component here", NOT as
       *   "unknown, assume the worst" — assuming the worst would account for
       *   the same run's compute twice.
       *
       * Present so a module that accounts for compute duration can derive its
       * estimate from a fact already known at admission time, instead of
       * needing a later widening of this contract. A module that does not
       * account for duration can ignore the field entirely.
       */
      timeoutSeconds: number | null;
    }
  | {
      orgId: string;
      context: "chat";
      sessionId: string | null;
      /**
       * Whose credential is spent on the inference for this chat turn.
       *
       * - `"system"` — the turn resolves to a platform-supplied model preset.
       * - `"org"` — the turn resolves to a model the organization configured
       *   with its own credential.
       *
       * Never `null` here: a chat turn resolves its model on the platform,
       * before admission, so the fact is always determinable — unlike a
       * remote-origin run, which resolves its model elsewhere.
       */
      credentialSource: "system" | "org";
      /**
       * Always `"platform"` for chat: a turn runs inside the platform's own
       * process, never on a caller-supplied host. Present rather than omitted
       * so a module can read `executionPlane` off either union member without
       * first narrowing on `context`.
       */
      executionPlane: "platform";
    };

/** Structured rejection returned by `beforeUsage` when a module blocks usage. */
export interface UsageRejection {
  code: string;
  /**
   * The RFC 9457 `detail` the caller puts on the refusal: English prose for API
   * consumers, like every other `detail` in this API. It is NOT display copy —
   * a localized UI keys its sentence off {@link UsageRejection.code}, which is
   * why that code is the half that must stay stable. Never put a thrown error's
   * message here either: it reaches API consumers and names internals.
   */
  message: string;
  /** HTTP status hint (e.g. 402 for payment required, 429 for rate limit). Defaults to 403. */
  status?: number;
}

/** Parameters passed to the `onRunStatusChange` event. */
export interface RunStatusChangeParams {
  orgId: string;
  runId: string;
  /**
   * Source agent id at event time. May be null on terminal events synthesized
   * after the source agent was deleted (rare — deletion is blocked while a
   * run is pending/running, so non-terminal events always carry a non-null
   * id). Modules filtering by package id should treat null as "no package
   * filter applies" (i.e. skip rather than match).
   */
  packageId: string | null;
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

/**
 * Single field-level error entry carried on
 * {@link RunConnectionMissingParams.errors}. Aliases the core
 * {@link ValidationFieldError} (the shape platform routes return as 4xx
 * envelopes) so modules can forward it verbatim to downstream consumers
 * (webhook payloads, Slack messages) without remapping.
 */
export type RunConnectionMissingError = ValidationFieldError;

/** Parameters passed to the `onRunConnectionMissing` event. */
export interface RunConnectionMissingParams {
  orgId: string;
  applicationId: string;
  /** Agent package id whose kickoff was blocked. */
  packageId: string;
  /** Actor whose request was blocked (user or end_user from the headless API). */
  actor: { type: "user" | "end_user"; id: string };
  /** Field-level errors that triggered the block (same shape as 4xx envelopes). */
  errors: RunConnectionMissingError[];
}

// ---------------------------------------------------------------------------
// Init context — platform services injected into modules
// ---------------------------------------------------------------------------

export interface ModuleInitContext {
  /** Redis connection string, or null when Redis is absent. */
  redisUrl: string | null;
  /** Public-facing URL of the platform (for OAuth callbacks, etc.). */
  appUrl: string;
  /** Lazy email sender (breaks circular deps at module load time). */
  getSendMail: () => Promise<(to: string, subject: string, html: string) => void>;
  /** Query helper: get org admin emails. */
  getOrgAdminEmails: (orgId: string) => Promise<string[]>;
  /**
   * Query helper: resolve an organization's display name, or null when the
   * org no longer exists.
   */
  getOrgName: (orgId: string) => Promise<string | null>;
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
   * `services` grants modules privileged, cross-org access to the platform
   * (today: reading the per-run `llm_usage` ledger). Modules are therefore
   * trusted code on par with `apps/api` itself. Only load modules you control
   * or have audited — never treat `MODULES=` as a safe extension point for
   * untrusted packages.
   */
  services: PlatformServices;
}

// ---------------------------------------------------------------------------
// PlatformServices — injected platform capabilities
//
// Deliberately minimal: a capability lands here ONLY when a real consumer
// needs it. `scripts/verify-module-contract.ts` enforces that mechanically —
// every member below must carry a ledger entry naming its consumers (adding one
// without an entry fails `tsc`), and a member no module consumes fails the check
// as dead surface, exactly like an `AppstrateModule` member would. Each member's
// own JSDoc states why the consumer cannot obtain the capability any other way.
// The previous broad surface (orchestrator /
// pubsub / realtime / inline / packages / models / applications / run CRUD)
// mirrored an in-process module that has since been removed — it carried zero
// live consumers, so it was dropped rather than left as speculative API.
// Re-add a member here the moment a consumer genuinely needs it.
// ---------------------------------------------------------------------------

/**
 * One projected `llm_usage` ledger row from {@link PlatformServices.usage.list}
 * — the cursor read a metering consumer reconciles by serial `id`. OSS-neutral:
 * reports who paid the provider ({@link LlmUsageLedgerRow.credentialSource}),
 * never any downstream accounting, and NEVER the backing upstream model id or
 * protocol family (`real_model` / `api`, server-side-only columns).
 */
export interface LlmUsageLedgerRow {
  /** Serial primary key — the cursor value the consumer advances by. */
  id: number;
  orgId: string;
  /** Equivalent cost (USD) at the model's catalog rates. */
  costUsd: number;
  /**
   * Which producer wrote the row.
   *
   *  - `"proxy"` — an immutable per-call row. Covers BOTH the inference proxy
   *    AND the in-process chat engine, which drives a subscription model
   *    directly and never traverses the proxy: they share the producer tag
   *    because they share the row shape (settled at insert, one row per call).
   *    Distinguish a chat turn by {@link contextType} `"chat"`, never by this.
   *  - `"runner"` — the agent runner's ONE cumulative row per run (see
   *    {@link settled}).
   */
  source: "proxy" | "runner";
  /** What the row is attributed to — an agent run, a chat session, or nothing. */
  contextType: "run" | "chat" | null;
  /** The run id / chat session id matching {@link contextType} (null when unattributed). */
  contextId: string | null;
  /** Which credential set reached the provider: platform-provided or the org's own. */
  credentialSource: "system" | "org" | null;
  /**
   * How much of {@link costUsd} is backed by real per-token rates.
   *
   *  - `"priced"` — every token bucket that carried usage had a rate; the
   *    number is complete.
   *  - `"partial"` — part of the consumption (cached input) had no rate and was
   *    priced at zero, so the number is a FLOOR — the real spend is higher.
   *  - `"unpriced"` — no rates were available for the model at all. A
   *    {@link costUsd} of `0` alongside this value means "the platform could not
   *    price this call", NOT "this call was free": a consumer must not settle it
   *    as zero spend without deciding what an unpriceable call is worth.
   *  - `null` / absent — the row predates the field. NEVER read that as
   *    `"priced"`.
   *
   * Optional so a consumer written before the field compiles unchanged; the
   * platform stamps every row it writes.
   */
  pricingStatus?: "priced" | "partial" | "unpriced" | null;
  /**
   * Whether the row's `costUsd` is final. Proxy/chat rows are immutable at
   * insert (always settled); a runner row's total GROWS during its run (one
   * cumulative row per run) and only settles once the run reaches a terminal
   * status (or its run row is gone). A cursor consumer processes settled rows
   * only and NEVER advances its watermark past the first unsettled row — see
   * {@link PlatformServices.usage.list} for the head-of-line trade-off that
   * implies and when it is safe to skip an unsettled row.
   */
  settled: boolean;
}

export interface PlatformServices {
  /**
   * Structured JSON logger — the platform's OWN pino instance, so module output
   * lands in one stream with one format. A module importing `apps/api`'s logger
   * would couple itself to the app.
   */
  logger: Logger;
  /**
   * HTTP middleware factories for module routes.
   *
   * `rateLimit(maxPerMinute)` returns the platform's authenticated
   * per-route limiter (keyed on user id / API key + method + path,
   * Redis-backed under Redis, in-memory otherwise, IETF RateLimit
   * headers, 429 with Retry-After). Modules capture `services` at init
   * and wire the factory into their routers — same guard semantics as
   * every core route, no parallel implementation.
   */
  http: {
    rateLimit(maxPerMinute: number): MiddlewareHandler;
    /**
     * Resolve the client IP for a request, honoring the platform's
     * `TRUST_PROXY` semantics (trusted `X-Forwarded-For` hops vs. socket
     * address). Returns the `"unknown"` sentinel when nothing resolves.
     * Same resolver every core route uses — modules that tag telemetry or
     * key rate buckets by IP get identical trust semantics.
     */
    clientIp(c: Context): string;
  };
  /**
   * Cursor read into the append-only `llm_usage` ledger — the canonical platform
   * usage source of truth, read WITHOUT a cross-module SQL join. A metering
   * consumer sweeps it by serial `id` watermark: `list({ afterId })` returns the
   * next batch ordered by `id` ASC; `settledFrontier()` returns the only safe
   * point at which to initialize that watermark at cutover (see its doc). See
   * {@link LlmUsageLedgerRow.settled} for the ordering contract the consumer must
   * honor.
   */
  usage: {
    /**
     * Next VISIBLE ledger rows after `afterId` (exclusive, default 0), ordered
     * by `id` ASC, capped by `limit` (service default 500, max 1000). Optional
     * `credentialSource` filters to rows stamped `system` / `org`.
     *
     * NOT every ledger row is visible. A remote run whose inference flows
     * through the platform's inference proxy is metered TWICE in the ledger:
     * once per call by the proxy, and once more by the runner's cumulative
     * side-channel mirror (`source` `"runner"`, `credentialSource` null, on a
     * run that also has proxy rows). Both describe the same spend, so the
     * service EXCLUDES the mirror on every read. A consumer must NOT re-apply
     * that rule — it would then be filtering rows it never received.
     *
     * Consequence for the cursor: returned ids are NOT contiguous, and a batch
     * is "the next `limit` VISIBLE rows after `afterId`", never "ids
     * `afterId+1 … afterId+limit`". An empty batch therefore always means
     * "caught up" — never "the next id is hidden, retry" — so a consumer may
     * advance its watermark to the last id it received and stop.
     *
     * Head-of-line trade-off: the consumer must never advance its watermark past
     * the first UNSETTLED row (see {@link LlmUsageLedgerRow.settled}), so a single
     * unsettled row — e.g. a long-running run whose cumulative runner row is still
     * growing — pins the frontier and holds back every LATER row (settled or not)
     * from being processed until it settles. A consumer that will never process a
     * given `credentialSource` may nonetheless safely skip that row's unsettled
     * entries: `credentialSource` is fixed at a row's first insert and is NEVER
     * mutated by the monotonic runner upsert, so skipping it can never cause a
     * later cost to be mis-attributed.
     */
    list(args: {
      afterId?: number;
      limit?: number;
      credentialSource?: "system" | "org";
    }): Promise<LlmUsageLedgerRow[]>;
    /**
     * Highest ledger id `N` such that EVERY row with id ≤ `N` is settled — the
     * only safe point at which a consumer may initialize its cursor watermark at
     * cutover. Returns `MIN(unsettled id) − 1` when any unsettled row exists, else
     * `MAX(id)`, else `0` for an empty ledger.
     *
     * Why not a plain `MAX(id)`: a runner row for an in-flight run is assigned its
     * serial `id` at the first metric event (a LOW id) yet stays unsettled while
     * its cumulative cost grows. A watermark seeded at the global `MAX(id)` would
     * sit ABOVE that low id, so when the run finally settles its row is already
     * behind the watermark and its usage is dropped forever. `settledFrontier()`
     * stops at the first unsettled row, so no in-flight runner row is ever
     * stranded below the initial watermark.
     *
     * Computed over the SAME visible set as {@link list} (the runner mirror of a
     * proxy-metered run is excluded from both): a frontier taken over rows the
     * consumer can never receive would stall forever on an invisible unsettled
     * mirror, or sit above ids that were skipped.
     */
    settledFrontier(): Promise<number>;
  };
  /**
   * In-process dispatch into the fully-wired platform Hono app — the same
   * request the loopback `fetch("http://127.0.0.1:<port>/api/…")` would make,
   * but without the socket round-trip and HTTP (de)serialization. The auth
   * pipeline + RBAC still run on every dispatched request (it goes through the
   * whole middleware chain), so a caller can never exceed what the forwarded
   * credential could do over REST. Callers MUST set the caller's auth/scoping
   * headers on the `Request` exactly as they would for the loopback fetch.
   */
  inProcess: {
    dispatch(request: Request): Promise<Response>;
  };
  /**
   * Resolve the chosen chat model row to its real upstream binding for one chat
   * turn. For an oauth-subscription (claude-code/codex) model, returns the real
   * model id + baseUrl + a FRESH access token so the chat module can drive the
   * single generic in-process Pi chat engine inline; for an API-key / unknown
   * provider it returns `{ subscription: false }` so the chat falls to its
   * llm-proxy binding on the same engine; for a dead oauth credential it returns
   * `{ subscription: true, needsReconnection: true }`. The chat module has no DB
   * access — this is the seam that resolves the credential + token server-side,
   * so the real subscription token never enters the module's own resolution
   * (only the returned in-memory string, used to build the Pi `AuthStorage`).
   */
  resolveSubscriptionChatModel(
    orgId: string,
    presetId: string,
  ): Promise<SubscriptionChatResolution>;
  /**
   * Record one chat turn's LLM usage as an `llm_usage` ledger row (source
   * `proxy`, `run_id` null). The chat module has no DB access, so metering for
   * the inline Pi engine crosses through here — same ledger the llm-proxy meters
   * into for proxy-routed chat turns and every agent run.
   */
  recordChatUsage(record: ChatUsageRecord): Promise<void>;
  /**
   * Resolve a chat composer file attachment to a durable `document://` URI:
   * materialize an `upload://` staged upload into a chat-session-scoped document
   * (purpose `user_upload`), or validate that an existing `document://` is
   * readable by the session owner. The chat module has no DB access, so
   * materialization + the container-inherited ACL check cross through here.
   * Rejections (over-cap, over-limit, not-found/foreign document) are thrown as
   * the platform's RFC 9457 errors, which the chat route surfaces to the user.
   */
  resolveChatAttachment(request: ChatAttachmentRequest): Promise<ResolvedChatAttachment>;
  /**
   * Detach-or-delete the documents contained by a chat session being deleted. A
   * session document a run still consumes is detached (`chat_session_id = NULL`)
   * so the run's rerun still resolves it; an unconsumed one is deleted (row +
   * org counter + storage object). The chat module has DB access but no storage
   * access and no documents-service surface, so this crosses through here. Called
   * by the DELETE session route BEFORE removing the `chat_sessions` row, so the
   * FK cascade cannot destroy the evidence first.
   *
   * `tx` is the caller's open DB transaction handle (opaque here — core carries
   * no Drizzle dependency). The chat module passes the SAME transaction it uses
   * to delete the `chat_sessions` row, so the document teardown and the row
   * delete commit atomically: a document materializing in the gap can no longer
   * be cascade-deleted without a storage-deletion outbox job. Omitted → the
   * platform opens its own transaction (the legacy, non-atomic single call).
   */
  cleanupSessionDocuments(chatSessionId: string, tx?: unknown): Promise<void>;
  /**
   * Chat admission gate — the chat-surface entry point into the `beforeUsage`
   * hook. The chat module calls this before starting ANY turn, and the platform
   * dispatches the hook for every one of them. Returns a
   * {@link UsageRejection} to block the turn (the module surfaces it as an RFC
   * 9457 problem response with the hook's status — 402 flows through), or null
   * to allow.
   *
   * The platform still resolves whether the chosen model is system-provided or
   * organization-owned — keeping that resolution server-side is what keeps the
   * chat module dumb, since it has no model-registry access — but it now
   * REPORTS that resolution as the `credentialSource` fact instead of using it
   * to pre-filter. A turn on the organization's own credential reports
   * `credentialSource: "org"` and is dispatched all the same, because a chat
   * turn always executes in the platform's own process: the platform supplies
   * the compute even when it supplies no credential. `executionPlane` is
   * consequently always `"platform"` on this surface.
   *
   * A module that only accounts for platform-supplied inference treats such a
   * turn as contributing nothing and admits it — the same outcome the platform
   * used to assume on the module's behalf, now decided by the module that owns
   * the policy.
   *
   * `subscription` is the one fact the caller owns and the platform cannot
   * derive: the turn runs on a provider subscription the organization
   * authorized over OAuth (claude-code, codex), driven in-process rather than
   * through the inference gateway. Such a turn is `credentialSource: "org"`
   * whatever its preset resolves to, and it is dispatched like any other — it
   * still occupies the platform's own process. Splitting the responsibility
   * this way keeps the seam DRY: the caller reports what it knows, the platform
   * derives the rest from the model registry.
   */
  checkUsageAllowed(args: {
    orgId: string;
    presetId: string;
    sessionId: string | null;
    subscription: boolean;
  }): Promise<UsageRejection | null>;
  /**
   * Set (or clear) an organization's per-org document storage limit — the
   * technical byte ceiling the platform enforces on durable-document writes.
   * A metering module pilots per-org storage by mapping whatever entitlement
   * it owns onto a byte value and writing it here; the platform then enforces
   * `documents_bytes_limit ?? ORG_STORAGE_QUOTA_BYTES ?? unlimited` on every
   * document write.
   *
   *  - `bytes` a non-negative safe integer → the org's override.
   *  - `bytes` null → clears the override (back to the env default).
   *
   * The core knows only a byte ceiling — never the entitlement it came from.
   * Throws the platform's RFC 9457 errors — a 404 for an unknown `orgId`, a
   * 400 for a negative / non-integer `bytes`.
   */
  setDocumentStorageLimit(orgId: string, bytes: number | null): Promise<void>;
}
