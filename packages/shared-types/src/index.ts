// SPDX-License-Identifier: Apache-2.0

import type { z } from "zod";
import type { ModelCost } from "@appstrate/core/module";
import type { TokenUsage } from "@appstrate/core/token-usage";

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

/**
 * Stripe-canonical list envelope for HTTP list responses.
 *
 * Wire format: `{ object: "list", data: T[], hasMore: boolean, total?, limit? }`.
 * `total` is the full row count (offset pagination); `limit` is the page size
 * echoed by cursor-style endpoints (e.g. end-users). Both optional so every
 * list endpoint variant fits the single canonical shape.
 */
export interface ListEnvelope<T> {
  object: "list";
  data: T[];
  hasMore: boolean;
  total?: number;
  limit?: number;
}

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
  runNumber: number | null;
  token_usage: unknown;
  version_label: string | null;
  /**
   * Unambiguous reference to the agent definition the run executed (#636):
   * `"draft"` when the mutable draft ran with unpublished changes (or no
   * version was ever published), the concrete semver (e.g. `"2.1.0"`) when
   * the run executed that published definition (or a draft identical to it).
   */
  version_ref: string;
  proxy_label: string | null;
  model_label: string | null;
  model_source: string | null;
  runner_name: string | null;
  runner_kind: string | null;
  agent_scope: string | null;
  agent_name: string | null;
  // CASING: `runOrigin`/`contextSnapshot` are NOT in the documented universal
  // carve-out (id/*Id/createdAt/runNumber/…), so docs/CASING_CONVENTIONS.md
  // would nominally call for snake_case (`run_origin`/`context_snapshot`).
  // They are kept camelCase as a deliberate, known module carve-out: the wire
  // contract already emits camelCase across all three surfaces in lockstep —
  // the runtime mapper (services/state/runs.ts `toRunWireDto`), the OpenAPI
  // spec (openapi/schemas.ts + baseline.json), and the SPA consumers
  // (run-detail.tsx, run-row.tsx, api/schema.d.ts). Renaming here without
  // re-cutting the spec + regenerating the client would break the contract, so
  // this field name is intentionally left as-is.
  runOrigin: string | null;
  contextSnapshot: unknown;
  modelCredentialId: string | null;
  connection_overrides: unknown;
  /**
   * Per-run dependency version overrides (#666) — `{ "@scope/name": "draft" |
   * "<spec>" }`. Present when the caller opted a dependency out of the
   * published-only resolution; a non-null map (esp. with a `"draft"` value)
   * means the run is NOT reproducible from its `version_ref` alone.
   */
  dependency_overrides: unknown;
}

/**
 * One integration connection resolved for a run, projected from the internal
 * `runs.resolved_connections` snapshot for display. The raw `connectionId` is
 * deliberately omitted — only display-safe fields cross the wire.
 */
export interface RunConnectionUsed {
  /** Integration package id (`@scope/integration`). */
  integration_id: string;
  /** Connection label, denormalized at kickoff. Null on pre-snapshot runs. */
  label: string | null;
  /** Account identifier (email, sub), denormalized at kickoff. */
  account_id: string | null;
  /** Resolution mechanism (`admin_pin` | `run_override` | `fallback_auto` | …). */
  source: string;
}

/** Run with enriched display names from LEFT JOINs (dashboard user, end-user, API key, schedule). */
export type EnrichedRun = RunWireDto & {
  user_name: string | null;
  end_user_name: string | null;
  api_key_name: string | null;
  schedule_name: string | null;
  /** Connections resolved for this run, for the "connexions utilisées" panel. Null when the agent declares no integrations. */
  connections_used: RunConnectionUsed[] | null;
  /**
   * True when the requesting recipient has an unread notification for this run
   * (issue #667). Per-recipient: derived from the `notifications` table for the
   * current actor, so a dashboard user and an end-user see independent state.
   * Drives the unread dot on run rows and the per-schedule unread count.
   */
  unread: boolean;
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
  /**
   * Deployed build identity (APP_VERSION / GIT_SHA stamped into the image at
   * build time). Surfaced so the SPA can show which build is live. Absent on
   * source/dev runs → the UI falls back to "dev".
   */
  version?: {
    app: string;
    commit?: string;
  };
}

