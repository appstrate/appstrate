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
import type { Hono } from "hono";
import type { ValidationFieldError } from "./api-errors.ts";
import type { Logger } from "./logger.ts";
import type { OrgRole } from "./permissions.ts";
import type { ModelApiShape, OAuthWireFormat } from "./sidecar-types.ts";
import type { CredentialProxyCallInput, CredentialProxyCallResult } from "./platform-types.ts";

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

/**
 * The object ACL carried on storage→search events. `storage` owns this
 * (source of truth); `search` denormalises a copy onto its index and re-syncs
 * it on `onStorageObjectAclChanged` (strategy §5 — the Onyx pitfall).
 */
export interface StorageObjectEventAcl {
  visibility: "org" | "private";
  ownerId: string | null;
}

/** `onStorageObjectUpserted` payload — a stored object to (re)index by id. */
export interface StorageObjectUpsertedParams {
  /** The OPAQUE object id consumers read bytes by — never the driver key. */
  id: string;
  orgId: string;
  diskId: string;
  mime: string | null;
  acl: StorageObjectEventAcl;
}

/** `onStorageObjectDeleted` payload — evict the object from the index. */
export interface StorageObjectDeletedParams {
  id: string;
  orgId: string;
}

/** `onStorageObjectAclChanged` payload — re-scope the object's index copy. */
export interface StorageObjectAclChangedParams {
  id: string;
  orgId: string;
  acl: StorageObjectEventAcl;
}

/** Known events and their signatures. Handlers may be sync or async. */
export interface ModuleEvents {
  /** Run status changed — broadcast on every run lifecycle transition. */
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
  /** Org deleted — broadcast before an organization is deleted. */
  onOrgDelete: (orgId: string) => void | Promise<void>;
  /**
   * A storage object was created or its bytes changed — (re)index it.
   * Emitted by `storage` through `services.events.emit`, consumed by `search`.
   * The storage→search seam (strategy §5): events, never JOIN.
   */
  onStorageObjectUpserted: (params: StorageObjectUpsertedParams) => void | Promise<void>;
  /** A storage object was deleted — evict it from the index. */
  onStorageObjectDeleted: (params: StorageObjectDeletedParams) => void | Promise<void>;
  /** A storage object's ACL changed — re-scope the index's denormalised copy. */
  onStorageObjectAclChanged: (params: StorageObjectAclChangedParams) => void | Promise<void>;
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
 * Context passed to provider-specific proxy hooks. The provider's
 * `beforeLlmProxyRequest` decides which headers to add/override on the
 * outbound LLM call (e.g. an account-routing header).
 */
export interface ModelProviderProxyContext {
  providerId: string;
  /** Credential kind backing this call — providers can choose to skip hooks for API-key flows. */
  credentialKind: "api_key" | "oauth";
  /** The access token (OAuth) or API key (api_key) the platform will forward upstream. */
  apiKey: string;
  /** The incoming request headers from the agent — read-only. */
  incomingHeaders: Headers;
}

/** Patch returned by `beforeLlmProxyRequest`. Empty object = no changes. */
export interface ModelProviderProxyPatch {
  /** Headers to merge into the outbound request. Later wins over earlier. */
  headers?: Record<string, string>;
}

/**
 * Well-known identity slots a provider may surface from an OAuth access
 * token. Modules map their provider-specific claim names into these
 * abstract slots, so the platform never needs to know any provider's
 * internal claim vocabulary.
 *
 * `accountId` is the stable account/tenant identifier the provider uses
 * for routing (echoed back to the upstream via the configured
 * `accountIdHeader`). `email` is the user identity associated with the
 * credential.
 */
export interface ModelProviderIdentity {
  accountId?: string;
  email?: string;
}

/**
 * Pure-data inference probe request — used by the platform's connection
 * test to verify that a stored credential can actually serve traffic
 * against the provider's backend. Factored out so the wire format can be
 * unit-tested without standing up an HTTP listener.
 */
export interface InferenceProbeRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

/**
 * Input passed to {@link ModelProviderHooks.buildInferenceProbe}. The
 * platform supplies the resolved model + credential material; the module
 * builds the wire-shape its backend will actually accept.
 */
export interface InferenceProbeContext {
  baseUrl: string;
  modelId: string;
  apiKey: string;
  /** Populated from the credential row's identity slots when present. */
  accountId?: string;
}

/**
 * Pure-data error result a module may return from
 * {@link ModelProviderHooks.buildInferenceProbe} when it knows the probe
 * cannot succeed (e.g. a required identity slot is missing). The platform
 * surfaces it as a `TestResult` without ever sending the request.
 */
export interface InferenceProbeBuildError {
  error: string;
  message: string;
}

/**
 * Provider-scoped hooks. All hooks are optional. The platform dispatches
 * each by `providerId` — a module's hook only runs for providers it
 * declared, never globally.
 */
export interface ModelProviderHooks {
  /**
   * Called by the LLM proxy and the in-container sidecar before forwarding
   * a request upstream. Returns a patch (typically extra headers) merged
   * into the outbound request. MUST be fast and side-effect-free — invoked
   * on every LLM call.
   */
  beforeLlmProxyRequest?: (
    ctx: ModelProviderProxyContext,
  ) => Promise<ModelProviderProxyPatch> | ModelProviderProxyPatch;

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
   * Build the inference probe the platform sends to verify the credential
   * can serve traffic. Modules whose backend doesn't accept the generic
   * `GET ${baseUrl}/models` discovery probe implement this hook to
   * provide the real wire format.
   *
   * Returns:
   *  - {@link InferenceProbeRequest} → the platform sends it and reports
   *    the result.
   *  - {@link InferenceProbeBuildError} → the platform surfaces it as a
   *    failed `TestResult` without ever sending the request (e.g. when a
   *    required identity slot is missing).
   *  - `null` → fall back to the platform's generic `/models` discovery
   *    probe.
   */
  buildInferenceProbe?: (
    ctx: InferenceProbeContext,
  ) => InferenceProbeRequest | InferenceProbeBuildError | null;
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
  /**
   * Declarative wire-format quirks the sidecar must apply on this
   * provider's behalf — static identity headers, accountId routing
   * header, system-prompt prepend, body coercions (`forceStream`/
   * `forceStore`), URL path rewriting, adaptive header retries.
   *
   * Only meaningful for OAuth providers. The platform forwards this
   * struct verbatim into the sidecar's `LlmProxyOauthConfig.wireFormat`
   * at boot, so the sidecar runtime never branches on `providerId` —
   * adding a new OAuth provider is a pure declarative change.
   */
  oauthWireFormat?: OAuthWireFormat;

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
   */
  featuredModels: readonly string[];

