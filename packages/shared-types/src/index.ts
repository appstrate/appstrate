// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import type { ModelCost } from "@appstrate/core/module";

export type { WebhookInfo, WebhookCreateResponse, WebhookDelivery } from "./webhooks.ts";
import type { AgentIntegrationEntry } from "./integrations.ts";
export type {
  AccessibleIntegrationConnection,
  AgentIntegrationEntry,
  ConsumingAgentSummary,
  IntegrationAgentResolution,
  IntegrationAuthStatus,
  IntegrationAuthType,
  IntegrationCandidate,
  IntegrationConnection,
  IntegrationDetail,
  IntegrationManifestAuth,
  IntegrationManifestTool,
  IntegrationManifestView,
  IntegrationOAuthClient,
  IntegrationOrgDefault,
  IntegrationPickStatus,
  IntegrationPin,
  IntegrationSummary,
  IntegrationToolCatalogEntry,
} from "./integrations.ts";

export type { UserProfile, RunLog } from "@appstrate/db/schema";
import type { PackageType } from "@appstrate/core/validation";
export type { PackageType };

export type { Run } from "@appstrate/db/schema";

import { runStatusEnum as _runStatusEnum } from "@appstrate/db/schema";
type _RunStatus = (typeof _runStatusEnum.enumValues)[number];

/**
 * Wire-shape Run DTO returned to API consumers. The Drizzle `Run` row keeps
 * camelCase field names internally (Better Auth blocker); this is the single
 * snake_case wire surface every JSON response uses. Universal DB-convention
 * fields (`id`, `*Id`, `createdAt`, …) stay camelCase per Phase 3 scope.
 */
export interface RunWireDto {
  id: string;
  packageId: string | null;
  userId: string | null;
  endUserId: string | null;
  apiKeyId: string | null;
  orgId: string;
  applicationId: string;
  scheduleId: string | null;
  status: _RunStatus;
  input: unknown;
  result: unknown;
  checkpoint: unknown;
  error: string | null;
  metadata: unknown;
  config: unknown;
  config_override: unknown;
  started_at: string | null;
  completed_at: string | null;
  duration: number | null;
  cost: number | null;
  notifiedAt: string | null;
  readAt: string | null;
  runNumber: number | null;
  token_usage: unknown;
  version_label: string | null;
  version_dirty: boolean | null;
  proxy_label: string | null;
  model_label: string | null;
  model_source: string | null;
  runner_name: string | null;
  runner_kind: string | null;
  agent_scope: string | null;
  agent_name: string | null;
  runOrigin: string | null;
  contextSnapshot: unknown;
  modelCredentialId: string | null;
  connection_overrides: unknown;
}

/** Run with enriched display names from LEFT JOINs (dashboard user, end-user, API key, schedule). */
export type EnrichedRun = RunWireDto & {
  user_name: string | null;
  end_user_name: string | null;
  api_key_name: string | null;
  schedule_name: string | null;
  /** True if the run's source package is an inline/ephemeral shadow (POST /api/runs/inline). */
  package_ephemeral?: boolean;
  /** For inline runs only — snapshot of the manifest submitted at run time. Null after compaction. */
  inline_manifest?: Record<string, unknown> | null;
  /** For inline runs only — snapshot of the prompt submitted at run time. Null after compaction. */
  inline_prompt?: string | null;
};

// --- App Config Types ---

/**
 * Platform feature flags.
 *
 * Only *core* flags are statically typed here — flags derived from
 * environment variables owned by the core platform (opt-in integrations
 * like Google/GitHub OAuth, SMTP).
 *
 * Module-owned flags (e.g. `webhooks` from the webhooks module, `oidc`)
 * are contributed at boot via
 * `AppstrateModule.features` and flow through the index signature —
 * adding a new module never requires editing shared-types.
 */
