// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { getItemId } from "./packages.ts";
import type { ProviderConfig } from "@appstrate/shared-types";
import type { JSONSchemaObject } from "@appstrate/core/form";
import { getOAuthCallbackUrl } from "../services/connection-manager/oauth.ts";
import { listResponse } from "../lib/list-response.ts";
import { checkScopeMatch } from "../middleware/guards.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { logger } from "../lib/logger.ts";
import {
  ApiError,
  invalidRequest,
  notFound,
  conflict,
  internalError,
  parseBody,
  systemEntityForbidden,
} from "../lib/errors.ts";
import {
  authModeEnum,
  getDefaultAdminCredentialSchema,
  validateProviderCredentialKeys,
} from "@appstrate/core/validation";
import { getProviderCredentialId } from "@appstrate/connect";
import { db } from "@appstrate/db/client";
import { packageToProviderConfig } from "../lib/provider-config.ts";
import { asRecord } from "@appstrate/core/safe-json";
import {
  getProvider,
  getAppProviderCredentials,
  createProvider,
  updateProvider,
  configureCredentials,
  deleteCredentials,
  deleteProvider,
  invalidateConnections,
  countAllProviderUsage,
  isSystemProvider,
} from "../services/provider-service.ts";
import { listAccessiblePackages } from "../services/application-packages.ts";

/** Build the nested definition object for a provider manifest from flat request data. */
function buildProviderDefinition(data: {
  authMode: string;
  authorizedUris?: string[];
  allowAllUris?: boolean;
  availableScopes?: { value: string; label: string }[];
  authorizationUrl?: string;
  tokenUrl?: string;
  refreshUrl?: string;
  defaultScopes?: string[];
  scopeSeparator?: string;
  pkceEnabled?: boolean;
  tokenAuthMethod?: string;
  tokenContentType?: string;
  authorizationParams?: Record<string, string>;
  tokenParams?: Record<string, string>;
  requestTokenUrl?: string;
  accessTokenUrl?: string;
  credentialSchema?: unknown;
  credentialFieldName?: string;
  credentialHeaderName?: string;
  credentialHeaderPrefix?: string;
  credentialTransform?: { template: string; encoding: "base64" };
}): Record<string, unknown> {
  const definition: Record<string, unknown> = {
    authMode: data.authMode,
    authorizedUris: data.authorizedUris ?? [],
    allowAllUris: data.allowAllUris ?? false,
    availableScopes: data.availableScopes ?? [],
  };

  if (data.authMode === "oauth2") {
    definition.oauth2 = {
      authorizationUrl: data.authorizationUrl,
      tokenUrl: data.tokenUrl,
      refreshUrl: data.refreshUrl,
      defaultScopes: data.defaultScopes ?? [],
      scopeSeparator: data.scopeSeparator ?? " ",
      pkceEnabled: data.pkceEnabled ?? true,
      tokenAuthMethod: data.tokenAuthMethod,
      tokenContentType: data.tokenContentType,
      authorizationParams: data.authorizationParams ?? {},
      tokenParams: data.tokenParams ?? {},
    };
  } else if (data.authMode === "oauth1") {
    definition.oauth1 = {
      requestTokenUrl: data.requestTokenUrl,
      accessTokenUrl: data.accessTokenUrl,
      authorizationUrl: data.authorizationUrl,
      authorizationParams: data.authorizationParams ?? {},
    };
  }

  if (data.authMode === "api_key" || data.authMode === "basic" || data.authMode === "custom") {
    definition.credentials = {
      schema: data.credentialSchema,
      fieldName: data.credentialFieldName,
    };
  }

  if (data.credentialHeaderName !== undefined) {
    definition.credentialHeaderName = data.credentialHeaderName;
  }
  if (data.credentialHeaderPrefix !== undefined) {
    definition.credentialHeaderPrefix = data.credentialHeaderPrefix;
  }
  if (data.credentialTransform !== undefined) {
    definition.credentialTransform = data.credentialTransform;
  }

  return definition;
}

