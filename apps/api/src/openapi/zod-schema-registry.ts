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
import type { OpenApiSchemaEntry } from "@appstrate/core/module";
import { LLM_PROXY_ROUTES, llmProxyUrlPath, type ProxiedApiShape } from "@appstrate/runner-pi";

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
  updateInvitationSchema,
  updateRoleSchema,
} from "../routes/organizations.ts";

// --- Org settings schema (services/organizations.ts) ---
import { orgSettingsPatchSchema } from "../services/organizations.ts";

// --- User-agent schemas (routes/user-agents.ts) ---
import { updateSkillsSchema } from "../routes/user-agents.ts";

// --- Welcome schemas (routes/welcome.ts) ---
import { welcomeSetupSchema } from "../routes/welcome.ts";

// --- Proxy schemas (routes/proxies.ts) ---
import {
  createProxySchema,
  updateProxySchema,
  setDefaultSchema as proxiesSetDefaultSchema,
} from "../routes/proxies.ts";

// --- Agent schemas (routes/agents.ts) ---
import { proxyIdSchema, modelIdSchema, agentInputSettingsSchema } from "../routes/agents.ts";

// --- Model Provider Credential schemas (routes/model-provider-credentials.ts) ---
import {
  createSchema as createModelProviderCredentialSchema,
  updateSchema as updateModelProviderCredentialSchema,
  testInlineSchema as modelProviderCredentialsTestInlineSchema,
} from "../routes/model-provider-credentials.ts";

// --- Profile schemas (routes/profile.ts) ---
import { profileUpdateSchema, batchLookupSchema, setPasswordSchema } from "../routes/profile.ts";

// --- Package schemas (routes/packages.ts) ---
import {
  githubImportSchema,
  forkSchema,
  packageJsonCreateSchema,
  packageJsonCreateWithContentSchema,
  packageJsonUpdateSchema,
  createVersionBodySchema,
} from "../routes/packages.ts";

// --- Space schemas (routes/spaces.ts) ---
import {
  createSpaceSchema,
  updateSpaceSchema,
  addSpaceMemberSchema,
  updateSpaceMemberSchema,
  installPackageSchema,
  updatePackageSchema,
} from "../routes/spaces.ts";

// --- Role schemas (routes/roles.ts) ---
import { createSpaceRoleSchema, updateSpaceRoleSchema } from "../routes/roles.ts";

// --- Run launch schemas (routes/runs.ts) ---
import { runAgentBodySchema } from "../routes/runs.ts";

// --- Remote-run schemas (routes/runs-remote.ts) ---
import { CreateRemoteRunBodySchema, ExtendSinkBodySchema } from "../routes/runs-remote.ts";
import { CloudEventEnvelopeSchema } from "../routes/runs-events.ts";

// --- Schedule schemas (routes/schedules.ts) ---
import { createScheduleSchema, updateScheduleSchema } from "../routes/schedules.ts";

// --- Upload schemas (routes/uploads.ts) ---
import { createUploadSchema } from "../routes/uploads.ts";

// --- Member integration-pin schema (routes/me.ts) ---
import { upsertMemberPinSchema } from "../routes/me.ts";

// --- Model-provider OAuth pairing schemas (routes/model-providers-oauth.ts) ---
import { createPairingBody, importBody } from "../routes/model-providers-oauth.ts";

// --- Unattended-install bootstrap schema (routes/auth-bootstrap.ts) ---
import { redeemSchema as bootstrapRedeemSchema } from "../routes/auth-bootstrap.ts";

// --- Integration schemas (routes/integrations.ts) ---
import {
  importConnectionSchema,
  connectOAuthSchema,
  updateSettingsSchema,
  setPinSchema,
  setOrgDefaultSchema,
  oauthClientCreateSchema,
  oauthClientUpdateSchema,
  updateConnectionSchema,
  connectSessionSchema,
  connectSubmitSchema,
  setDefaultClientSchema,
} from "../routes/integrations.ts";

// ---------------------------------------------------------------------------
// Registry type and entries
// ---------------------------------------------------------------------------

