// SPDX-License-Identifier: Apache-2.0

/**
 * Registry mapping API endpoints (method + path) to the Zod schemas
 * that validate their request bodies.
 *
 * Used by `scripts/verify-openapi.ts` (Step 4) to compare Zod-derived
 * JSON Schemas against the hand-written OpenAPI requestBody schemas.
 *
 * Core schemas are defined statically here. Module-owned schemas are
 * contributed dynamically via `openApiSchemas()` — they only appear when
 * the module is loaded. Call `buildZodSchemaRegistry()` after module init.
 */

import { z } from "zod";

// --- End-User schemas (routes/end-users.ts) ---
import { createEndUserSchema, updateEndUserSchema } from "../routes/end-users.ts";

// --- Model schemas (routes/models.ts) ---
import {
  createModelSchema,
  seedModelsSchema,
  updateModelSchema,
  setDefaultSchema as modelsSetDefaultSchema,
  testInlineSchema as modelsTestInlineSchema,
} from "../routes/models.ts";

// --- API Key schemas (routes/api-keys.ts) ---
import { createApiKeySchema } from "../routes/api-keys.ts";

// --- Organization schemas (routes/organizations.ts) ---
import {
  createOrgSchema,
  updateOrgSchema,
  addMemberSchema,
  updateRoleSchema,
} from "../routes/organizations.ts";

// --- Org settings schema (services/organizations.ts) ---
import { orgSettingsSchema } from "../services/organizations.ts";

// --- User-agent schemas (routes/user-agents.ts) ---
import { updateSkillsSchema, updateToolsSchema } from "../routes/user-agents.ts";

// --- Welcome schemas (routes/welcome.ts) ---
import { welcomeSetupSchema } from "../routes/welcome.ts";

// --- App Profile schemas (routes/app-profiles.ts) ---
import {
  profileNameSchema as appProfileNameSchema,
  bindAppProfileSchema,
} from "../routes/app-profiles.ts";

// --- Connection Profile schemas (routes/connection-profiles.ts) ---
import { profileNameSchema as connectionProfileNameSchema } from "../routes/connection-profiles.ts";

// --- Proxy schemas (routes/proxies.ts) ---
import {
  createProxySchema,
  updateProxySchema,
  setDefaultSchema as proxiesSetDefaultSchema,
} from "../routes/proxies.ts";

// --- Provider schemas (routes/providers.ts) ---
import {
  createProviderSchema,
  updateProviderSchema,
  configureCredentialsSchema,
} from "../routes/providers.ts";

// --- Agent schemas (routes/agents.ts) ---
import {
  proxyIdSchema,
  modelIdSchema,
  appProfileIdSchema,
  setProviderProfileSchema,
  removeProviderProfileSchema,
} from "../routes/agents.ts";

// --- Model Provider Credential schemas (routes/model-provider-credentials.ts) ---
import {
  createSchema as createModelProviderCredentialSchema,
  updateSchema as updateModelProviderCredentialSchema,
  testInlineSchema as modelProviderCredentialsTestInlineSchema,
} from "../routes/model-provider-credentials.ts";

// --- Profile schemas (routes/profile.ts) ---
import { profileUpdateSchema, batchLookupSchema } from "../routes/profile.ts";

// --- Connection schemas (routes/connections.ts) ---
import {
  connectOAuthSchema,
  connectApiKeySchema,
  connectCredentialsSchema,
} from "../routes/connections.ts";

// --- Package schemas (routes/packages.ts) ---
import { githubImportSchema, forkSchema } from "../routes/packages.ts";

// --- Application schemas (routes/applications.ts) ---
import {
  createApplicationSchema,
  updateApplicationSchema,
  installPackageSchema,
  updatePackageSchema,
  appProviderCredentialsSchema,
} from "../routes/applications.ts";

// ---------------------------------------------------------------------------
// Registry type and entries
// ---------------------------------------------------------------------------

export interface ZodSchemaEntry {
  /** HTTP method (uppercase) */
  method: string;
  /** OpenAPI path (e.g. "/api/agents") */
  path: string;
  /** The Zod schema converted to JSON Schema via z.toJSONSchema() */
  jsonSchema: Record<string, unknown>;
  /** Human-readable description for reporting */
  description: string;
}

/**
 * Convert a Zod schema to JSON Schema. Wrapped to handle errors gracefully.
 */
function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}

/**
 * Core Zod request-body schemas (always present, not module-owned).
 */