// --- Package Types ---

/** A reference to a skill, mcp-server, or integration dependency with optional metadata. */
export interface ResourceEntry {
  id: string;
  version?: string;
  name?: string;
  description?: string;
  /**
   * Niveau 2 — agent's tool allowlist for an integration dependency.
   * Drives sidecar `tools/list` filtering and OAuth scope inference.
   * `undefined` keeps legacy "all tools allowed" semantics. The AFPS §4.4
   * wildcard literal `"*"` opts the agent into every upstream tool (only
   * valid when the integration declares `allow_undeclared_tools: true`,
   * §7.8). Ignored for non-integration resource types.
   */
  tools?: string[] | "*";
  /**
   * Niveau 2 — agent's explicit OAuth scope escape hatch for an
   * integration dependency, unioned with scopes inferred from `tools`.
   * `undefined` defaults to "none beyond inference". Ignored for
   * non-integration resource types.
   */
  scopes?: string[];
  /**
   * When the depended-on integration declares multiple auth methods,
   * selects which `auths.<key>` entry this agent dependency uses.
   * AFPS §4.1. `undefined` keeps the runtime's existing resolver
   * cascade behaviour (any accessible connection on the integration).
   * Ignored for non-integration resource types.
   */
  auth_key?: string;
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
  enabled: boolean;
  cron_expression: string;
  timezone: string | null;
  input: Record<string, unknown> | null;
  config_override: Record<string, unknown> | null;
  model_id_override: string | null;
  proxy_id_override: string | null;
  version_override: string | null;
  connection_overrides: Record<string, string> | null;
  dependency_overrides: Record<string, string> | null;
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

import type { orgSettingsSchema } from "@appstrate/core/permissions";
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
  identity: string;
  /** Which auth slot this connection satisfies. */
  auth_key: string;
  /** Admin/owner sharing toggle (per-org). */
  shared_with_org: boolean;
  /**
   * Number of installed agents in this connection's application that
   * declare this integration in their dependencies. Used by the UI to
   * surface "reused by N agents" so members understand that the connection
   * is shared across the org's agents rather than per-agent.
   */
  reused_by_agents: number;
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
  source: "system" | "local";
  version: string | null;
  // `description`/`scope`/`forked_from` are emitted by some package shapes but
  // not others (the agent list omits `forked_from`; the org-package list omits
  // `scope`; manifest-derived `description` may be absent), so they are
  // optional at the base and re-required on the concrete shapes that always
  // emit them.
  description?: string | null;
  scope?: string | null;
  forked_from?: string | null;
}

export interface AgentListItem extends BasePackageListItem {
  display_name?: string;
  schema_version?: string;
  author?: string;
  keywords: string[];
  dependencies: {
    skills?: Record<string, string>;
    mcp_servers?: Record<string, string>;
    integrations?: Record<string, string>;
  };
  running_runs: number;
  type: PackageType;
  /** Always emitted by the agent-list mapper (`@scope` or null). */
  scope: string | null;
}

