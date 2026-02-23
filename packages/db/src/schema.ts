import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  numeric,
  serial,
  uuid,
  pgEnum,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";
import { sql, type InferSelectModel, type InferInsertModel } from "drizzle-orm";

// ────────────────────────────────────────────────────────────
// Enums
// ────────────────────────────────────────────────────────────

export const orgRoleEnum = pgEnum("org_role", ["owner", "admin", "member"]);

export const executionStatusEnum = pgEnum("execution_status", [
  "pending",
  "running",
  "success",
  "failed",
  "timeout",
  "cancelled",
]);

export const authModeEnum = pgEnum("auth_mode", ["oauth2", "api_key", "basic", "custom"]);

// ────────────────────────────────────────────────────────────
// Better Auth tables (managed by Better Auth)
// We define them here so Drizzle knows about them for
// relational queries and migrations.
// ────────────────────────────────────────────────────────────

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ────────────────────────────────────────────────────────────
// 1. Organizations & membership
// ────────────────────────────────────────────────────────────

export const organizations = pgTable("organizations", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").unique().notNull(),
  createdBy: text("created_by").references(() => user.id),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const organizationMembers = pgTable(
  "organization_members",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: orgRoleEnum("role").notNull().default("member"),
    joinedAt: timestamp("joined_at").defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.userId] }),
    index("idx_organization_members_user_id").on(table.userId),
  ],
);

// ────────────────────────────────────────────────────────────
// 2. Profiles (extends user)
// ────────────────────────────────────────────────────────────

export const profiles = pgTable(
  "profiles",
  {
    id: text("id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    displayName: text("display_name"),
    language: text("language").notNull().default("fr"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [check("language_check", sql`${table.language} IN ('fr', 'en')`)],
);

// ────────────────────────────────────────────────────────────
// 3. Flow configs (org-scoped)
// ────────────────────────────────────────────────────────────

export const flowConfigs = pgTable(
  "flow_configs",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    flowId: text("flow_id").notNull(),
    config: jsonb("config").notNull().default({}),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.flowId] }),
    index("idx_flow_configs_org_id").on(table.orgId),
  ],
);

// ────────────────────────────────────────────────────────────
// 4. User-imported flows
// ────────────────────────────────────────────────────────────

export const flows = pgTable(
  "flows",
  {
    id: text("id").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    manifest: jsonb("manifest").notNull(),
    prompt: text("prompt").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_flows_org_id").on(table.orgId),
    check("flows_id_slug", sql`${table.id} ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'`),
  ],
);

// ────────────────────────────────────────────────────────────
// 5. Flow versions (audit trail)
// ────────────────────────────────────────────────────────────

export const flowVersions = pgTable(
  "flow_versions",
  {
    id: serial("id").primaryKey(),
    flowId: text("flow_id").notNull(), // No FK: preserve history after deletion
    versionNumber: integer("version_number").notNull(),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    uniqueIndex("flow_versions_flow_version_unique").on(table.flowId, table.versionNumber),
    index("idx_flow_versions_flow_id").on(table.flowId, table.versionNumber),
  ],
);

// ────────────────────────────────────────────────────────────
// 6. Executions (org-scoped, per-user)
// ────────────────────────────────────────────────────────────

export const executions = pgTable(
  "executions",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    status: executionStatusEnum("status").notNull().default("pending"),
    input: jsonb("input"),
    result: jsonb("result"),
    state: jsonb("state"),
    error: text("error"),
    tokensUsed: integer("tokens_used"),
    tokenUsage: jsonb("token_usage"),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
    startedAt: timestamp("started_at").defaultNow(),
    completedAt: timestamp("completed_at"),
    duration: integer("duration"),
    scheduleId: text("schedule_id"),
    flowVersionId: integer("flow_version_id").references(() => flowVersions.id),
  },
  (table) => [
    index("idx_executions_flow_id").on(table.flowId),
    index("idx_executions_status").on(table.status),
    index("idx_executions_user_id").on(table.userId),
    index("idx_executions_org_id").on(table.orgId),
  ],
);

// ────────────────────────────────────────────────────────────
// 7. Execution logs
// ────────────────────────────────────────────────────────────

