export type {
  Profile,
  Execution,
  ExecutionLog,
  ConnectionProfile,
  UserFlowProfile,
  OrgProxy,
} from "@appstrate/db/schema";

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

// --- Execution Types ---

export type ExecutionStatus =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "timeout"
  | "cancelled";

// --- Schedule Types ---

export type { FlowSchedule as Schedule } from "@appstrate/db/schema";

// --- Organization Types ---

export type OrgRole = "owner" | "admin" | "member";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface OrganizationMember {
  orgId: string;
  userId: string;
  role: OrgRole;
  joinedAt: string;
  displayName?: string;
  email?: string;
}

export interface OrganizationWithRole extends Organization {
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

// --- JSON Schema Types ---

export interface JSONSchemaProperty {
  type: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  format?: string;
  placeholder?: string;
  accept?: string;
  maxSize?: number;
  multiple?: boolean;
  maxFiles?: number;
}

export interface JSONSchemaObject {
  type: "object";
  properties: Record<string, JSONSchemaProperty>;
  required?: string[];
  propertyOrder?: string[];
}

/** Return schema property keys respecting propertyOrder, with unlisted keys appended. */
export function getOrderedKeys(schema: JSONSchemaObject): string[] {
  const allKeys = Object.keys(schema.properties);
  if (!schema.propertyOrder?.length) return allKeys;
  const ordered = schema.propertyOrder.filter((k) => k in schema.properties);
  const rest = allKeys.filter((k) => !schema.propertyOrder!.includes(k));
  return rest.length ? [...ordered, ...rest] : ordered;
}

// --- User Connection Types ---

export interface UserConnectionOrg {
  id: string;
  name: string;
  status: "valid" | "needs_reconnection";
}

export interface UserConnectionItem {
  connectionId: string;
  providerId: string;
  authMode: string;
  scopesGranted: string[];
  connectedAt: string;
  profile: { id: string; name: string; isDefault: boolean };
  orgs: UserConnectionOrg[];
}

export interface ProviderDisplayInfo {
  displayName: string;
  logo: string;
}

export interface ServiceStatus {
  id: string;
  name?: string;
  provider: string;
  description: string;
  status: "connected" | "not_connected" | "needs_reconnection";
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
  tags: string[];
  requires: {
    services: string[];
    skills: string[];
    extensions: string[];
  };
  runningExecutions: number;
  source: "built-in" | "user";
}

export interface FlowDetail {
  id: string;
  displayName: string;
  description: string;
  schemaVersion: string;
  author: string;
  tags: string[];
  source: "built-in" | "user";
  requires: {
    services: ServiceStatus[];
    skills: { id: string; name?: string; description?: string }[];
    extensions: { id: string; name?: string; description?: string }[];
  };
  input?: {
    schema: JSONSchemaObject;
  };
  output?: {
    schema: JSONSchemaObject;
  };
  config: {
    schema: JSONSchemaObject;
    current: Record<string, unknown>;
  };
  runningExecutions: number;
  lastExecution: Partial<import("@appstrate/db/schema").Execution> | null;
  updatedAt?: string | null;
  prompt?: string;
  executionSettings?: { timeout?: number; outputRetries?: number } | null;
}

// --- Organization Library Types ---

export interface OrgSkill {
  id: string;
  name?: string | null;
  description?: string | null;
  source?: "built-in" | "user";
  createdBy?: string | null;
  createdByName?: string;
  createdAt: string;
  updatedAt: string;
  usedByFlows?: number;
}

export interface OrgSkillDetail extends OrgSkill {
  content: string;
  flows: { id: string; displayName: string }[];
}

export interface OrgExtension {
  id: string;
  name?: string | null;
  description?: string | null;
  source?: "built-in" | "user";
  createdBy?: string | null;
  createdByName?: string;
  createdAt: string;
  updatedAt: string;
  usedByFlows?: number;
}

export interface OrgExtensionDetail extends OrgExtension {
  content: string;
  flows: { id: string; displayName: string }[];
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

// --- Integration Types ---

export interface Integration {
  uniqueKey: string;
  provider: string;
  displayName: string;
  logo?: string;
  status: "connected" | "not_connected" | "needs_reconnection";
  authMode?: string;
  connectedAt?: string;
}

// --- Available Scope Types ---

export interface AvailableScope {
  value: string;
  label: string;
}

// --- Provider Config Types ---

export interface ProviderConfig {
  id: string;
  displayName: string;
  authMode: "oauth2" | "oauth1" | "api_key" | "basic" | "custom" | "proxy";
  source: "built-in" | "custom";
  hasClientId: boolean;
  hasClientSecret: boolean;
  authorizationUrl?: string;
  tokenUrl?: string;
  refreshUrl?: string;
  defaultScopes?: string[];
  scopeSeparator?: string;
  pkceEnabled?: boolean;
  tokenAuthMethod?: "client_secret_post" | "client_secret_basic";
  authorizationParams?: Record<string, string>;
  tokenParams?: Record<string, string>;
  credentialSchema?: Record<string, unknown>;
  credentialFieldName?: string;
  credentialHeaderName?: string;
  credentialHeaderPrefix?: string;
  iconUrl?: string;
  categories?: string[];
  docsUrl?: string;
  authorizedUris?: string[];
  allowAllUris?: boolean;
  availableScopes?: AvailableScope[];
  usedByFlows?: number;
}