/**
 * Convert a Zod schema to JSON Schema.
 *
 * `io: "input"` is load-bearing: these are REQUEST bodies, and Zod's default
 * ("output") describes the parsed value. A field carrying `.default(...)` is
 * optional on the wire but always present after parsing, so the output view
 * marks it required and the comparison reports the spec — which correctly
 * documents it as optional — as drift.
 */
function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
}

/**
 * Core Zod request-body schemas (always present, not module-owned).
 */
const coreSchemas: OpenApiSchemaEntry[] = [
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

  // ─── Runs ───────────────────────────────────────────────────────────────
  //
  // The launch surfaces are `.strict()` (#1187), so every field they honour
  // must be documented: an entry here is what turns "accepted by Zod but absent
  // from the spec" into a failing check instead of a field callers cannot
  // discover. The two inline surfaces are NOT registered: their schema is a
  // wire-shape guard that deliberately defers `manifest` / `prompt` to the
  // preflight (`z.unknown()`, optional), so a field-by-field comparison against
  // a spec that declares both required and typed reports that deferral as
  // drift. The check compares shapes; that one is a division of labour.
  {
    method: "POST",
    path: "/api/agents/{scope}/{name}/run",
    jsonSchema: toJsonSchema(runAgentBodySchema),
    description: "Execute an agent",
  },
  {
    method: "POST",
    path: "/api/runs/remote",
    jsonSchema: toJsonSchema(CreateRemoteRunBodySchema),
    description: "Create a remote (runner-driven) run",
  },
  {
    method: "PATCH",
    path: "/api/runs/{runId}/sink/extend",
    jsonSchema: toJsonSchema(ExtendSinkBodySchema),
    description: "Extend a remote run's event-sink lease",
  },

  {
    method: "POST",
    path: "/api/runs/{runId}/events",
    jsonSchema: toJsonSchema(CloudEventEnvelopeSchema),
    description: "Ingest a run CloudEvent",
  },

  // ─── Schedules ──────────────────────────────────────────────────────────
  {
    method: "POST",
    path: "/api/agents/{scope}/{name}/schedules",
    jsonSchema: toJsonSchema(createScheduleSchema),
    description: "Create an agent schedule",
  },
  {
    method: "PUT",
    path: "/api/schedules/{id}",
    jsonSchema: toJsonSchema(updateScheduleSchema),
    description: "Update a schedule",
  },

  // ─── Uploads ────────────────────────────────────────────────────────────
  {
    method: "POST",
    path: "/api/uploads",
    jsonSchema: toJsonSchema(createUploadSchema),
    description: "Register an upload and mint its sink URL",
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
    jsonSchema: toJsonSchema(updateInvitationSchema),
    description: "Update invitation role and space assignments",
  },
  {
    method: "PUT",
    path: "/api/orgs/{orgId}/settings",
    jsonSchema: toJsonSchema(orgSettingsPatchSchema),
    description: "Update org settings",
  },

  // ─── User-Agent config (skills/tools) ───────────────────────────────────
  {
    method: "PUT",
    path: "/api/agents/{scope}/{name}/skills",
    jsonSchema: toJsonSchema(updateSkillsSchema),
    description: "Update agent skills",
  },

  // ─── Welcome ────────────────────────────────────────────────────────────
  {
    method: "POST",
    path: "/api/welcome/setup",
    jsonSchema: toJsonSchema(welcomeSetupSchema),
    description: "Welcome setup",
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

  // ─── Agent config (proxy/model) ─────────────────────────────────────────
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
    path: "/api/agents/{scope}/{name}/input-settings",
    jsonSchema: toJsonSchema(agentInputSettingsSchema),
    description: "Set agent input settings",
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
  {
    method: "POST",
    path: "/api/profile/password",
    jsonSchema: toJsonSchema(setPasswordSchema),
    description: "Set/replace the caller's password",
  },

  // ─── Spaces ────────────────────────────────────────────────────────────
  {
    method: "POST",
    path: "/api/spaces",
    jsonSchema: toJsonSchema(createSpaceSchema),
    description: "Create space",
  },
  {
    method: "PATCH",
    path: "/api/spaces/{id}",
    jsonSchema: toJsonSchema(updateSpaceSchema),
    description: "Update space",
  },

  {
    method: "POST",
    path: "/api/spaces/{id}/members",
    jsonSchema: toJsonSchema(addSpaceMemberSchema),
    description: "Add a space member",
  },
  {
    method: "PATCH",
    path: "/api/spaces/{id}/members/{userId}",
    jsonSchema: toJsonSchema(updateSpaceMemberSchema),
    description: "Change a space member's role",
  },

  // ─── Roles ─────────────────────────────────────────────────────────────
  {
    method: "POST",
    path: "/api/roles",
    jsonSchema: toJsonSchema(createSpaceRoleSchema),
    description: "Create a custom space role",
  },
  {
    method: "PATCH",
    path: "/api/roles/{id}",
    jsonSchema: toJsonSchema(updateSpaceRoleSchema),
    description: "Update a custom space role",
  },

  // ─── Space Packages ────────────────────────────────────────────────────
  {
    method: "POST",
    path: "/api/spaces/{spaceId}/packages",
    jsonSchema: toJsonSchema(installPackageSchema),
    description: "Install package in space",
  },
  {
    method: "PUT",
    path: "/api/spaces/{spaceId}/packages/{scope}/{name}",
    jsonSchema: toJsonSchema(updatePackageSchema),
    description: "Update installed package config",
  },

  // ─── Package draft CRUD (the shared JSON body of every package type) ────
  //
  // `packages.ts` builds these routes in a loop over ROUTE_CONFIGS, so one Zod
  // schema backs several paths. Registering each path individually is what
  // makes the loop's fan-out visible to the gate: a package type whose spec
  // body drifts from the shared schema fails on its own line.
  //
  // Create is NOT one schema for all types: `agent` and `skill` carry
  // `requireContent`, so their body is `packageJsonCreateWithContentSchema`
  // and the spec must publish `content` as required. `integration` has an
  // optional content file and keeps the looser body.
  {
    method: "POST",
    path: "/api/packages/agents",
    jsonSchema: toJsonSchema(packageJsonCreateWithContentSchema),
    description: "Create a draft agent package",
  },
  {
    method: "POST",
    path: "/api/packages/integrations",
    jsonSchema: toJsonSchema(packageJsonCreateSchema),
    description: "Create a draft integration package",
  },
  {
    method: "POST",
    path: "/api/packages/skills",
    jsonSchema: toJsonSchema(packageJsonCreateWithContentSchema),
    description: "Create a draft skill package",
  },
  {
    method: "PUT",
    path: "/api/packages/agents/{scope}/{name}",
    jsonSchema: toJsonSchema(packageJsonUpdateSchema),
    description: "Update a draft agent package",
  },
  {
    method: "PUT",
    path: "/api/packages/integrations/{scope}/{name}",
    jsonSchema: toJsonSchema(packageJsonUpdateSchema),
    description: "Update a draft integration package",
  },
  {
    method: "PUT",
    path: "/api/packages/mcp-servers/{scope}/{name}",
    jsonSchema: toJsonSchema(packageJsonUpdateSchema),
    description: "Update a draft mcp-server package",
  },
  {
    method: "PUT",
    path: "/api/packages/skills/{scope}/{name}",
    jsonSchema: toJsonSchema(packageJsonUpdateSchema),
    description: "Update a draft skill package",
  },

  {
    method: "POST",
    path: "/api/packages/agents/{scope}/{name}/versions",
    jsonSchema: toJsonSchema(createVersionBodySchema),
    description: "Publish a version from the agents draft",
  },
  {
    method: "POST",
    path: "/api/packages/integrations/{scope}/{name}/versions",
    jsonSchema: toJsonSchema(createVersionBodySchema),
    description: "Publish a version from the integrations draft",
  },
  {
    method: "POST",
    path: "/api/packages/mcp-servers/{scope}/{name}/versions",
    jsonSchema: toJsonSchema(createVersionBodySchema),
    description: "Publish a version from the mcp-servers draft",
  },
  {
    method: "POST",
    path: "/api/packages/skills/{scope}/{name}/versions",
    jsonSchema: toJsonSchema(createVersionBodySchema),
    description: "Publish a version from the skills draft",
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

  // ─── Integrations ───────────────────────────────────────────────────────
  {
    method: "POST",
    path: "/api/integrations/{packageId}/auths/{authKey}/oauth-clients",
    jsonSchema: toJsonSchema(oauthClientCreateSchema),
    description: "Register a custom integration OAuth client",
  },
  {
    method: "PUT",
    path: "/api/integrations/{packageId}/oauth-clients/{clientId}",
    jsonSchema: toJsonSchema(oauthClientUpdateSchema),
    description: "Rotate a custom integration OAuth client",
  },
  {
    method: "POST",
    path: "/api/integrations/{packageId}/auths/{authKey}/connect/fields",
    jsonSchema: toJsonSchema(importConnectionSchema),
    description: "Import integration connection via api_key/basic/custom credentials",
  },
  {
    method: "POST",
    path: "/api/integrations/{packageId}/auths/{authKey}/connect/oauth2",
    jsonSchema: toJsonSchema(connectOAuthSchema),
    description: "Headless OAuth2 start for an integration auth",
  },
  {
    method: "PATCH",
    path: "/api/integrations/{packageId}/settings",
    jsonSchema: toJsonSchema(updateSettingsSchema),
    description: "Update integration settings (block user connections)",
  },
  {
    method: "PUT",
    path: "/api/integrations/{packageId}/pins/{agentPackageId}",
    jsonSchema: toJsonSchema(setPinSchema),
    description: "Upsert integration admin pin",
  },
  {
    method: "PUT",
    path: "/api/integrations/{packageId}/default",
    jsonSchema: toJsonSchema(setOrgDefaultSchema),
    description: "Set integration org default connection",
  },
  {
    method: "PATCH",
    path: "/api/integrations/{packageId}/connections/{connectionId}",
    jsonSchema: toJsonSchema(updateConnectionSchema),
    description: "Update integration connection metadata",
  },
  {
    method: "POST",
    path: "/api/integrations/{packageId}/auths/{authKey}/connect/session",
    jsonSchema: toJsonSchema(connectSessionSchema),
    description: "Mint a hosted connect-portal session",
  },
  {
    method: "POST",
    path: "/api/integrations/connect/submit",
    jsonSchema: toJsonSchema(connectSubmitSchema),
    description: "Submit credentials from the hosted connect portal",
  },
  {
    method: "PUT",
    path: "/api/integrations/{packageId}/auths/{authKey}/default-client",
    jsonSchema: toJsonSchema(setDefaultClientSchema),
    description: "Select the default OAuth client for an integration auth",
  },

  // ─── Member integration pins (routes/me.ts) ─────────────────────────────
  {
    method: "PUT",
    path: "/api/me/integration-pins",
    jsonSchema: toJsonSchema(upsertMemberPinSchema),
    description: "Upsert the caller's integration connection pin",
  },

  // ─── Unattended install bootstrap ───────────────────────────────────────
  {
    method: "POST",
    path: "/api/auth/bootstrap/redeem",
    jsonSchema: toJsonSchema(bootstrapRedeemSchema),
    description: "Redeem AUTH_BOOTSTRAP_TOKEN to claim instance ownership",
  },

  // ─── Model-provider OAuth pairing ───────────────────────────────────────
  {
    method: "POST",
    path: "/api/model-providers-oauth/pairing",
    jsonSchema: toJsonSchema(createPairingBody),
    description: "Mint a connect-helper pairing token",
  },
  {
    method: "POST",
    path: "/api/model-providers-oauth/pair/redeem",
    jsonSchema: toJsonSchema(importBody),
    description: "Redeem a pairing token with provider credentials",
  },
];

/**
 * Endpoints that declare an `application/json` request body in the spec but are
 * deliberately NOT compared against a Zod schema. Every JSON body in the spec
 * must appear either in the registry above (core), in a module's
 * `openApiSchemas()`, or here — `scripts/verify-openapi.ts` §4b fails otherwise.
 *
 * This mirrors `EXEMPT_SCHEMAS` in `response-type-registry.ts`, which does the
 * same job for response schemas. The point of both is that the registries are
 * opt-in: without a coverage check, a launch surface can drift from its
 * documented body and nothing notices. An exemption is a decision, so it must
 * carry the reason it is one.
 *
 * Keys are `"METHOD /spec/path"` — the spec's templated path, not the Hono one.
 */
export const EXEMPT_REQUEST_BODIES: Record<string, string> = {
  // ─── Bodies validated somewhere other than a comparable Zod object ──────
  //
  // The two inline-run surfaces guard the wire shape only: they defer
  // `manifest` / `prompt` to the preflight as optional `z.unknown()`, while the
  // spec declares both required and typed. A field-by-field comparison would
  // report that division of labour as drift.
  "POST /api/runs/inline":
    "wire-shape guard only; manifest/prompt are z.unknown() and validated by the run preflight",
  "POST /api/runs/inline/validate":
    "wire-shape guard only; manifest/prompt are z.unknown() and validated by the run preflight",
  // The finalize body is deliberately permissive: it reports the outcome of an
  // already-completed run, so a malformed field must degrade to absent rather
  // than 400 a run that has no way to retry. See routes/runs-events.ts.
  "POST /api/runs/{runId}/events/finalize":
    "tolerance-by-design body: fields degrade to absent instead of rejecting an already-finished run",

  // ─── Empty bodies (documented for shape, never parsed) ──────────────────
  "POST /api/runs/{runId}/events/heartbeat":
    "empty body — the HMAC covers the zero-length payload; the handler reads nothing",
  "POST /api/integrations/{packageId}/activate":
    "empty body — activation is a flag upsert with no parameters",

  // ─── Not ours to validate: framework- or provider-owned wire ────────────
  //
  // Better Auth owns these routes (plugin-registered under /api/auth/*); the
  // body is parsed by better-call, and no Zod schema exists in this repo to
  // compare against.
  "POST /api/auth/sign-in/email": "Better Auth plugin route; body parsed by better-call, no Zod",
  "POST /api/auth/sign-up/email": "Better Auth plugin route; body parsed by better-call, no Zod",
  "POST /api/auth/device/code": "Better Auth device-grant route (RFC 8628); no Zod in this repo",
  "POST /api/auth/cli/token": "Better Auth CLI-grant route; no Zod in this repo",
  "POST /api/auth/cli/revoke": "Better Auth CLI-grant route; no Zod in this repo",
  "POST /api/auth/cli/sessions/revoke": "Better Auth CLI-session route; no Zod in this repo",
  // The LLM proxy forwards the provider's own request envelope verbatim; the
  // schema is the provider's, and re-declaring it as Zod would fork it. That is
  // true of every shape in `LLM_PROXY_ROUTES` by construction — a shape is in
  // that table precisely because the proxy passes it through — so the keys are
  // DERIVED from it rather than spelled out a third time beside the mount
  // (`routes/llm-proxy.ts`) and the document (`openapi/paths/llm-proxy.ts`),
  // both of which already read the table. A fourth shape gets its mount, its
  // path entry and this exemption in one edit.
  ...Object.fromEntries(
    (Object.keys(LLM_PROXY_ROUTES) as ProxiedApiShape[]).map((shape) => [
      `POST /api/llm-proxy${llmProxyUrlPath(shape)}`,
      "verbatim provider passthrough; the body schema is the upstream provider's, not ours",
    ]),
  ),
  // JSON-RPC 2.0 envelope dispatched by the MCP server; the method-level
  // params are validated per tool, not by one body schema.
  "POST /api/mcp/o/{org}":
    "JSON-RPC 2.0 envelope; params are validated per MCP method, not by a single body schema",

  // ─── Module-owned surfaces with no single comparable body ───────────────
  //
  // Listed here rather than in the module because the coverage check reads one
  // map; the owning module is named in each reason.
  "POST /api/chat":
    "@appstrate/module-chat streaming turn endpoint; the body is the AI-SDK UI message envelope, not a hand-written Zod object",
};

/**
 * Build the full Zod schema registry by merging core schemas with module contributions.
 * Must be called after modules are initialized (or after static filesystem discovery
 * in build-time scripts).
 */
export function buildZodSchemaRegistry(
  moduleSchemas: OpenApiSchemaEntry[] = [],
): OpenApiSchemaEntry[] {
  return [...coreSchemas, ...moduleSchemas];
}
