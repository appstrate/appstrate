// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { providerCredentials, packages, userProviderConnections } from "@appstrate/db/schema";
import type { AppEnv } from "../types/index.ts";
import { getItemId } from "./packages.ts";
import type { ProviderConfig } from "@appstrate/shared-types";
import type { JSONSchemaObject } from "@appstrate/core/form";
import { getOAuthCallbackUrl } from "../services/connection-manager/oauth.ts";
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
import { encryptCredentials } from "@appstrate/connect";
import { listPackages } from "../services/agent-service.ts";
import { resolveManifestProviders } from "../lib/manifest-utils.ts";
import { createVersionAndUpload } from "../services/package-versions.ts";
import { isValidVersion } from "@appstrate/core/semver";
import { zipArtifact } from "@appstrate/core/zip";
import { AFPS_SCHEMA_URLS } from "@appstrate/core/validation";
import { getDefaultAdminCredentialSchema } from "@appstrate/core/validation";
import { packageToProviderConfig } from "../lib/provider-config.ts";
import { asRecord } from "../lib/safe-json.ts";
import { orgOrSystemFilter } from "../lib/package-helpers.ts";

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
  authorizationParams?: Record<string, string>;
  tokenParams?: Record<string, string>;
  requestTokenUrl?: string;
  accessTokenUrl?: string;
  credentialSchema?: unknown;
  credentialFieldName?: string;
  credentialHeaderName?: string;
  credentialHeaderPrefix?: string;
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

  return definition;
}

/** Check if a provider is a system provider via the DB source column. */
async function isSystemProviderInDb(providerId: string): Promise<boolean> {
  const [pkg] = await db
    .select({ source: packages.source })
    .from(packages)
    .where(eq(packages.id, providerId))
    .limit(1);
  return pkg?.source === "system";
}