export interface AgentDetail {
  id: string;
  /** Manifest-derived; may be absent (the SPA falls back to the id). */
  display_name?: string;
  description?: string;
  source: "system" | "local";
  dependencies: {
    // `version`/`name`/`description` are emitted only when present on the
    // manifest skill ref (handler spreads them conditionally) — AFPS §4.1.
    skills: { id: string; version?: string; name?: string; description?: string }[];
    /** AFPS §4.1 mcp_servers dependency group (`{ id, version }` per entry). */
    mcp_servers: { id: string; version: string }[];
    /**
     * Niveau 2 — agent's integration declarations (`dependencies.integrations`
     * + `integrations_configuration`) flattened by `parseManifestIntegrations`.
     * Always populated (system + user
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
    /** `runs.started_at` is NOT NULL (defaultNow); Date server-side, ISO string on the wire. */
    started_at: Date | string;
    duration: number | null;
  } | null;
  /** Omitted for system agents (the SPA treats absence as "no timestamp"). */
  updatedAt?: string | null;
  /** Omitted for system agents — absence means "no optimistic-lock token". */
  lock_version?: number;
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
  /** Always a string — `getPackageDisplayName` falls back to the package id. */
  name: string;
  /** Always emitted by the org-package list/detail mappers. */
  description: string | null;
  forked_from: string | null;
  created_by: string | null;
  /** Omitted when the creating user is unknown. */
  created_by_name?: string | null;
  createdAt: string;
  updatedAt: string;
  used_by_agents: number;
  auto_installed: boolean;
}

// The detail endpoint does not emit the list-only `used_by_agents`, so it is
// dropped from the base via Omit (a sub-interface can't loosen a required
// field to optional).
export interface OrgPackageItemDetail extends Omit<OrgPackageItem, "used_by_agents"> {
  /** Present but nullable — the draft_content column is nullable. */
  content: string | null;
  /** Secondary source file content (e.g. .ts for tools). */
  source_code?: string | null;
  agents: { id: string; display_name: string }[];
  manifest?: Record<string, unknown>;
  manifest_name?: string | null;
  lock_version?: number;
  version_count?: number;
  has_unarchived_changes?: boolean;
}

// --- Token Usage Types ---

export type { TokenUsage };

// --- Package Version Types ---

interface PackageVersionInfo {
  id: number;
  version: string;
  integrity: string;
  artifact_size: number;
  yanked: boolean;
  createdAt: string;
}

/** Extended version info for list views (includes created_by). */
export interface VersionListItem extends Omit<PackageVersionInfo, "createdAt"> {
  created_by: string | null;
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
   * reachable via the `recall_memory` tool.
   */
  pinned?: boolean;
  createdAt: string | null;
}