export interface AppConfigFeatures {
  googleAuth: boolean;
  githubAuth: boolean;
  smtp: boolean;
  /** AUTH_DISABLE_SIGNUP — webapp hides "Create account" links and copy. */
  signupDisabled: boolean;
  /** AUTH_DISABLE_ORG_CREATION — webapp routes org-less users to "waiting for invitation". */
  orgCreationDisabled: boolean;
  /**
   * AUTH_BOOTSTRAP_TOKEN is set and unredeemed (#344 Layer 2b). The webapp
   * routes the user to `/claim` instead of `/login`, where they paste the
   * token + their owner credentials to seize ownership of a freshly-
   * installed unattended instance. Flips back to false once the token is
   * consumed. The token VALUE is never exposed in AppConfig — only the
   * pending-state boolean.
   */
  bootstrapTokenPending: boolean;
  [key: string]: boolean;
}

export interface AppConfig {
  features: AppConfigFeatures;
  legalUrls?: {
    terms?: string;
    privacy?: string;
  };
  /**
   * AUTH_BOOTSTRAP_OWNER_EMAIL surfaced for the SPA so `RegisterForm` can
   * pre-fill and lock the email field on the bootstrap signup. The value
   * is the same admin contact that any visitor would discover by
   * submitting `/register` and reading the rejection message, so exposing
   * it does not widen the threat surface — but it removes the only path
   * to a typo on the bootstrap account.
   */
  bootstrapOwnerEmail?: string;
  trustedOrigins: string[];
}

// --- Package Types ---

/** A reference to a skill, tool, or integration dependency with optional metadata. */
export interface ResourceEntry {
  id: string;
  version?: string;
  name?: string;
  description?: string;
  /**
   * Niveau 2 — agent's tool allowlist for an integration dependency.
   * Drives sidecar `tools/list` filtering and OAuth scope inference.
   * `undefined` keeps legacy "all tools allowed" semantics. Ignored for
   * non-integration resource types.
   */
  tools?: string[];
  /**
   * Niveau 2 — agent's explicit OAuth scope escape hatch for an
   * integration dependency, unioned with scopes inferred from `tools`.
   * `undefined` defaults to "none beyond inference". Ignored for
   * non-integration resource types.
   */
  scopes?: string[];
}

// --- Run Types ---

import { runStatusEnum } from "@appstrate/db/schema";
export type RunStatus = (typeof runStatusEnum.enumValues)[number];
export {
  TERMINAL_RUN_STATUSES,
  TERMINAL_RUN_EVENT_TYPES,
  terminalRunStatusValues,
  ACTIVE_RUN_STATUSES,
} from "@appstrate/db/schema";
export type { TerminalRunStatus } from "@appstrate/db/schema";

// --- Schedule Types ---

// `package_schedules` is a legacy DB name — the Drizzle export is `schedules`.
import type { Schedule } from "@appstrate/db/schema";
export type { Schedule };

/**
 * Wire-shape Schedule DTO — snake_case fields exposed to the API consumer.
 * Diverges from the Drizzle `Schedule` row (which stays camelCase internally)
 * because Drizzle field names are a private implementation detail.
 */
export interface ScheduleWireDto {
  id: string;
  packageId: string;
  userId: string | null;
  endUserId: string | null;
  orgId: string;
  applicationId: string;
  name: string | null;
  enabled: boolean | null;
  cron_expression: string;
  timezone: string | null;
  input: Record<string, unknown> | null;
  config_override: Record<string, unknown> | null;
  model_id_override: string | null;
  proxy_id_override: string | null;
  version_override: string | null;
  connection_overrides: Record<string, string> | null;
  last_run_at: string | null;
  next_run_at: string | null;
  createdAt: string;
  updatedAt: string;
}

export type EnrichedSchedule = ScheduleWireDto & {
  /** Display name of the actor (member or end-user) the schedule runs as. */
  actor_name: string | null;
  /** Which actor kind owns the schedule run. Null for org/system-owned schedules. */
  actor_type: "user" | "end_user" | null;
};

// --- Organization Types ---