const createProviderSchema = z.object({
  id: z.string().min(1, "id is required"),
  displayName: z.string().min(1, "displayName is required"),
  version: z.string().optional(),
  description: z.string().optional(),
  author: z.string().optional(),
  authMode: z.enum(["oauth2", "oauth1", "api_key", "basic", "custom"]),
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
  authorizationParams: z.record(z.string(), z.string()).optional(),
  tokenParams: z.record(z.string(), z.string()).optional(),
  credentialSchema: z.any().optional(),
  credentialFieldName: z.string().optional(),
  credentialHeaderName: z.string().optional(),
  credentialHeaderPrefix: z.string().optional(),
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

const updateProviderSchema = createProviderSchema.omit({ id: true });

export function createProvidersRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/providers — list all providers (all org members)
  router.get("/", async (c) => {
    const orgId = c.get("orgId");

    // Query all provider packages
    const rows = await db
      .select({
        pkg: { id: packages.id, draftManifest: packages.draftManifest, source: packages.source },
      })
      .from(packages)
      .where(and(orgOrSystemFilter(orgId), eq(packages.type, "provider")))
      .orderBy(sql`CASE WHEN ${packages.source} = 'system' THEN 0 ELSE 1 END`);

    // Count provider usage across all agents
    const allAgents = await listPackages(orgId);
    const providerUsage = new Map<string, number>();
    for (const agent of allAgents) {
      for (const svc of resolveManifestProviders(agent.manifest)) {
        providerUsage.set(svc.id, (providerUsage.get(svc.id) ?? 0) + 1);
      }
    }

    // Direct Drizzle query on providerCredentials (bypass LEFT JOIN issue)
    const allCreds = await db
      .select({
        providerId: providerCredentials.providerId,
        credentialsEncrypted: providerCredentials.credentialsEncrypted,
        enabled: providerCredentials.enabled,
      })
      .from(providerCredentials)
      .where(eq(providerCredentials.orgId, orgId));

    const credMap = new Map(allCreds.map((r) => [r.providerId, r]));

    const providers: ProviderConfig[] = rows.map(({ pkg }) => {
      const cred = credMap.get(pkg.id) ?? null;
      const cfg = packageToProviderConfig(
        { id: pkg.id, manifest: pkg.draftManifest, source: pkg.source },
        cred,
      );
      cfg.usedByAgents = providerUsage.get(pkg.id) ?? 0;
      return cfg;
    });

    const callbackUrl = getOAuthCallbackUrl();
    return c.json({ providers, callbackUrl });
  });

  // POST /api/providers — create a custom provider
  router.post("/", requirePermission("providers", "write"), async (c) => {
    const orgId = c.get("orgId");
    const body = await c.req.json();
    const data = parseBody(createProviderSchema, body);

    const scopeErr = checkScopeMatch(c, data.id);
    if (scopeErr) throw scopeErr;

    // Block creation if ID matches a system provider
    if (await isSystemProviderInDb(data.id)) {
      throw systemEntityForbidden("provider", data.id, "create");
    }

    // Check ID doesn't already exist for this org
    const existing = await db
      .select({ id: packages.id })
      .from(packages)
      .where(
        and(eq(packages.orgId, orgId), eq(packages.id, data.id), eq(packages.type, "provider")),
      )
      .limit(1);

    if (existing.length > 0) {
      throw new ApiError({
        status: 400,
        code: "name_collision",
        title: "Bad Request",
        detail: `Provider '${data.id}' already exists`,
      });
    }

    const definition = buildProviderDefinition(data);

    try {
      await db.transaction(async (tx) => {
        // 1. INSERT packages row (type: "provider") with definition in manifest
        await tx
          .insert(packages)
          .values({
            id: data.id,
            orgId,
            type: "provider",
            source: "local",
            draftManifest: {
              $schema: AFPS_SCHEMA_URLS.provider,
              name: data.id,
              type: "provider",
              version: data.version ?? "1.0.0",
              displayName: data.displayName,
              description: data.description,
              author: data.author,
              iconUrl: data.iconUrl,
              categories: data.categories,
              docsUrl: data.docsUrl,
              definition,
            },
            draftContent: "",
            createdBy: c.get("user").id,
          })
          .onConflictDoNothing();

        // 2. UPSERT providerCredentials (providerId, orgId) with credentials if provided
        const adminCreds: Record<string, string> = {};
        if (data.clientId) adminCreds.clientId = data.clientId;
        if (data.clientSecret) adminCreds.clientSecret = data.clientSecret;
        const hasAdminCreds = Object.keys(adminCreds).length > 0;
        await tx
          .insert(providerCredentials)
          .values({
            providerId: data.id,
            orgId,
            credentialsEncrypted: hasAdminCreds ? encryptCredentials(adminCreds) : null,
            enabled: true,
          })
          .onConflictDoUpdate({
            target: [providerCredentials.providerId, providerCredentials.orgId],
            set: {
              ...(hasAdminCreds ? { credentialsEncrypted: encryptCredentials(adminCreds) } : {}),
              enabled: true,
              updatedAt: new Date(),
            },
          });
      });
    } catch (err) {
      logger.error("Provider create failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw internalError();
    }

    // Create initial version (non-fatal)
    const manifest = {
      $schema: AFPS_SCHEMA_URLS.provider,
      name: data.id,
      type: "provider" as const,
      version: data.version ?? "1.0.0",
      displayName: data.displayName,
      description: data.description,
      author: data.author,
      definition,
    };
    const versionStr = manifest.version;
    if (versionStr && isValidVersion(versionStr)) {
      try {
        const entries: Record<string, Uint8Array> = {
          "manifest.json": new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
        };
        const zipBuffer = Buffer.from(zipArtifact(entries, 6));
        await createVersionAndUpload({
          packageId: data.id,
          version: versionStr,
          createdBy: c.get("user").id,
          zipBuffer,
          manifest,
        });
      } catch (error) {
        logger.warn("Provider initial version creation failed (non-fatal)", {
          packageId: data.id,
          error,
        });
      }
    }

    return c.json({ id: data.id }, 201);
  });

  // PUT /api/providers/:scope/:name — update a provider
  router.put("/:scope{@[^/]+}/:name", requirePermission("providers", "write"), async (c) => {
    const orgId = c.get("orgId");
    const providerId = getItemId(c);
    const body = await c.req.json();
    const data = parseBody(updateProviderSchema, body);

    // Block editing system providers (DB-based guard)
    if (await isSystemProviderInDb(providerId)) {
      throw systemEntityForbidden("system provider", providerId);
    }

    // Fetch existing package
    const [existingPkg] = await db
      .select({ draftManifest: packages.draftManifest })
      .from(packages)
      .where(
        and(orgOrSystemFilter(orgId), eq(packages.id, providerId), eq(packages.type, "provider")),
      )
      .limit(1);

    if (!existingPkg) {
      throw notFound(`Provider '${providerId}' not found`);
    }

    const definition = buildProviderDefinition(data);

    try {
      await db.transaction(async (tx) => {
        // 1. Update packages manifest (complete replacement, no merge)
        await tx
          .update(packages)
          .set({
            draftManifest: {
              $schema: AFPS_SCHEMA_URLS.provider,
              name: providerId,
              type: "provider",
              version: data.version ?? "1.0.0",
              displayName: data.displayName,
              description: data.description,
              author: data.author,
              iconUrl: data.iconUrl,
              categories: data.categories,
              docsUrl: data.docsUrl,
              definition,
            },
            updatedAt: new Date(),
          })
          .where(and(eq(packages.id, providerId), eq(packages.orgId, orgId)));

        // 2. Handle credentials: update with new values if provided
        if (data.clientId || data.clientSecret) {
          const adminCreds: Record<string, string> = {};
          if (data.clientId) adminCreds.clientId = data.clientId;
          if (data.clientSecret) adminCreds.clientSecret = data.clientSecret;

          await tx
            .insert(providerCredentials)
            .values({
              providerId,
              orgId,
              credentialsEncrypted: encryptCredentials(adminCreds),
            })
            .onConflictDoUpdate({
              target: [providerCredentials.providerId, providerCredentials.orgId],
              set: { credentialsEncrypted: encryptCredentials(adminCreds), updatedAt: new Date() },
            });
        }
      });
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

      const credSchema = z.object({
        credentials: z.record(z.string(), z.string().min(1)).optional(),
        enabled: z.boolean().optional(),
        invalidateConnections: z.boolean().optional(),
      });
      const data = parseBody(credSchema, body);

      // Verify the provider exists and get its admin credential schema
      const [pkg] = await db
        .select({ id: packages.id, draftManifest: packages.draftManifest })
        .from(packages)
        .where(
          and(orgOrSystemFilter(orgId), eq(packages.id, providerId), eq(packages.type, "provider")),
        )
        .limit(1);

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

      const setClause: Record<string, unknown> = { updatedAt: new Date() };
      if (hasCredentials) {
        setClause.credentialsEncrypted = encryptCredentials(data.credentials!);
      }
      if (data.enabled !== undefined) {
        setClause.enabled = data.enabled;
      }

      await db
        .insert(providerCredentials)
        .values({
          providerId,
          orgId,
          credentialsEncrypted: hasCredentials ? encryptCredentials(data.credentials!) : null,
          enabled: data.enabled ?? false,
        })
        .onConflictDoUpdate({
          target: [providerCredentials.providerId, providerCredentials.orgId],
          set: setClause,
        });

      // Invalidate all user connections when admin explicitly requests it (credential rotation)
      if (hasCredentials && data.invalidateConnections) {
        await db
          .delete(userProviderConnections)
          .where(
            and(
              eq(userProviderConnections.providerId, providerId),
              eq(userProviderConnections.orgId, orgId),
            ),
          );
        logger.info("Invalidated user connections after credential update", {
          providerId,
          orgId,
        });
      }

      return c.json({ configured: true });
    },
  );

  // DELETE /api/providers/credentials/:scope/:name — delete credentials
  router.delete(
    "/credentials/:scope{@[^/]+}/:name",
    requirePermission("providers", "delete"),
    async (c) => {
      const orgId = c.get("orgId");
      const providerId = getItemId(c);

      await db
        .update(providerCredentials)
        .set({ credentialsEncrypted: null, enabled: false, updatedAt: new Date() })
        .where(
          and(eq(providerCredentials.providerId, providerId), eq(providerCredentials.orgId, orgId)),
        );

      return c.json({ configured: false });
    },
  );

  // DELETE /api/providers/:scope/:name — delete provider
  router.delete("/:scope{@[^/]+}/:name", requirePermission("providers", "delete"), async (c) => {
    const orgId = c.get("orgId");
    const providerId = getItemId(c);

    // Block deleting system providers (DB-based guard)
    if (await isSystemProviderInDb(providerId)) {
      throw systemEntityForbidden("system provider", providerId, "delete");
    }

    // Block deleting providers that are in use by agents
    const allAgents = await listPackages(orgId);
    let usageCount = 0;
    for (const agent of allAgents) {
      for (const svc of resolveManifestProviders(agent.manifest)) {
        if (svc.id === providerId) {
          usageCount++;
          break;
        }
      }
    }
    if (usageCount > 0) {
      throw conflict(
        "provider_in_use",
        `Cannot delete provider '${providerId}': used by ${usageCount} agent(s)`,
      );
    }

    try {
      // Delete packages row (providerCredentials will cascade)
      await db.delete(packages).where(and(eq(packages.orgId, orgId), eq(packages.id, providerId)));
    } catch (err) {
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