export const executionLogs = pgTable(
  "execution_logs",
  {
    id: serial("id").primaryKey(),
    executionId: text("execution_id")
      .notNull()
      .references(() => executions.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    type: text("type").notNull().default("progress"),
    event: text("event"),
    message: text("message"),
    data: jsonb("data"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_execution_logs_execution_id").on(table.executionId),
    index("idx_execution_logs_lookup").on(table.executionId, table.id),
    index("idx_execution_logs_user_id").on(table.userId),
    index("idx_execution_logs_org_id").on(table.orgId),
  ],
);

// ────────────────────────────────────────────────────────────
// 8. Flow schedules (org-scoped, per-user)
// ────────────────────────────────────────────────────────────

export const flowSchedules = pgTable(
  "flow_schedules",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name"),
    enabled: boolean("enabled").default(true),
    cronExpression: text("cron_expression").notNull(),
    timezone: text("timezone").default("UTC"),
    input: jsonb("input"),
    lastRunAt: timestamp("last_run_at"),
    nextRunAt: timestamp("next_run_at"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("idx_schedules_flow_id").on(table.flowId),
    index("idx_schedules_user_id").on(table.userId),
    index("idx_flow_schedules_org_id").on(table.orgId),
  ],
);

// ────────────────────────────────────────────────────────────
// 9. Schedule runs (distributed lock deduplication)
// ────────────────────────────────────────────────────────────

export const scheduleRuns = pgTable(
  "schedule_runs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => flowSchedules.id, { onDelete: "cascade" }),
    fireTime: timestamp("fire_time").notNull(),
    executionId: text("execution_id").references(() => executions.id, { onDelete: "set null" }),
    instanceId: text("instance_id"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    uniqueIndex("schedule_runs_unique").on(table.scheduleId, table.fireTime),
    index("idx_schedule_runs_created_at").on(table.createdAt),
  ],
);

// ────────────────────────────────────────────────────────────
// 10. Share tokens
// ────────────────────────────────────────────────────────────

export const shareTokens = pgTable(
  "share_tokens",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    token: text("token").notNull().unique(),
    flowId: text("flow_id").notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    executionId: text("execution_id").references(() => executions.id, { onDelete: "set null" }),
    consumedAt: timestamp("consumed_at"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("idx_share_tokens_token").on(table.token),
    index("idx_share_tokens_flow_id").on(table.flowId),
    index("idx_share_tokens_org_id").on(table.orgId),
  ],
);

// ────────────────────────────────────────────────────────────
// 11. Flow admin connections
// ────────────────────────────────────────────────────────────

export const flowAdminConnections = pgTable(
  "flow_admin_connections",
  {
    flowId: text("flow_id").notNull(),
    serviceId: text("service_id").notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    adminUserId: text("admin_user_id")
      .notNull()
      .references(() => user.id),
    connectedAt: timestamp("connected_at").defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.flowId, table.serviceId] }),
    index("idx_flow_admin_connections_flow_id").on(table.flowId),
    index("idx_flow_admin_connections_org_id").on(table.orgId),
  ],
);

// ────────────────────────────────────────────────────────────
// 12. Organization library: skills & extensions
// ────────────────────────────────────────────────────────────

export const orgSkills = pgTable(
  "org_skills",
  {
    id: text("id").notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name"),
    description: text("description"),
    content: text("content").notNull(),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.id] })],
);

export const orgExtensions = pgTable(
  "org_extensions",
  {
    id: text("id").notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name"),
    description: text("description"),
    content: text("content").notNull(),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.id] })],
);

export const flowSkills = pgTable(
  "flow_skills",
  {
    flowId: text("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    skillId: text("skill_id").notNull(),
    orgId: uuid("org_id").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.flowId, table.skillId] }),
    index("idx_flow_skills_org_skill").on(table.orgId, table.skillId),
  ],
);

export const flowExtensions = pgTable(
  "flow_extensions",
  {
    flowId: text("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    extensionId: text("extension_id").notNull(),
    orgId: uuid("org_id").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.flowId, table.extensionId] }),
    index("idx_flow_extensions_org_ext").on(table.orgId, table.extensionId),
  ],
);

// ────────────────────────────────────────────────────────────
// 13. Provider configs (connection manager)
// ────────────────────────────────────────────────────────────

export const providerConfigs = pgTable(
  "provider_configs",
  {
    id: text("id").notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    authMode: authModeEnum("auth_mode").notNull(),
    displayName: text("display_name").notNull(),
    // OAuth2 fields (encrypted)
    clientIdEncrypted: text("client_id_encrypted"),
    clientSecretEncrypted: text("client_secret_encrypted"),
    authorizationUrl: text("authorization_url"),
    tokenUrl: text("token_url"),
    refreshUrl: text("refresh_url"),
    defaultScopes: text("default_scopes")
      .array()
      .default(sql`'{}'::text[]`),
    scopeSeparator: text("scope_separator").default(" "),
    pkceEnabled: boolean("pkce_enabled").default(true),
    authorizationParams: jsonb("authorization_params").default({}),
    tokenParams: jsonb("token_params").default({}),
    // Credential fields
    credentialSchema: jsonb("credential_schema"),
    credentialFieldName: text("credential_field_name"),
    credentialHeaderName: text("credential_header_name"),
    credentialHeaderPrefix: text("credential_header_prefix"),
    // Available scopes
    availableScopes: jsonb("available_scopes").default([]),
    // URI restrictions
    authorizedUris: text("authorized_uris")
      .array()
      .default(sql`'{}'::text[]`),
    allowAllUris: boolean("allow_all_uris").default(false),
    // Common
    iconUrl: text("icon_url"),
    categories: text("categories")
      .array()
      .default(sql`'{}'::text[]`),
    docsUrl: text("docs_url"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.id] })],
);