const baseProviderSchema = z.object({
  id: z.string().min(1, "id is required"),
  displayName: z.string().min(1, "displayName is required"),
  version: z.string().optional(),
  description: z.string().optional(),
  author: z.string().optional(),
  authMode: authModeEnum,
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  authorizationUrl: z.string().optional(),
  tokenUrl: z.string().optional(),
  refreshUrl: z.string().optional(),
  requestTokenUrl: z.string().optional(),
  accessTokenUrl: z.string().optional(),
  defaultScopes: z.array(z.string()).optional(),
  scopeSeparator: z.string().optional(),
  pkceEnabled: z.boolean().optional(),
  tokenAuthMethod: z.enum(["client_secret_post", "client_secret_basic"]).optional(),
  tokenContentType: z.enum(["application/x-www-form-urlencoded", "application/json"]).optional(),
  authorizationParams: z.record(z.string(), z.string()).optional(),
  tokenParams: z.record(z.string(), z.string()).optional(),
  credentialSchema: z.record(z.string(), z.unknown()).optional(),
  credentialFieldName: z.string().optional(),
  credentialHeaderName: z.string().optional(),
  credentialHeaderPrefix: z.string().optional(),
  credentialTransform: z
    .object({
      template: z.string().min(1),
      encoding: z.enum(["base64"]),
    })
    .optional(),
  iconUrl: z.string().optional(),
  categories: z.array(z.string()).optional(),
  docsUrl: z.string().optional(),
  authorizedUris: z.array(z.string()).optional(),
  allowAllUris: z.boolean().optional(),
  availableScopes: z
    .array(
      z.object({
        value: z.string(),
        label: z.string(),
      }),
    )
    .optional(),
});

/**
 * Cross-field refinement: credential schema keys and fieldName must match the
 * canonical {@link CREDENTIAL_KEY_RE} pattern and fieldName must reference an
 * existing property. Rule is shared with {@link validateManifest} so ZIP
 * imports and direct API writes enforce the exact same contract.
 */
interface CredentialRefinementInput {
  authMode: string;
  credentialSchema?: Record<string, unknown>;
  credentialFieldName?: string;
}

const credentialRefinement = (data: CredentialRefinementInput, ctx: z.RefinementCtx) => {
  const errors = validateProviderCredentialKeys({
    definition: {
      authMode: data.authMode,
      credentials: {
        schema: data.credentialSchema,
        fieldName: data.credentialFieldName,
      },
    },
  });
  for (const err of errors) {
    const path: (string | number)[] =
      err.field === "fieldName"
        ? ["credentialFieldName"]
        : err.key !== undefined
          ? ["credentialSchema", "properties", err.key]
          : ["credentialSchema"];
    ctx.addIssue({ code: "custom", path, message: err.message });
  }
};

export const createProviderSchema = baseProviderSchema.superRefine(credentialRefinement);

export const updateProviderSchema = baseProviderSchema
  .omit({ id: true })
  .superRefine(credentialRefinement);

export const configureCredentialsSchema = z.object({
  credentials: z.record(z.string(), z.string().min(1)).optional(),
  enabled: z.boolean().optional(),
  invalidateConnections: z.boolean().optional(),
});