// `OrgRole` is owned by `@appstrate/core/permissions` (the RBAC vocabulary
// source of truth). The pgEnum in `packages/db/src/schema/enums.ts` lists
// the same values; any drift is caught at typecheck by the
// `Record<OrgRole, ReadonlySet<Permission>>` role-grant matrix in
// `apps/api/src/lib/permissions.ts` (an exhaustive Record fails when a
// role is added to one side and not the other).
import type { OrgRole } from "@appstrate/core/permissions";
export type { OrgRole };

export const orgSettingsSchema = z.object({
  apiVersion: z.string().optional(),
  dashboardSsoEnabled: z.boolean().optional(),
});
export type OrgSettings = z.infer<typeof orgSettingsSchema>;

export interface OrganizationMember {
  orgId: string;
  userId: string;
  role: OrgRole;
  joinedAt: string;
  displayName?: string;
  email?: string;
}

export interface OrganizationWithRole {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  role: OrgRole;
}

export interface OrgInvitation {
  id: string;
  email: string;
  role: OrgRole;
  token: string;
  expiresAt: string;
  createdAt: string;
}

import type { SchemaWrapper } from "@appstrate/core/form";

// --- Unified Me Connections (R1 refactor) ----------------
// User-scope view of a user's integration connections under a single
// shape. Backs `GET /api/me/connections`.

export type MeConnectionKind = "integration";

export interface MeConnectionEntry {
  /** Stable connection id (uuid). */
  connection_id: string;
  kind: MeConnectionKind;
  /** Display label set by the user. */
  label: string | null;
  scopes_granted: string[];
  connected_at: string;
  needs_reconnection: boolean;
  expiresAt: string | null;
  /** Human-friendly identity (accountEmail, sub claim). */
  identity: string | null;
  /** Which auth slot this connection satisfies. */
  auth_key: string | null;
  /** Admin/owner sharing toggle (per-org). */
  shared_with_org: boolean;
  /**
   * Number of installed agents in this connection's application that
   * declare this integration in their dependencies. Used by the UI to
   * surface "reused by N agents" so members understand that the connection
   * is shared across the org's agents rather than per-agent.
   */
  reused_by_agents: number | null;
  /** Where this connection lives (the connection is keyed per-app). */
  org: { id: string; name: string };
  application: { id: string; name: string };
}

export interface MeConnectionSourceGroup {
  kind: MeConnectionKind;
  /** Integration package id. */
  source_id: string;
  display_name: string;
  logo: string;
  total_connections: number;
  connections: MeConnectionEntry[];
}

/**
 * Fields shared by every package row when listed (agent, skill, or integration).
 * Concrete list shapes (`AgentListItem`, `OrgPackageItem`) extend this with
 * what their respective list endpoints additionally return.
 */
export interface BasePackageListItem {
  id: string;
  description: string | null;
  source: "system" | "local";
  scope: string | null;
  version: string | null;
  forked_from: string | null;
}

export interface AgentListItem extends BasePackageListItem {
  display_name: string;
  schema_version: string;
  author: string;
  keywords: string[];
  dependencies: {
    skills?: Record<string, string>;
    mcp_servers?: Record<string, string>;
    integrations?: Record<string, string>;
  };
  running_runs: number;
  type: PackageType;
  /** Always non-null on agents — narrowed for ergonomics. */
  description: string;
}

export interface AgentDetail {
  id: string;
  display_name: string;
  description: string;
  source: "system" | "local";
  dependencies: {
    skills: { id: string; version: string; name?: string; description?: string }[];
    /**
     * Niveau 2 — agent's `dependencies.integrations` flattened by
     * `parseManifestIntegrations`. Always populated (system + user
     * agents), so the dashboard's Connexions tab can render the
     * integration-connection status without depending on the optional
     * `manifest` field below.
     */
    integrations: AgentIntegrationEntry[];
  };
  input?: SchemaWrapper;
  output?: SchemaWrapper;
  config: SchemaWrapper & {
    current: Record<string, unknown>;
  };
  running_runs: number;
  last_run: {
    id: string;
    status: string;
    started_at: Date | string | null;
    duration: number | null;
  } | null;
  updatedAt: string | null;
  lock_version: number;
  prompt?: string;
  scope: string | null;
  version: string | null;
  manifest?: Record<string, unknown>; // Raw manifest from DB (user agents only)