const coreSchemas: ZodSchemaEntry[] = [
  // ─── End-Users ──────────────────────────────────────────────────────────
  {
    method: "POST",
    path: "/api/end-users",
    jsonSchema: toJsonSchema(createEndUserSchema),
    description: "Create end-user",
  },
  {
    method: "PATCH",
    path: "/api/end-users/{id}",
    jsonSchema: toJsonSchema(updateEndUserSchema),
    description: "Update end-user",
  },

  // ─── Models ─────────────────────────────────────────────────────────────
  {
    method: "POST",
    path: "/api/models",
    jsonSchema: toJsonSchema(createModelSchema),
    description: "Create model",
  },
  {
    method: "PUT",
    path: "/api/models/{id}",
    jsonSchema: toJsonSchema(updateModelSchema),
    description: "Update model",
  },
  {
    method: "PUT",
    path: "/api/models/default",
    jsonSchema: toJsonSchema(modelsSetDefaultSchema),
    description: "Set default model",
  },
  {
    method: "POST",
    path: "/api/models/test",
    jsonSchema: toJsonSchema(modelsTestInlineSchema),
    description: "Test model config inline",
  },
  {
    method: "POST",
    path: "/api/models/seed",
    jsonSchema: toJsonSchema(seedModelsSchema),
    description: "Bulk-seed models from registry",
  },

  // ─── API Keys ───────────────────────────────────────────────────────────
  {
    method: "POST",
    path: "/api/api-keys",
    jsonSchema: toJsonSchema(createApiKeySchema),
    description: "Create API key",
  },

  // ─── Organizations ──────────────────────────────────────────────────────
  {
    method: "POST",
    path: "/api/orgs",
    jsonSchema: toJsonSchema(createOrgSchema),
    description: "Create organization",
  },
  {
    method: "PUT",
    path: "/api/orgs/{orgId}",
    jsonSchema: toJsonSchema(updateOrgSchema),
    description: "Update organization",
  },
  {
    method: "POST",
    path: "/api/orgs/{orgId}/members",
    jsonSchema: toJsonSchema(addMemberSchema),
    description: "Add/invite org member",
  },
  {
    method: "PUT",
    path: "/api/orgs/{orgId}/members/{userId}",
    jsonSchema: toJsonSchema(updateRoleSchema),
    description: "Update member role",
  },
  {
    method: "PUT",
    path: "/api/orgs/{orgId}/invitations/{invitationId}",
    jsonSchema: toJsonSchema(updateRoleSchema),
    description: "Update invitation role",
  },
  {
    method: "PUT",
    path: "/api/orgs/{orgId}/settings",
    jsonSchema: toJsonSchema(orgSettingsSchema.partial()),
    description: "Update org settings",
  },

  // ─── User-Agent config (skills/tools) ───────────────────────────────────
  {
    method: "PUT",
    path: "/api/agents/{scope}/{name}/skills",
    jsonSchema: toJsonSchema(updateSkillsSchema),
    description: "Update agent skills",
  },
  {
    method: "PUT",
    path: "/api/agents/{scope}/{name}/tools",
    jsonSchema: toJsonSchema(updateToolsSchema),
    description: "Update agent tools",
  },

  // ─── Welcome ────────────────────────────────────────────────────────────
  {
    method: "POST",
    path: "/api/welcome/setup",
    jsonSchema: toJsonSchema(welcomeSetupSchema),
    description: "Welcome setup",
  },

  // ─── App Profiles ───────────────────────────────────────────────────────
  {
    method: "POST",
    path: "/api/app-profiles",
    jsonSchema: toJsonSchema(appProfileNameSchema),
    description: "Create app profile",
  },
  {
    method: "PUT",
    path: "/api/app-profiles/{id}",
    jsonSchema: toJsonSchema(appProfileNameSchema),
    description: "Rename app profile",
  },

  // ─── Connection Profiles ────────────────────────────────────────────────
  {
    method: "POST",
    path: "/api/connection-profiles",
    jsonSchema: toJsonSchema(connectionProfileNameSchema),
    description: "Create connection profile",
  },
  {
    method: "PUT",
    path: "/api/connection-profiles/{id}",
    jsonSchema: toJsonSchema(connectionProfileNameSchema),
    description: "Rename connection profile",
  },

  // ─── Proxies ────────────────────────────────────────────────────────────
  {
    method: "POST",
    path: "/api/proxies",
    jsonSchema: toJsonSchema(createProxySchema),
    description: "Create proxy",
  },
  {
    method: "PUT",
    path: "/api/proxies/{id}",
    jsonSchema: toJsonSchema(updateProxySchema),
    description: "Update proxy",
  },
  {
    method: "PUT",
    path: "/api/proxies/default",
    jsonSchema: toJsonSchema(proxiesSetDefaultSchema),
    description: "Set default proxy",
  },

  // ─── Providers ──────────────────────────────────────────────────────────
  {
    method: "POST",
    path: "/api/providers",
    jsonSchema: toJsonSchema(createProviderSchema),
    description: "Create provider",
  },
  {
    method: "PUT",
    path: "/api/providers/{scope}/{name}",
    jsonSchema: toJsonSchema(updateProviderSchema),
    description: "Update provider",
  },

  // ─── Agent config (proxy/model/app-profile) ─────────────────────────────
  {
    method: "PUT",
    path: "/api/agents/{scope}/{name}/proxy",
    jsonSchema: toJsonSchema(proxyIdSchema),
    description: "Set agent proxy",
  },
  {
    method: "PUT",
    path: "/api/agents/{scope}/{name}/model",
    jsonSchema: toJsonSchema(modelIdSchema),
    description: "Set agent model",
  },
  {
    method: "PUT",
    path: "/api/agents/{scope}/{name}/app-profile",
    jsonSchema: toJsonSchema(appProfileIdSchema),
    description: "Set agent app profile",
  },

  // ─── Model Provider Credentials ────────────────────────────────────────
  {
    method: "POST",
    path: "/api/model-provider-credentials",
    jsonSchema: toJsonSchema(createModelProviderCredentialSchema),
    description: "Create model provider credential",
  },
  {
    method: "PUT",
    path: "/api/model-provider-credentials/{id}",
    jsonSchema: toJsonSchema(updateModelProviderCredentialSchema),
    description: "Update model provider credential",
  },
  {
    method: "POST",
    path: "/api/model-provider-credentials/test",
    jsonSchema: toJsonSchema(modelProviderCredentialsTestInlineSchema),
    description: "Test model provider credential inline",
  },

  // ─── Profile ────────────────────────────────────────────────────────────
  {
    method: "PATCH",
    path: "/api/profile",
    jsonSchema: toJsonSchema(profileUpdateSchema),
    description: "Update profile",
  },
  {
    method: "POST",
    path: "/api/profiles/batch",
    jsonSchema: toJsonSchema(batchLookupSchema),
    description: "Batch profile lookup",
  },

  // ─── Applications ──────────────────────────────────────────────────────
  {
    method: "POST",
    path: "/api/applications",
    jsonSchema: toJsonSchema(createApplicationSchema),
    description: "Create application",
  },
  {
    method: "PATCH",
    path: "/api/applications/{id}",
    jsonSchema: toJsonSchema(updateApplicationSchema),
    description: "Update application",
  },

  // ─── Application Packages ──────────────────────────────────────────────
  {
    method: "POST",
    path: "/api/applications/{applicationId}/packages",
    jsonSchema: toJsonSchema(installPackageSchema),
    description: "Install package in application",
  },
  {
    method: "PUT",
    path: "/api/applications/{applicationId}/packages/{scope}/{name}",
    jsonSchema: toJsonSchema(updatePackageSchema),
    description: "Update installed package config",
  },

  // ─── Application Provider Credentials ──────────────────────────────────
  {
    method: "PUT",
    path: "/api/applications/{applicationId}/providers/{scope}/{name}/credentials",
    jsonSchema: toJsonSchema(appProviderCredentialsSchema),
    description: "Set app-level provider credentials",
  },

  // ─── Connections ────────────────────────────────────────────────────────
  {
    method: "POST",
    path: "/api/connections/connect/{scope}/{name}",
    jsonSchema: toJsonSchema(connectOAuthSchema),
    description: "Initiate OAuth connection",
  },
  {
    method: "POST",
    path: "/api/connections/connect/{scope}/{name}/api-key",
    jsonSchema: toJsonSchema(connectApiKeySchema),
    description: "Create API key connection",
  },
  {
    method: "POST",
    path: "/api/connections/connect/{scope}/{name}/credentials",
    jsonSchema: toJsonSchema(connectCredentialsSchema),
    description: "Save generic credentials connection",
  },

  // ─── Agent Provider Profiles ────────────────────────────────────────────
  {
    method: "PUT",
    path: "/api/agents/{scope}/{name}/provider-profiles",
    jsonSchema: toJsonSchema(setProviderProfileSchema),
    description: "Set agent provider profile override",
  },
  {
    method: "DELETE",
    path: "/api/agents/{scope}/{name}/provider-profiles",
    jsonSchema: toJsonSchema(removeProviderProfileSchema),
    description: "Remove agent provider profile override",
  },

  // ─── Package Import & Fork ──────────────────────────────────────────────
  {
    method: "POST",
    path: "/api/packages/import-github",
    jsonSchema: toJsonSchema(githubImportSchema),
    description: "Import package from GitHub",
  },
  {
    method: "POST",
    path: "/api/packages/{scope}/{name}/fork",
    jsonSchema: toJsonSchema(forkSchema),
    description: "Fork an agent",
  },

  // ─── Provider Credentials ──────────────────────────────────────────────
  {
    method: "PUT",
    path: "/api/providers/credentials/{scope}/{name}",
    jsonSchema: toJsonSchema(configureCredentialsSchema),
    description: "Configure provider credentials",
  },

  // ─── App Profile Binding ───────────────────────────────────────────────
  {
    method: "POST",
    path: "/api/app-profiles/{id}/bind",
    jsonSchema: toJsonSchema(bindAppProfileSchema),
    description: "Bind provider to app profile",
  },
];

/**
 * Build the full Zod schema registry by merging core schemas with module contributions.
 * Must be called after modules are initialized (or after static filesystem discovery
 * in build-time scripts).
 */
export function buildZodSchemaRegistry(moduleSchemas: ZodSchemaEntry[] = []): ZodSchemaEntry[] {
  return [...coreSchemas, ...moduleSchemas];
}