  /**
   * Candidate model ids for **empirical discovery** — the platform
   * probes each one against the connected credential (1-token inference
   * request) and persists the ids that respond 2xx as the credential's
   * `availableModelIds`. Lets subscription-backed OAuth providers
   * (codex, claude-code) surface the models a *specific account/plan*
   * actually serves, which no static catalog can know.
   *
   * Unlike {@link featuredModels}, ids here do NOT have to exist in the
   * resolved catalog — the probe is the validation. When omitted, the
   * platform probes `featuredModels` only. Irrelevant for api_key
   * providers whose full catalog is exposed.
   */
  modelDiscoveryCandidates?: readonly string[];

  // — Behavior —
  /** Provider-scoped hooks (header injection, identity extraction). */
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
// Module job queues — the structural subset of the platform queue surface
// exposed to modules through `services.queues`. The platform's own JobQueue
// implementations (BullMQ / in-memory) satisfy these shapes structurally;
// modules never import apps/api internals. Scheduler (cron) methods are
// deliberately absent — no module consumer.
// ---------------------------------------------------------------------------

export interface ModuleQueueJob<T> {
  readonly id: string;
  readonly name: string;
  readonly data: T;
  readonly attemptsMade: number;
}

export interface ModuleJobAddOptions {
  attempts?: number;
  backoff?: { type: "custom" };
  removeOnComplete?: number | boolean;
  removeOnFail?: number | boolean;
}

export interface ModuleWorkerOptions {
  concurrency?: number;
  limiter?: { max: number; duration: number };
  /** Custom backoff strategy: given attempt number (1-based), return delay in ms. */
  backoffStrategy?: (attempt: number) => number;
}

export interface ModuleJobQueue<T> {
  /** Add a one-shot job. Returns job ID. */
  add(name: string, data: T, opts?: ModuleJobAddOptions): Promise<string>;
  /**
   * Start processing jobs with the given handler. No-op when the process role
   * excludes job processing (`APP_ROLE=api`) — check
   * `services.queues.processingEnabled` to log/branch explicitly. A handler
   * that throws is retried up to the queue's `attempts`; return cleanly for
   * "nothing to do" so a vanished input never burns the retry budget.
   */
  process(handler: (job: ModuleQueueJob<T>) => Promise<void>, opts?: ModuleWorkerOptions): void;
  /** Graceful shutdown: drain active jobs, close connections. */
  shutdown(): Promise<void>;
  /** Current queue depth (waiting/delayed/active). */
  count(): Promise<number>;
}

// ---------------------------------------------------------------------------
// PlatformServices — injected platform capabilities
//
// Deliberately minimal: a capability lands here ONLY when a real cross-tenant
// consumer needs it (the same razor `scripts/verify-module-contract.ts`
// applies to the `AppstrateModule` members). Consumers today: the `cloud`
// billing module (`runs.listLlmUsage`), `storage` (`credentialProxy`), and
// `search` (`events` for the storage seam + `queues` for the heavy
// extract/embed ingestion). The previous broad surface (orchestrator / pubsub
// / realtime / inline / packages / models / applications / run CRUD) mirrored
// the in-process `chat` module that has since been removed — it carried zero
// live consumers, so it was dropped rather than left as speculative API.
// Re-add a member here the moment a second consumer genuinely needs it.
// ---------------------------------------------------------------------------

export interface PlatformServices {
  /** Structured JSON logger (pino). */
  logger: Logger;
  /**
   * Emit a module event to ALL loaded modules that listen for it (the same
   * broadcast fan-out the platform uses for its own events: every handler is
   * called, errors isolated per handler). This lets one module SIGNAL another
   * without importing it — the cross-module path is events, never a SQL join
   * or a code dependency.
   *
   * Consumer: `storage` emits `onStorageObject{Upserted,Deleted,AclChanged}`
   * for `search` to index/evict/re-scope (strategy §5). The razor (a capability
   * lands here only with a real consumer) is satisfied: search is that consumer.
   */
  events: {
    emit<E extends keyof ModuleEvents>(
      name: E,
      ...args: Parameters<ModuleEvents[E]>
    ): Promise<void>;
  };
  /**
   * Background job queues — BullMQ when Redis is configured, in-memory
   * otherwise. Queue names are global: prefix with the module id (e.g.
   * `search-indexing`) to avoid collisions.
   *
   * Consumer: `search` runs its heavy extract → chunk → embed ingestion off
   * the request path so a storage upsert never blocks on indexing. Deployment
   * roles (`APP_ROLE`): `combined` (default) processes jobs in-process; `api`
   * only enqueues (a separate `worker` process consumes); splitting roles
   * requires Redis (in-memory queues are per-process — the platform warns and
   * keeps processing inline).
   */
  queues: {
    create<T>(name: string, defaults?: ModuleJobAddOptions): Promise<ModuleJobQueue<T>>;
    /** Whether THIS process executes job handlers (role ≠ `api`). */
    processingEnabled: boolean;
  };
  /** Run-ledger read surface. */
  runs: {
    /**
     * Per-call `llm_usage` ledger rows for a run, org-scoped and filtered by
     * `source` (e.g. `["runner", "proxy"]`). A read into the canonical platform
     * usage ledger WITHOUT a cross-module SQL join — a consumer that aggregates
     * per-call usage (analytics, an external usage store) reads here rather than
     * joining `llm_usage` directly. Returns `{ id, costUsd, source }[]`; the
     * caller reconciles on `id` against its own store.
     */
    listLlmUsage(args: {
      runId: string;
      orgId: string;
      sources: readonly string[];
    }): Promise<Array<{ id: number; costUsd: number; source: string }>>;
  };
  /**
   * Credential proxy — make an authenticated outbound call to a third-party
   * API using one of the caller's EXISTING integration connections. The
   * platform substitutes the credential server-side (the same credential-proxy
   * the agent runtime uses); the module never sees the raw provider token and
   * never rolls its own OAuth. Consumer: `module-storage` cloud disks reuse a
   * user's connection (e.g. Google Drive) to browse/read files.
   */
  credentialProxy: {
    call(input: CredentialProxyCallInput): Promise<CredentialProxyCallResult>;
  };
}