export function createProvidersRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/providers — list providers accessible to the current application
  router.get("/", async (c) => {
    const orgId = c.get("orgId");
    const applicationId = c.get("applicationId");

    // Single query (system + installed) + usage counts + app credentials in parallel
    const [rows, providerUsage, allCreds] = await Promise.all([
      listAccessiblePackages({ orgId, applicationId }, "provider"),
      countAllProviderUsage(orgId),
      getAppProviderCredentials(applicationId),
    ]);

    const credMap = new Map(allCreds.map((r) => [r.providerId, r]));

    const providers: ProviderConfig[] = rows.map((row) => {
      const cred = credMap.get(row.id) ?? null;
      const cfg = packageToProviderConfig(
        { id: row.id, manifest: row.draftManifest, source: row.source },
        cred,
      );
      cfg.usedByAgents = providerUsage.get(row.id) ?? 0;
      return cfg;
    });

    const callbackUrl = getOAuthCallbackUrl();
    return c.json({ ...listResponse(providers), callbackUrl });
  });

  // POST /api/providers — create a custom provider
  router.post("/", requirePermission("providers", "write"), async (c) => {
    const orgId = c.get("orgId");
    const body = await c.req.json();
    const data = parseBody(createProviderSchema, body);

    const scopeErr = checkScopeMatch(c, data.id);
    if (scopeErr) throw scopeErr;

    if (isSystemProvider(data.id)) {
      throw systemEntityForbidden("provider", data.id, "create");
    }

    // Check ID doesn't already exist for this org
    const existing = await getProvider(orgId, data.id);
    if (existing) {
      throw new ApiError({
        status: 400,
        code: "name_collision",
        title: "Bad Request",
        detail: `Provider '${data.id}' already exists`,
      });
    }

    const definition = buildProviderDefinition(data);
    const adminCreds: Record<string, string> = {};
    if (data.clientId) adminCreds.clientId = data.clientId;
    if (data.clientSecret) adminCreds.clientSecret = data.clientSecret;

    try {
      await createProvider(
        orgId,
        {
          id: data.id,
          version: data.version,
          displayName: data.displayName,
          description: data.description,
          author: data.author,
          iconUrl: data.iconUrl,
          categories: data.categories,
          docsUrl: data.docsUrl,
          definition,
        },
        c.get("applicationId"),
        c.get("user").id,
        Object.keys(adminCreds).length > 0 ? adminCreds : undefined,
      );
    } catch (err) {
      logger.error("Provider create failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw internalError();
    }

    return c.json({ id: data.id }, 201);
  });

  // PUT /api/providers/:scope/:name — update a provider
  router.put("/:scope{@[^/]+}/:name", requirePermission("providers", "write"), async (c) => {
    const orgId = c.get("orgId");
    const providerId = getItemId(c);
    const body = await c.req.json();
    const data = parseBody(updateProviderSchema, body);

    if (isSystemProvider(providerId)) {
      throw systemEntityForbidden("system provider", providerId);
    }

    const existing = await getProvider(orgId, providerId);
    if (!existing) {
      throw notFound(`Provider '${providerId}' not found`);
    }

    const definition = buildProviderDefinition(data);
    const adminCreds: Record<string, string> = {};
    if (data.clientId) adminCreds.clientId = data.clientId;
    if (data.clientSecret) adminCreds.clientSecret = data.clientSecret;

    try {
      await updateProvider(
        orgId,
        providerId,
        {
          version: data.version,
          displayName: data.displayName,
          description: data.description,
          author: data.author,
          iconUrl: data.iconUrl,
          categories: data.categories,
          docsUrl: data.docsUrl,
          definition,
        },
        c.get("applicationId"),
        Object.keys(adminCreds).length > 0 ? adminCreds : undefined,
      );
    } catch (err) {
      logger.error("Provider update failed", {
        providerId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw internalError();
    }

    return c.json({ id: providerId });
  });

  // PUT /api/providers/credentials/:scope/:name — configure credentials
  router.put(
    "/credentials/:scope{@[^/]+}/:name",
    requirePermission("providers", "write"),
    async (c) => {
      const orgId = c.get("orgId");
      const providerId = getItemId(c);
      const body = await c.req.json();

      const data = parseBody(configureCredentialsSchema, body);

      // Verify the provider exists and get its admin credential schema
      const pkg = await getProvider(orgId, providerId);
      if (!pkg) {
        throw notFound("Provider not found");
      }

      const hasCredentials = data.credentials && Object.keys(data.credentials).length > 0;

      // Validate required fields against admin credential schema only when credentials are provided
      if (hasCredentials) {
        const manifest = asRecord(pkg.draftManifest);
        const def = asRecord(manifest.definition);
        const authMode = (def.authMode as string) ?? "oauth2";
        const adminSchema =
          (def.adminCredentialSchema as JSONSchemaObject) ??
          (getDefaultAdminCredentialSchema(authMode) as JSONSchemaObject | null);
        if (adminSchema?.required) {
          const missing = adminSchema.required.filter((k) => !data.credentials![k]);
          if (missing.length > 0) {
            throw invalidRequest(`Missing required fields: ${missing.join(", ")}`);
          }
        }
      }

      const applicationId = c.get("applicationId");
      if (!applicationId) {
        throw invalidRequest("Application context required to configure provider credentials");
      }

      await configureCredentials(applicationId, providerId, data.credentials, data.enabled);

      if (hasCredentials && data.invalidateConnections) {
        const credentialId = await getProviderCredentialId(db, applicationId, providerId);
        if (credentialId) {
          await invalidateConnections(orgId, providerId, credentialId);
        }
      }

      return c.json({ configured: true });
    },
  );

  // DELETE /api/providers/credentials/:scope/:name — delete credentials
  router.delete(
    "/credentials/:scope{@[^/]+}/:name",
    requirePermission("providers", "delete"),
    async (c) => {
      const applicationId = c.get("applicationId");
      const providerId = getItemId(c);

      if (applicationId) {
        await deleteCredentials(applicationId, providerId);
      }

      return c.json({ configured: false });
    },
  );

  // DELETE /api/providers/:scope/:name — delete provider
  router.delete("/:scope{@[^/]+}/:name", requirePermission("providers", "delete"), async (c) => {
    const orgId = c.get("orgId");
    const providerId = getItemId(c);

    if (isSystemProvider(providerId)) {
      throw systemEntityForbidden("system provider", providerId, "delete");
    }

    try {
      const result = await deleteProvider(orgId, providerId);
      if (!result.ok) {
        throw conflict(
          "provider_in_use",
          `Cannot delete provider '${providerId}': used by ${result.usageCount} agent(s)`,
        );
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      logger.error("Provider delete failed", {
        providerId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw internalError();
    }

    return c.body(null, 204);
  });

  return router;
}