  callback_url?: string;
  version_count?: number;
  has_unarchived_changes?: boolean;
  forked_from: string | null;
}

// --- Organization Package Types ---

export interface OrgPackageItem extends BasePackageListItem {
  /** Display name from the manifest, may be missing on legacy rows. */
  name: string | null;
  createdBy: string | null;
  created_by_name: string | null;
  createdAt: string;
  updatedAt: string;
  used_by_agents: number;
  auto_installed: boolean;
}

export interface OrgPackageItemDetail extends OrgPackageItem {
  content: string;
  /** Secondary source file content (e.g. .ts for tools). */
  source_code?: string | null;
  agents: { id: string; display_name: string }[];
  manifest?: Record<string, unknown>;
  manifest_name?: string | null;
  lock_version?: number;
  version_count?: number;
  has_unarchived_changes?: boolean;
}

// --- Model Cost Types ---

/**
 * Zod validator for {@link ModelCost} (the type itself lives in
 * `@appstrate/core/module`). `cacheRead` / `cacheWrite` are optional —
 * providers without prompt caching simply omit them.
 */
export const modelCostSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative().optional(),
  cacheWrite: z.number().nonnegative().optional(),
});

/**
 * Token usage as reported by an LLM provider for a single completion call.
 * Wire shape consumed by the runner-event ingestion route and any
 * cost-accounting consumer.
 */
