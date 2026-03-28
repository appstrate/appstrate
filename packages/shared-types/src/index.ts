export type { Profile, ExecutionLog, ConnectionProfile } from "@appstrate/db/schema";
import type {
  AuthMode,
  AvailableScope,
  PackageType,
  ProviderSetupGuide,
  ResolvedProviderDefinition,
} from "@appstrate/core/validation";
export type {
  AuthMode,
  AvailableScope,
  PackageType,
  ProviderSetupGuide,
  ResolvedProviderDefinition,
};

import type { Execution as _Execution } from "@appstrate/db/schema";
export type Execution = _Execution & { packageVersion?: string | null };

// --- App Config Types ---

export interface AppConfig {
  platform: "oss" | "cloud";
  features: {
    billing: boolean;
    models: boolean;
    providerKeys: boolean;
    googleAuth: boolean;
    githubAuth: boolean;
    smtp: boolean;
  };
  legalUrls?: {
    terms?: string;
    privacy?: string;
  };
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

// --- Execution Types ---

import { executionStatusEnum } from "@appstrate/db/schema";
export type ExecutionStatus = (typeof executionStatusEnum.enumValues)[number];

// --- Schedule Types ---

export type { PackageSchedule as Schedule } from "@appstrate/db/schema";

// --- Organization Types ---

import { orgRoleEnum } from "@appstrate/db/schema";
export type OrgRole = (typeof orgRoleEnum.enumValues)[number];

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

// --- JSON Schema Types (re-exported because FlowDetail/ProviderConfig reference them) ---

export type { JSONSchemaObject, SchemaWrapper } from "@appstrate/core/form";
import type { JSONSchemaObject, SchemaWrapper } from "@appstrate/core/form";

// --- Flow Readiness Utilities ---

/** Check if a prompt is empty or whitespace-only. */
export function isPromptEmpty(prompt: string): boolean {
  return prompt.trim().length === 0;
}

/**
 * Find IDs declared in `required` but missing from `installed`.
 * Works for both skills and tools.
 */
export function findMissingDependencies(
  required: Record<string, string>,
  installedIds: string[],
): string[] {
  const installed = new Set(installedIds);
  return Object.keys(required).filter((id) => !installed.has(id));
}

// --- Connection Status ---

export type ConnectionStatusValue = "connected" | "not_connected" | "needs_reconnection";

// --- User Connection Types ---

export interface UserConnectionEntry {
  connectionId: string;
  scopesGranted: string[];
  connectedAt: string;
  profile: { id: string; name: string; isDefault: boolean };
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

export interface ProviderStatus {
  id: string;
  name?: string;
  provider: string;
  description: string;
  status: ConnectionStatusValue;
  authMode?: string;
  connectUrl?: string;
  connectionMode?: "user" | "admin";
  adminProvided?: boolean;
  scopesRequired?: string[];
  scopesGranted?: string[];
  scopesSufficient?: boolean;
  scopesMissing?: string[];
}

export interface FlowListItem {
  id: string;
  displayName: string;
  description: string;
  schemaVersion: string;
  author: string;
  keywords: string[];
  dependencies: {
    providers: string[];
    skills: Record<string, string>;
    tools: Record<string, string>;
  };
  runningExecutions: number;
  source: "system" | "local";
  scope?: string | null;
  version?: string | null;
  type: PackageType;
  forkedFrom?: string | null;
}

export interface FlowDetail {
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
  runningExecutions: number;
  lastExecution: Partial<import("@appstrate/db/schema").Execution> | null;
  updatedAt?: string | null;
  lockVersion?: number;
  prompt?: string;
  scope?: string | null;
  version?: string | null;
  manifest?: Record<string, unknown>; // Raw manifest from DB (user flows only)

  populatedProviders?: Record<string, ProviderConfig>;
  callbackUrl?: string;
  versions?: PackageVersionInfo[];
  distTags?: DistTagInfo[];
  versionCount?: number;
  hasUnpublishedChanges?: boolean;
  forkedFrom?: string | null;
}

// --- Organization Package Types ---

export interface OrgPackageItem {
  id: string;
  name?: string | null;
  description?: string | null;
  source?: "system" | "local";
  createdBy?: string | null;
  createdByName?: string;
  createdAt: string;
  updatedAt: string;
  usedByFlows?: number;
  version?: string | null;
  autoInstalled?: boolean;
  forkedFrom?: string | null;
}

export interface OrgPackageItemDetail extends OrgPackageItem {
  content: string;
  flows: { id: string; displayName: string }[];
  manifest?: Record<string, unknown>;
  manifestName?: string | null;
  lockVersion?: number;

  versions?: PackageVersionInfo[];
  distTags?: DistTagInfo[];
  versionCount?: number;
  hasUnpublishedChanges?: boolean;
}

// --- Model Cost Types ---

/** Per-model pricing in $/M tokens. */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

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
  yankedReason: string | null;
  createdAt: string | null;
  distTags: string[];
}

export interface DistTagInfo {
  tag: string;
  version: string;
}

// --- Flow Memory Types ---

export interface FlowMemoryItem {
  id: number;
  content: string;
  executionId: string | null;
  createdAt: string | null;
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
  usedByFlows?: number;
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

// --- Webhook Types ---

export interface WebhookInfo {
  id: string;
  object: "webhook";
  scope: "organization" | "application";
  applicationId: string | null;
  url: string;
  events: string[];
  packageId: string | null;
  payloadMode: "full" | "summary";
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookCreateResponse extends WebhookInfo {
  secret: string;
}

export interface WebhookDelivery {
  id: string;
  eventId: string;
  eventType: string;
  status: "pending" | "success" | "failed";
  statusCode: number | null;
  latency: number | null;
  attempt: number;
  error: string | null;
  createdAt: string;
}