// ────────────────────────────────────────────────────────────
// 14. Service connections (unified credential storage)
// ────────────────────────────────────────────────────────────

export const serviceConnections = pgTable(
  "service_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    flowId: text("flow_id"),
    authMode: authModeEnum("auth_mode").notNull(),
    credentialsEncrypted: text("credentials_encrypted").notNull(),
    scopesGranted: text("scopes_granted")
      .array()
      .default(sql`'{}'::text[]`),
    expiresAt: timestamp("expires_at"),
    rawTokenResponse: jsonb("raw_token_response"),
    connectionConfig: jsonb("connection_config").default({}),
    metadata: jsonb("metadata").default({}),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_service_connections_unique").on(
      table.orgId,
      table.userId,
      table.providerId,
      sql`COALESCE(${table.flowId}, '__global__')`,
    ),
    index("idx_service_connections_org_user").on(table.orgId, table.userId),
    index("idx_service_connections_provider").on(table.orgId, table.providerId),
  ],
);

// ────────────────────────────────────────────────────────────
// 15. OAuth states (short-lived)
// ────────────────────────────────────────────────────────────

export const oauthStates = pgTable(
  "oauth_states",
  {
    state: text("state").primaryKey(),
    orgId: uuid("org_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    codeVerifier: text("code_verifier").notNull(),
    scopesRequested: text("scopes_requested")
      .array()
      .default(sql`'{}'::text[]`),
    redirectUri: text("redirect_uri").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
    expiresAt: timestamp("expires_at")
      .notNull()
      .default(sql`NOW() + INTERVAL '10 minutes'`),
  },
  (table) => [index("idx_oauth_states_expires").on(table.expiresAt)],
);

// ────────────────────────────────────────────────────────────
// Type exports
// ────────────────────────────────────────────────────────────

export type User = InferSelectModel<typeof user>;
export type NewUser = InferInsertModel<typeof user>;

export type Session = InferSelectModel<typeof session>;

export type Organization = InferSelectModel<typeof organizations>;
export type NewOrganization = InferInsertModel<typeof organizations>;

export type OrganizationMember = InferSelectModel<typeof organizationMembers>;
export type NewOrganizationMember = InferInsertModel<typeof organizationMembers>;

export type Profile = InferSelectModel<typeof profiles>;
export type NewProfile = InferInsertModel<typeof profiles>;

export type FlowConfig = InferSelectModel<typeof flowConfigs>;

export type Flow = InferSelectModel<typeof flows>;
export type NewFlow = InferInsertModel<typeof flows>;

export type FlowVersion = InferSelectModel<typeof flowVersions>;

export type Execution = InferSelectModel<typeof executions>;
export type NewExecution = InferInsertModel<typeof executions>;

export type ExecutionLog = InferSelectModel<typeof executionLogs>;
export type NewExecutionLog = InferInsertModel<typeof executionLogs>;

export type FlowSchedule = InferSelectModel<typeof flowSchedules>;
export type NewFlowSchedule = InferInsertModel<typeof flowSchedules>;

export type ScheduleRun = InferSelectModel<typeof scheduleRuns>;

export type ShareToken = InferSelectModel<typeof shareTokens>;
export type NewShareToken = InferInsertModel<typeof shareTokens>;

export type FlowAdminConnection = InferSelectModel<typeof flowAdminConnections>;

export type OrgSkill = InferSelectModel<typeof orgSkills>;
export type OrgExtension = InferSelectModel<typeof orgExtensions>;

export type ProviderConfig = InferSelectModel<typeof providerConfigs>;
export type NewProviderConfig = InferInsertModel<typeof providerConfigs>;

export type ServiceConnection = InferSelectModel<typeof serviceConnections>;
export type NewServiceConnection = InferInsertModel<typeof serviceConnections>;

export type OAuthState = InferSelectModel<typeof oauthStates>;
export type NewOAuthState = InferInsertModel<typeof oauthStates>;