export const tokenUsageSchema = z.object({
  input_tokens: z.number().nonnegative(),
  output_tokens: z.number().nonnegative(),
  cache_creation_input_tokens: z.number().nonnegative().optional(),
  cache_read_input_tokens: z.number().nonnegative().optional(),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

/**
 * In-place accumulator for {@link TokenUsage} totals.
 *
 * Adds every field of `addition` onto `total`. Optional fields default to
 * zero on both sides — `undefined` on `addition` is a no-op, and the
 * cache-creation / cache-read totals are coerced to a numeric zero on
 * `total` so subsequent reads always yield a number.
 */
export function accumulateTokenUsage(total: TokenUsage, addition: TokenUsage): void {
  total.input_tokens += addition.input_tokens ?? 0;
  total.output_tokens += addition.output_tokens ?? 0;
  total.cache_creation_input_tokens =
    (total.cache_creation_input_tokens ?? 0) + (addition.cache_creation_input_tokens ?? 0);
  total.cache_read_input_tokens =
    (total.cache_read_input_tokens ?? 0) + (addition.cache_read_input_tokens ?? 0);
}

// --- Package Version Types ---

interface PackageVersionInfo {
  id: number;
  version: string;
  integrity: string;
  artifact_size: number;
  yanked: boolean;
  createdAt: string;
}

/** Extended version info for list views (includes createdBy). */
export interface VersionListItem extends Omit<PackageVersionInfo, "createdAt"> {
  createdBy: string | null;
  createdAt: string | null;
}

/** Full version detail returned by the API. */
export interface VersionDetailResponse extends Omit<PackageVersionInfo, "createdAt"> {
  manifest: Record<string, unknown>;
  content?: string | null;
  /** Secondary source file content (e.g. .ts for tools). */
  source_code?: string | null;
  yanked_reason: string | null;
  createdAt: string | null;
  dist_tags: string[];
}

// --- Agent Memory Types ---

export type PersistenceActorType = "user" | "end_user" | "shared";

export interface AgentMemoryItem {
  id: number;
  content: string;
  runId: string | null;
  /** Actor scope of this memory row. `shared` = visible to all actors. */
  actor_type: PersistenceActorType;
  /** Actor identifier. NULL when `actor_type === "shared"`. */
  actor_id: string | null;
  /**
   * When true, this memory is rendered into the system prompt on every
   * run (working set). When false, it lives in the archive and is only
   * reachable via the `recall_memory` tool. See ADR-012.
   */
  pinned?: boolean;
  createdAt: string | null;
}

export interface AgentPinnedSlotItem {
  id: number;
  /**
   * Slot key (Letta-style label). The reserved key `"checkpoint"` is the
   * carry-over slot snapshotted onto runs.checkpoint; other keys (`"persona"`, `"goals"`, …) are
   * first-class named pinned blocks. See ADR-013.
   */
  key: string;
  /** Slot content — agent-defined JSON or string. */
  content: unknown;
  /** Run that wrote the latest snapshot, if any. */
  runId: string | null;
  actor_type: PersistenceActorType;
  actor_id: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

// --- Org Proxy Types ---

export interface OrgProxyInfo {
  id: string;
  label: string;
  urlPrefix: string;
  enabled: boolean;
  isDefault: boolean;
  source: "built-in" | "custom";
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// --- Org Model Types ---

/**
 * Canonical model-metadata fields shared across all three model shapes:
 * {@link CatalogModelEntry} (catalog defaults), {@link ModelDefinition}
 * (system-registry entry), and {@link OrgModelInfo} (wire shape).
 *
 * Capability surface uses the queryable split (`input` + `reasoning`) rather
 * than the flat `capabilities: string[]` array stored in the vendored JSON
 * files. The catalog loader projects from `capabilities` into these two fields
 * via `resolveCatalogDefaults()` in `org-models.ts` — the JSON files
 * themselves are not modified.
 */
export interface ModelMetadata {
  label?: string;
  contextWindow?: number | null;
  maxTokens?: number | null;
  /** Input modalities this model supports (e.g. `["text", "image"]`). */
  input?: string[] | null;
  /** Whether the model exposes a reasoning/thinking mode. */
  reasoning?: boolean | null;
  /** Per-1M-token pricing in USD. */
  cost?: ModelCost | null;
}

export interface OrgModelInfo extends ModelMetadata {
  id: string;
  /** Always set — resolvers fall back to catalog label then modelId. */
  label: string;
  apiShape: string;
  baseUrl: string;
  modelId: string;
  enabled: boolean;
  isDefault: boolean;
  source: "built-in" | "custom";
  credentialId: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Aggregated UI view of a model provider credential — combines env-driven
 * `SYSTEM_PROVIDER_KEYS` (source: "built-in") with the unified
 * `model_provider_credentials` table (source: "custom"). Never carries
 * plaintext. The shape is produced by `listOrgModelProviderCredentials()` —
 * keep it in lock-step with the service.
 */
export interface ModelProviderCredentialInfo {
  id: string;
  label: string;
  apiShape: string;
  baseUrl: string;
  source: "built-in" | "custom";
  /** Auth mode of the underlying credential (matches the registry vocabulary). */
  authMode: "api_key" | "oauth2";
  /** Set when `authMode === "oauth2"`. Canonical providerId backing the connection. */
  providerId?: string | null;
  /** Surface email of the OAuth account (extracted from the access-token identity claim). UI shows it as transparency hint. */
  oauthEmail?: string | null;
  /** True when the worker (or token-resolver) detected an `invalid_grant`. UI surfaces a "Reconnect" badge. */
  needsReconnection?: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Wire shape of `GET /api/model-provider-credentials/registry` — surfaces the
 * runtime `MODEL_PROVIDERS` registry to the UI so the model picker stays
 * data-driven (no hardcoded provider list client-side). Mirrors
 * {@link import("@appstrate/core/module").ModelProviderDefinition} with the
 * optional-fields normalised to nullable for wire clarity (and stripped of
 * the platform-internal `hooks` / `oauthWireFormat` blocks).
 */
export interface ProviderRegistryEntry {
  providerId: string;
  displayName: string;
  iconUrl: string;
  description: string | null;
  docsUrl: string | null;
  apiShape: string;
  defaultBaseUrl: string;
  baseUrlOverridable: boolean;
  authMode: "api_key" | "oauth2";
  /** Surface in the picker's "Featured" group. Module-supplied metadata. */
  featured: boolean;
  models: ProviderRegistryModelEntry[];
}

/**
 * Single curated-catalog entry — used both runtime-side (vendored LiteLLM
 * pricing files in `apps/api/src/data/pricing/*.json` consumed by
 * `pricing-catalog.ts`) and wire-side (the registry endpoint splices `id`
 * back in and tags `featured` per provider).
 *
 * `label` and `cost` are non-nullable: the vendoring script drops entries
 * without usable pricing, and labels are title-cased from the id at
 * vendoring time.
 */
export interface CatalogModelEntry {
  /** Human-readable label, derived from the id at vendoring time. */
  label: string;
  contextWindow: number;
  /** Provider-defined ceiling for the response. Null when unpublished. */
  maxTokens: number | null;
  capabilities: readonly string[];
  /** Per-1M-token pricing in USD. */
  cost: ModelCost;
}

/**
 * Wire shape of a single model in
 * `GET /api/model-provider-credentials/registry`. Surfaces the catalog
 * entry verbatim plus the provider-scoped `featured` flag (driven by
 * the provider's `featuredModels` whitelist) and the catalog id.
 */
export interface ProviderRegistryModelEntry extends CatalogModelEntry {
  id: string;
  /**
   * Surface in the picker's "Featured" group for this provider AND
   * auto-seed in `org_models` on first connection. Set when the model
   * id appears in the provider's `featuredModels` (see
   * `core-providers/index.ts` or any module's `modelProviders()`
   * contribution); the rest of the catalog falls under "All models".
   */
  featured: boolean;
}

// --- Connection Test Types ---

export interface TestResult {
  ok: boolean;
  latency: number;
  error?: string;
  message?: string;
}

// --- API Key Types ---

export interface ApiKeyInfo {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  createdBy: string | null;
  created_by_name?: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

// --- Application Types ---

export interface ApplicationInfo {
  id: string;
  name: string;
  isDefault: boolean;
  settings: { allowedRedirectDomains?: string[] };
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InstalledPackage {
  packageId: string;
  config: Record<string, unknown>;
  modelId: string | null;
  proxyId: string | null;
  versionId: number | null;
  enabled: boolean;
  installedAt: string;
  updatedAt: string;
  packageType: string;
  packageSource: string;
  draft_manifest: Record<string, unknown> | null;
}

/**
 * Per-application resolved run-config returned by
 * `GET /api/applications/{applicationId}/packages/{scope}/{name}/run-config`.
 * Single source of truth for both the dashboard's per-app agent run and
 * the CLI's `appstrate run @scope/agent` invocation — keeping them in
 * lockstep prevents UI ↔ CLI drift on model / proxy / version pin.
 */
export interface ResolvedRunConfig {
  config: Record<string, unknown>;
  modelId: string | null;
  proxyId: string | null;
  /** Pinned semver label (`1.2.3`), or null when the app uses the floating dist-tag. */
  version_pin: string | null;
}

// --- End-User Types ---

export interface EndUserInfo {
  id: string;
  object: "end_user";
  applicationId: string;
  name: string | null;
  email: string | null;
  externalId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface EndUserListResponse {
  object: "list";
  data: EndUserInfo[];
  hasMore: boolean;
  limit: number;
}

// --- OIDC Module — per-application auth config view types ---

// Wire shape for `/api/applications/:id/smtp-config` and
// `/api/applications/:id/social-providers/:provider`. Lives here so
// backend services, OpenAPI schemas, and frontend hooks stay in lockstep.

export type SocialProviderId = "google" | "github";

export interface SmtpConfigView {
  applicationId: string;
  host: string;
  port: number;
  username: string;
  fromAddress: string;
  fromName: string | null;
  secureMode: "auto" | "tls" | "starttls" | "none";
  createdAt: string;
  updatedAt: string;
}

export interface SocialProviderView {
  applicationId: string;
  provider: SocialProviderId;
  clientId: string;
  scopes: string[] | null;
  createdAt: string;
  updatedAt: string;
}
