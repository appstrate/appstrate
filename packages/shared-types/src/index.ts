// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

export type { WebhookInfo, WebhookCreateResponse, WebhookDelivery } from "./webhooks.ts";

export type { Profile, RunLog, ConnectionProfile } from "@appstrate/db/schema";
import type {
  PackageType,
  ProviderSetupGuide,
  ResolvedProviderDefinition,
} from "@appstrate/core/validation";
export type { PackageType };

export type { Run } from "@appstrate/db/schema";

import type { Run } from "@appstrate/db/schema";

/** Run with enriched display names from LEFT JOINs (dashboard user, end-user, API key, schedule). */
export type EnrichedRun = Run & {
  dashboardUserName: string | null;
  endUserName: string | null;
  apiKeyName: string | null;
  scheduleName: string | null;
  /** True if the run's source package is an inline/ephemeral shadow (POST /api/runs/inline). */
  packageEphemeral?: boolean;
  /** For inline runs only — snapshot of the manifest submitted at run time. Null after compaction. */
  inlineManifest?: Record<string, unknown> | null;
  /** For inline runs only — snapshot of the prompt submitted at run time. Null after compaction. */
  inlinePrompt?: string | null;
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

/** A reference to a skill or tool dependency with optional metadata. */
export interface ResourceEntry {
  id: string;
  version?: string;
  name?: string;
  description?: string;
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

export interface ScheduleReadiness {
  status: "ready" | "degraded" | "not_ready";
  totalProviders: number;
  connectedProviders: number;
  missingProviders: string[];
}

export type EnrichedSchedule = Schedule & {
  profileName: string | null;
  profileType: "user" | "app" | null;
  profileOwnerName: string | null;
  readiness: ScheduleReadiness;
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

import type { JSONSchemaObject, SchemaWrapper } from "@appstrate/core/form";

// --- Connection Types ---

/** Connection record as returned by the API (no encrypted credentials). */
export interface ConnectionInfo {
  id: string;
  profileId: string;
  providerId: string;
  orgId: string;
  scopesGranted?: string[];
  needsReconnection: boolean;
  createdAt: string;
  updatedAt: string;
}

export type { ConnectionStatusValue } from "@appstrate/db/schema";
import type { ConnectionStatusValue } from "@appstrate/db/schema";

// --- Org Profile Binding Types ---

export interface EnrichedBinding {
  providerId: string;
  sourceProfileId: string;
  sourceProfileName: string;
  boundByUserName: string | null;
  connected: boolean;
}

// --- User Connection Types ---

export interface UserConnectionEntry {
  connectionId: string;
  scopesGranted: string[];
  connectedAt: string;
  profile: { id: string; name: string; isDefault: boolean };
  application: { id: string; name: string };
}

export interface UserConnectionOrgGroup {
  orgId: string;
  orgName: string;
  connections: UserConnectionEntry[];
}

export interface UserConnectionProviderGroup {
  providerId: string;
  displayName: string;
  logo: string;
  totalConnections: number;
  orgs: UserConnectionOrgGroup[];
}

export type { ProviderProfileSource } from "@appstrate/db/schema";
import type { ProviderProfileSource } from "@appstrate/db/schema";

export interface ProviderStatus {
  id: string;
  name?: string;
  provider: string;
  description: string;
  status: ConnectionStatusValue;
  authMode?: string;
  connectUrl?: string;
  scopesRequired?: string[];
  scopesGranted?: string[];
  scopesSufficient?: boolean;
  scopesMissing?: string[];
  /** How the connection profile was resolved — "app_binding" if via app profile delegation, "user_profile" if via personal profile. */
  source: ProviderProfileSource | null;
  /** Name of the connection profile used for this provider. */
  profileName: string | null;
  /** Name of the user who owns the connection profile. */
  profileOwnerName: string | null;
}

export type { RunProviderSnapshot } from "@appstrate/db/schema";

/**
 * Fields shared by every package row when listed (agent or skill/tool/provider).
 * Concrete list shapes (`AgentListItem`, `OrgPackageItem`) extend this with
 * what their respective list endpoints additionally return.
 */
export interface BasePackageListItem {
  id: string;
  description: string | null;
  source: "system" | "local";
  scope: string | null;
  version: string | null;
  forkedFrom: string | null;
}

export interface AgentListItem extends BasePackageListItem {
  displayName: string;
  schemaVersion: string;
  author: string;
  keywords: string[];
  dependencies: {
    providers: string[];
    skills: Record<string, string>;
    tools: Record<string, string>;
  };
  runningRuns: number;
  type: PackageType;
  /** Always non-null on agents — narrowed for ergonomics. */
  description: string;
}

export interface AgentDetail {
  id: string;
  displayName: string;
  description: string;
  source: "system" | "local";
  dependencies: {
    providers: ProviderStatus[];
    skills: { id: string; version: string; name?: string; description?: string }[];
    tools: { id: string; version: string; name?: string; description?: string }[];
  };
  input?: SchemaWrapper;
  output?: SchemaWrapper;
  config: SchemaWrapper & {
    current: Record<string, unknown>;
  };
  runningRuns: number;
  lastRun: Partial<import("@appstrate/db/schema").Run> | null;
  updatedAt: string | null;
  lockVersion: number;
  prompt?: string;
  scope: string | null;
  version: string | null;
  manifest?: Record<string, unknown>; // Raw manifest from DB (user agents only)

  populatedProviders?: Record<string, ProviderConfig>;
  callbackUrl?: string;
  /** App profile ID configured for this agent. Used for per-provider app bindings. */
  agentAppProfileId: string | null;
  agentAppProfileName: string | null;
  versionCount?: number;
  hasUnarchivedChanges?: boolean;
  forkedFrom: string | null;
}

// --- Organization Package Types ---

export interface OrgPackageItem extends BasePackageListItem {
  /** Display name from the manifest, may be missing on legacy rows. */
  name: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  usedByAgents: number;
  autoInstalled: boolean;
}

export interface OrgPackageItemDetail extends OrgPackageItem {
  content: string;
  /** Secondary source file content (e.g. .ts for tools). */
  sourceCode?: string | null;
  agents: { id: string; displayName: string }[];
  manifest?: Record<string, unknown>;
  manifestName?: string | null;
  lockVersion?: number;
  versionCount?: number;
  hasUnarchivedChanges?: boolean;
}

// --- Model Cost Types ---

/** Per-model pricing in $/M tokens (margin included). */
export const modelCostSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
});
export type ModelCost = z.infer<typeof modelCostSchema>;

// --- Package Version Types ---

interface PackageVersionInfo {
  id: number;
  version: string;
  integrity: string;
  artifactSize: number;
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
  sourceCode?: string | null;
  yankedReason: string | null;
  createdAt: string | null;
  distTags: string[];
}

// --- Agent Memory Types ---

export type PersistenceActorType = "user" | "end_user" | "shared";

export interface AgentMemoryItem {
  id: number;
  content: string;
  runId: string | null;
  /** Actor scope of this memory row. `shared` = visible to all actors. */
  actorType: PersistenceActorType;
  /** Actor identifier. NULL when `actorType === "shared"`. */
  actorId: string | null;
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
  actorType: PersistenceActorType;
  actorId: string | null;
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

export interface OrgModelInfo {
  id: string;
  label: string;
  api: string;
  baseUrl: string;
  modelId: string;
  input?: string[] | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
  reasoning?: boolean | null;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  enabled: boolean;
  isDefault: boolean;
  source: "built-in" | "custom";
  providerKeyId: string;
  providerKeyLabel: string | null;
  /**
   * Anthropic-only: shape of the upstream credential, exposed so the CLI
   * can drive pi-ai's local OAuth detection. `oauth` for `sk-ant-oat-…`
   * tokens (Anthropic gates these to Claude-Code identity at the body
   * level — system prompt + tool-name renaming — which pi-ai injects
   * locally only when its prefix-based detection fires); `api-key` for
   * regular `sk-ant-…` keys; null for non-Anthropic protocols and for
   * Anthropic models whose credentials cannot be loaded (treat as
   * api-key). The CLI mirrors the kind by passing `sk-ant-oat-placeholder`
   * as the `apiKey` to pi-ai when `keyKind === "oauth"`, so pi-ai
   * reshapes the body before the proxy ever sees it.
   */
  keyKind?: "oauth" | "api-key" | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrgProviderKeyInfo {
  id: string;
  label: string;
  api: string;
  baseUrl: string;
  source: "built-in" | "custom";
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
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
  createdByName?: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

// --- Available Provider Types ---

export interface AvailableProvider {
  uniqueKey: string;
  provider: string;
  displayName: string;
  logo?: string;
  status: ConnectionStatusValue;
  authMode?: string;
  connectionId?: string;
  connectedAt?: string;
  scopesGranted?: string[];
}

// --- Provider Config Types ---

/** Provider config returned by the API — extends core's resolved definition with UI state. */
export interface ProviderConfig extends Omit<
  ResolvedProviderDefinition,
  "authorizationParams" | "tokenParams"
> {
  version?: string;
  description?: string;
  author?: string;
  source: "built-in" | "custom";
  hasCredentials: boolean;
  enabled: boolean;
  adminCredentialSchema?: JSONSchemaObject;
  setupGuide?: ProviderSetupGuide;
  tokenAuthMethod?: "client_secret_post" | "client_secret_basic";
  authorizationParams?: Record<string, string>;
  tokenParams?: Record<string, string>;
  credentialSchema?: Record<string, unknown>;
  usedByAgents?: number;
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
  appProfileId: string | null;
  versionId: number | null;
  enabled: boolean;
  installedAt: string;
  updatedAt: string;
  packageType: string;
  packageSource: string;
  draftManifest: Record<string, unknown> | null;
}

/**
 * Per-application resolved run-config returned by
 * `GET /api/applications/{appId}/packages/{scope}/{name}/run-config`.
 * Single source of truth for both the dashboard's per-app agent run and
 * the CLI's `appstrate run @scope/agent` invocation — keeping them in
 * lockstep prevents UI ↔ CLI drift on model / proxy / version pin.
 */
export interface ResolvedRunConfig {
  config: Record<string, unknown>;
  modelId: string | null;
  proxyId: string | null;
  /** Pinned semver label (`1.2.3`), or null when the app uses the floating dist-tag. */
  versionPin: string | null;
  /** Provider ids declared as dependencies on the package's manifest. */
  requiredProviders: string[];
}

// --- Readiness Types (agent preflight) ---

/**
 * Provider readiness reasons — single source of truth shared between the
 * API service that computes them, the CLI that consumes them, and the
 * OpenAPI enum on `GET /api/agents/{scope}/{name}/readiness`.
 */
export const READINESS_REASONS = [
  "no_connection",
  "needs_reconnection",
  "scope_insufficient",
  "provider_not_enabled",
] as const;
export type ReadinessReason = (typeof READINESS_REASONS)[number];

export interface ReadinessProviderEntry {
  providerId: string;
  profileId: string | null;
  reason: ReadinessReason;
  message: string;
}

export interface ReadinessReport {
  ready: boolean;
  missing: ReadinessProviderEntry[];
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