export interface AgentPinnedSlotItem {
  id: number;
  /**
   * Slot key (Letta-style label). The reserved key `"checkpoint"` is the
   * carry-over slot snapshotted onto runs.checkpoint; other keys (`"persona"`, `"goals"`, …) are
   * first-class named pinned blocks.
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
  is_default: boolean;
  source: "built-in" | "custom";
  created_by: string | null;
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
  /**
   * Real binding fields. `null` for model aliases ({@link aliased} true) — the
   * GET projection strips the backing so a dashboard user never learns the
   * provider/endpoint/upstream id behind the alias. Always set otherwise.
   */
  apiShape: string | null;
  /**
   * The credential's provider id (e.g. `anthropic`, `claude-code`, `codex`).
   * Distinguishes subscription providers that share an `apiShape` with an
   * API-key provider (`claude-code` vs `anthropic`, both `anthropic-messages`)
   * — clients route them to the right proxy path. `null` for model aliases
   * (part of the stripped backing, same as {@link apiShape}).
   */
  providerId: string | null;
  /**
   * The provider's human display name resolved from the model-provider
   * registry by {@link providerId} (e.g. `OpenCode Go`, `OpenAI`). The single
   * authoritative label for grouping/badging a model by provider — `apiShape`
   * is ambiguous (OpenCode Go and OpenAI both use `openai-completions`), so
   * clients must NOT derive a provider label from it. `null` for model aliases
   * (part of the stripped backing) and for any row whose `providerId` has no
   * registry entry (custom providers).
   */
  providerName: string | null;
  baseUrl: string | null;
  modelId: string | null;
  enabled: boolean;
  is_default: boolean;
  /**
   * Model-alias flag (LLM-gateway alias pattern). When true, the `id` is a
   * public alias; user-facing surfaces strip the real binding (`modelId`,
   * `apiShape`, `baseUrl`, `credentialId`, capabilities/cost). Clients render
   * an alias badge and never learn the backing model.
   */
  aliased: boolean;
  /**
   * Display icon key for the UI. A {@link PROVIDER_ICONS} key (e.g. `anthropic`,
   * `openai`) the client renders directly — decoupled from the backing
   * provider. Set deliberately on an alias (`SYSTEM_PROVIDER_KEYS` model entry)
   * so an aliased model can show an icon without exposing its hidden binding;
   * `null` means the client falls back to resolving the icon from the real
   * `apiShape`/`baseUrl` (non-aliased models) or shows a generic alias icon.
   */
  iconUrl: string | null;
  source: "built-in" | "custom";
  /** `null` for model aliases — see {@link apiShape}. */
  credentialId: string | null;
  created_by: string | null;
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
  /**
   * Protocol family + endpoint. Both `null` for a **built-in** credential
   * whose every backing model is a model alias (issue #727): exposing the
   * endpoint host (e.g. `api.anthropic.com`) would reveal the hidden backing
   * provider to an org admin who can read credentials but did not configure
   * the env key. Custom credentials always carry them (the admin configured
   * the binding themselves).
   */
  apiShape: string | null;
  baseUrl: string | null;
  source: "built-in" | "custom";
  /** Auth mode of the underlying credential (matches the registry vocabulary). */
  authMode: "api_key" | "oauth2";
  /** Set when `authMode === "oauth2"`. Canonical providerId backing the connection. */
  providerId?: string | null;
  /** Surface email of the OAuth account (extracted from the access-token identity claim). UI shows it as transparency hint. */
  oauth_email?: string | null;
  /** True when the worker (or token-resolver) detected an `invalid_grant`. UI surfaces a "Reconnect" badge. */
  needs_reconnection?: boolean;
  /**
   * Model ids empirically verified against this credential by the
   * discovery probe — the server-side authorization record gating model
   * seeding. Per-credential because availability depends on the account's
   * plan. NULL/absent = never probed.
   */
  available_model_ids?: string[] | null;
  created_by: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Wire shape of `GET /api/model-provider-credentials/registry` — surfaces the
 * runtime `MODEL_PROVIDERS` registry to the UI so the model picker stays
 * data-driven (no hardcoded provider list client-side). Mirrors
 * {@link import("@appstrate/core/module").ModelProviderDefinition} with the
 * optional-fields normalised to nullable for wire clarity (and stripped of
 * the platform-internal `hooks` block).
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
  /** Upstream HTTP status when the provider answered at all — lets callers distinguish 429 (retry later) from 404 (model not served). */
  status?: number;
}

// --- API Key Types ---

export interface ApiKeyInfo {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  created_by: string | null;
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
  created_by: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InstalledPackage {
  packageId: string;
  config: Record<string, unknown>;
  modelId: string | null;
  proxyId: string | null;
  version_id: number | null;
  enabled: boolean;
  installed_at: string;
  updatedAt: string;
  package_type: string;
  package_source: string;
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

// --- OIDC Module — per-application auth config view types ---
//
// These OIDC-module-owned wire types live in ./oidc.ts (the frontend cannot
// cross the module boundary to import from the API). Re-exported here so
// existing importers keep working.

export type { SocialProviderId, SmtpConfigView, SocialProviderView } from "./oidc.ts";

// --- Realtime SSE event schemas (shared server↔client source of truth) ---
//
// Zod schemas + inferred types for every typed SSE frame, validated on emit
// (apps/api/src/services/realtime.ts) and on receipt (apps/web realtime hooks).
export {
  runUpdateEventSchema,
  runLogEventSchema,
  runMetricEventSchema,
  connectionUpdateEventSchema,
  chatSessionUpdateEventSchema,
  runUpdateToRunPatch,
} from "./realtime-events.ts";
export type {
  RunUpdateEvent,
  RunLogEvent,
  RunMetricEvent,
  ConnectionUpdateEvent,
  ChatSessionUpdateEvent,
  RealtimeEvent,
} from "./realtime-events.ts";
