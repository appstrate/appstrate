import { Hono } from "hono";
import { z } from "zod";
import { eq, and, or, isNull } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { providerCredentials, packages } from "@appstrate/db/schema";
import type { AppEnv } from "../types/index.ts";
import type { ProviderConfig, JSONSchemaObject } from "@appstrate/shared-types";
import type { ProviderSetupGuide } from "@appstrate/core/validation";
import { getEnv } from "@appstrate/env";
import { requireAdmin } from "../middleware/guards.ts";
import { logger } from "../lib/logger.ts";
import { encryptCredentials } from "@appstrate/connect";
import { listPackages } from "../services/flow-service.ts";
import { resolveManifestServices } from "../lib/manifest-utils.ts";
import { createVersionAndUpload } from "../services/package-versions.ts";
import { isValidVersion } from "@appstrate/core/semver";
import {
  getDefaultAdminCredentialSchema,
  buildProviderDefinitionFromManifest,
} from "@appstrate/core/validation";

/** Check if a provider is a system provider via the DB source column. */
async function isSystemProviderInDb(providerId: string): Promise<boolean> {
  const [pkg] = await db
    .select({ source: packages.source })
    .from(packages)
    .where(eq(packages.id, providerId))
    .limit(1);
  return pkg?.source === "system" || pkg?.source === "built-in";
}

/** Apply default fields forced on proxy-type providers. */
function applyProxyProviderDefaults(data: { authMode?: string } & Record<string, unknown>): void {
  if (data.authMode !== "proxy") return;
  data.allowAllUris = true;
  data.credentialFieldName = "url";
  data.credentialSchema = data.credentialSchema ?? {
    type: "object",
    properties: {
      url: { type: "string", description: "Proxy URL (http://user:pass@host:port)" },
    },
    required: ["url"],
  };
  const cats = (data.categories as string[]) ?? [];
  if (!cats.includes("proxy")) {
    data.categories = [...cats, "proxy"];
  }
}

function packageToProviderConfig(
  pkg: {
    id: string;
    manifest: unknown;
    source: string | null;
  },
  credRow?: { credentialsEncrypted: string | null; enabled: boolean } | null,
): ProviderConfig {
  const manifest = (pkg.manifest ?? {}) as Record<string, unknown>;
  const def = (manifest.definition ?? {}) as Record<string, unknown>;
  const resolved = buildProviderDefinitionFromManifest(pkg.id, manifest);
  const isSystem = pkg.source === "system" || pkg.source === "built-in";
  const explicitSchema = def.adminCredentialSchema as JSONSchemaObject | undefined;
  const adminCredentialSchema =
    explicitSchema ??
    (getDefaultAdminCredentialSchema(resolved.authMode) as JSONSchemaObject | undefined) ??
    undefined;
  return {
    ...resolved,
    version: (manifest.version as string) ?? undefined,
    description: (manifest.description as string) ?? undefined,
    author: (manifest.author as string) ?? undefined,
    tags: (manifest.tags as string[]) ?? undefined,
    source: isSystem ? "built-in" : "custom",
    hasCredentials: !!credRow?.credentialsEncrypted,
    enabled: !!credRow?.enabled,
    adminCredentialSchema,
    setupGuide: (manifest.setupGuide as ProviderSetupGuide) ?? undefined,
    tokenAuthMethod: resolved.tokenAuthMethod as ProviderConfig["tokenAuthMethod"],
    credentialSchema: (def.credentialSchema as Record<string, unknown>) ?? undefined,
  };
}

const createProviderSchema = z.object({
  id: z.string().min(1, "id is required"),
  displayName: z.string().min(1, "displayName is required"),
  version: z.string().optional(),
  description: z.string().optional(),
  author: z.string().optional(),
  tags: z.array(z.string()).optional(),
  authMode: z.enum(["oauth2", "oauth1", "api_key", "basic", "custom", "proxy"]),
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

const updateProviderSchema = createProviderSchema.omit({ id: true }).partial();

export function createProvidersRouter() {
  const router = new Hono<AppEnv>();

  // All endpoints are admin-only
  router.use("*", requireAdmin());

  // GET /api/providers — list all providers
  router.get("/", async (c) => {
    const orgId = c.get("orgId");

    // Query all provider packages
    const rows = await db
      .select({
        pkg: { id: packages.id, manifest: packages.manifest, source: packages.source },
      })
      .from(packages)
      .where(
        and(or(eq(packages.orgId, orgId), isNull(packages.orgId)), eq(packages.type, "provider")),
      );

    // Count provider usage across all flows
    const allFlows = await listPackages(orgId);
    const providerUsage = new Map<string, number>();
    for (const flow of allFlows) {
      for (const svc of resolveManifestServices(flow.manifest)) {
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
      const cfg = packageToProviderConfig(pkg, cred);
      cfg.usedByFlows = providerUsage.get(pkg.id) ?? 0;
      return cfg;
    });

    const callbackUrl = `${getEnv().APP_URL}/api/auth/callback`;
    return c.json({ providers, callbackUrl });
  });

  // POST /api/providers — create a custom provider
  router.post("/", async (c) => {
    const orgId = c.get("orgId");
    const body = await c.req.json();
    const parsed = createProviderSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", message: parsed.error.issues[0]!.message }, 400);
    }

    const data = parsed.data;

    // Block creation if ID matches a system provider
    if (await isSystemProviderInDb(data.id)) {
      return c.json(
        {
          error: "OPERATION_NOT_ALLOWED",
          message: `Cannot create provider '${data.id}': conflicts with a system provider`,
        },
        403,
      );
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
      return c.json(
        { error: "NAME_COLLISION", message: `Provider '${data.id}' already exists` },
        400,
      );
    }

    applyProxyProviderDefaults(data);

    // Build the definition object for manifest.definition
    const definition: Record<string, unknown> = {
      authMode: data.authMode,
      authorizationUrl: data.authorizationUrl,
      tokenUrl: data.tokenUrl,
      refreshUrl: data.refreshUrl,
      requestTokenUrl: data.requestTokenUrl,
      accessTokenUrl: data.accessTokenUrl,
      defaultScopes: data.defaultScopes ?? [],
      scopeSeparator: data.scopeSeparator ?? " ",
      pkceEnabled: data.pkceEnabled ?? true,
      tokenAuthMethod: data.tokenAuthMethod,
      authorizationParams: data.authorizationParams ?? {},
      tokenParams: data.tokenParams ?? {},
      credentialSchema: data.credentialSchema,
      credentialFieldName: data.credentialFieldName,
      credentialHeaderName: data.credentialHeaderName,
      credentialHeaderPrefix: data.credentialHeaderPrefix,
      authorizedUris: data.authorizedUris ?? [],
      allowAllUris: data.allowAllUris ?? false,
      availableScopes: data.availableScopes ?? [],
    };

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
            name: data.id,
            manifest: {
              name: data.id,
              type: "provider",
              version: data.version ?? "1.0.0",
              displayName: data.displayName,
              description: data.description,
              author: data.author,
              tags: data.tags,
              iconUrl: data.iconUrl,
              categories: data.categories,
              docsUrl: data.docsUrl,
              definition,
            },
            content: "",
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
      return c.json({ error: "INTERNAL_ERROR", message: "Failed to create provider" }, 500);
    }

    // Create initial version (non-fatal)
    const manifest = {
      name: data.id,
      type: "provider" as const,
      version: data.version ?? "1.0.0",
      displayName: data.displayName,
      description: data.description,
      author: data.author,
      tags: data.tags,
      definition,
    };
    const versionStr = manifest.version;
    if (versionStr && isValidVersion(versionStr)) {
      try {
        const { zipArtifact } = await import("@appstrate/core/zip");
        const entries: Record<string, Uint8Array> = {
          "manifest.json": new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
        };
        const zipBuffer = Buffer.from(zipArtifact(entries, 6));
        await createVersionAndUpload({
          packageId: data.id,
          version: versionStr,
          orgId,
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

  // PUT /api/providers/:scope/:name — update a provider (custom only)
  router.put("/:scope{@[^/]+}/:name", async (c) => {
    const orgId = c.get("orgId");
    const providerId = `${c.req.param("scope")}/${c.req.param("name")}`;
    const body = await c.req.json();
    const parsed = updateProviderSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", message: parsed.error.issues[0]!.message }, 400);
    }

    // Block editing system providers (DB-based guard)
    if (await isSystemProviderInDb(providerId)) {
      return c.json(
        {
          error: "OPERATION_NOT_ALLOWED",
          message: `Cannot modify system provider '${providerId}'`,
        },
        403,
      );
    }

    // Fetch existing package
    const [existingPkg] = await db
      .select({ manifest: packages.manifest })
      .from(packages)
      .where(
        and(
          or(eq(packages.orgId, orgId), isNull(packages.orgId)),
          eq(packages.id, providerId),
          eq(packages.type, "provider"),
        ),
      )
      .limit(1);

    if (!existingPkg) {
      return c.json({ error: "NOT_FOUND", message: `Provider '${providerId}' not found` }, 404);
    }

    const data = parsed.data;
    const oldManifest = (existingPkg.manifest ?? {}) as Record<string, unknown>;
    const oldDef = (oldManifest.definition ?? {}) as Record<string, unknown>;
    const authMode = data.authMode ?? (oldDef.authMode as string);

    // Temporarily set authMode so applyProxyProviderDefaults can check it
    const effectiveData = data as Record<string, unknown>;
    effectiveData.authMode = authMode;
    applyProxyProviderDefaults(effectiveData as typeof data & { authMode: string });

    // Merge definition
    const newDef: Record<string, unknown> = {
      ...oldDef,
      ...(data.authMode !== undefined ? { authMode: data.authMode } : {}),
      ...(data.authorizationUrl !== undefined ? { authorizationUrl: data.authorizationUrl } : {}),
      ...(data.tokenUrl !== undefined ? { tokenUrl: data.tokenUrl } : {}),
      ...(data.refreshUrl !== undefined ? { refreshUrl: data.refreshUrl } : {}),
      ...(data.requestTokenUrl !== undefined ? { requestTokenUrl: data.requestTokenUrl } : {}),
      ...(data.accessTokenUrl !== undefined ? { accessTokenUrl: data.accessTokenUrl } : {}),
      ...(data.defaultScopes !== undefined ? { defaultScopes: data.defaultScopes } : {}),
      ...(data.scopeSeparator !== undefined ? { scopeSeparator: data.scopeSeparator } : {}),
      ...(data.pkceEnabled !== undefined ? { pkceEnabled: data.pkceEnabled } : {}),
      ...(data.tokenAuthMethod !== undefined ? { tokenAuthMethod: data.tokenAuthMethod } : {}),
      ...(data.authorizationParams !== undefined
        ? { authorizationParams: data.authorizationParams }
        : {}),
      ...(data.tokenParams !== undefined ? { tokenParams: data.tokenParams } : {}),
      ...(data.credentialSchema !== undefined ? { credentialSchema: data.credentialSchema } : {}),
      ...(data.credentialFieldName !== undefined
        ? { credentialFieldName: data.credentialFieldName }
        : {}),
      ...(data.credentialHeaderName !== undefined
        ? { credentialHeaderName: data.credentialHeaderName }
        : {}),
      ...(data.credentialHeaderPrefix !== undefined
        ? { credentialHeaderPrefix: data.credentialHeaderPrefix }
        : {}),
      ...(data.authorizedUris !== undefined ? { authorizedUris: data.authorizedUris } : {}),
      ...(data.allowAllUris !== undefined ? { allowAllUris: data.allowAllUris } : {}),
      ...(data.availableScopes !== undefined ? { availableScopes: data.availableScopes } : {}),
    };

    try {
      await db.transaction(async (tx) => {
        // 1. Update packages manifest
        await tx
          .update(packages)
          .set({
            manifest: {
              ...oldManifest,
              ...(data.displayName ? { displayName: data.displayName } : {}),
              ...(data.version !== undefined ? { version: data.version } : {}),
              ...(data.description !== undefined ? { description: data.description } : {}),
              ...(data.author !== undefined ? { author: data.author } : {}),
              ...(data.tags !== undefined ? { tags: data.tags } : {}),
              ...(data.iconUrl !== undefined ? { iconUrl: data.iconUrl } : {}),
              ...(data.categories ? { categories: data.categories } : {}),
              ...(data.docsUrl !== undefined ? { docsUrl: data.docsUrl } : {}),
              definition: newDef,
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
      return c.json({ error: "INTERNAL_ERROR", message: "Failed to update provider" }, 500);
    }

    return c.json({ id: providerId });
  });

  // PUT /api/providers/credentials/:scope/:name — configure credentials for a provider
  router.put("/credentials/:scope{@[^/]+}/:name", async (c) => {
    const orgId = c.get("orgId");
    const providerId = `${c.req.param("scope")}/${c.req.param("name")}`;
    const body = await c.req.json();

    const credSchema = z.object({
      credentials: z.record(z.string(), z.string().min(1)).optional(),
      enabled: z.boolean().optional(),
    });
    const parsed = credSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", message: parsed.error.issues[0]!.message }, 400);
    }

    // Verify the provider exists and get its admin credential schema
    const [pkg] = await db
      .select({ id: packages.id, manifest: packages.manifest })
      .from(packages)
      .where(and(eq(packages.id, providerId), eq(packages.type, "provider")))
      .limit(1);

    if (!pkg) {
      return c.json({ error: "NOT_FOUND", message: "Provider not found" }, 404);
    }

    const hasCredentials =
      parsed.data.credentials && Object.keys(parsed.data.credentials).length > 0;

    // Validate required fields against admin credential schema only when credentials are provided
    if (hasCredentials) {
      const manifest = (pkg.manifest ?? {}) as Record<string, unknown>;
      const def = (manifest.definition ?? {}) as Record<string, unknown>;
      const authMode = (def.authMode as string) ?? "oauth2";
      const adminSchema =
        (def.adminCredentialSchema as JSONSchemaObject) ??
        (getDefaultAdminCredentialSchema(authMode) as JSONSchemaObject | null);
      if (adminSchema?.required) {
        const missing = adminSchema.required.filter((k) => !parsed.data.credentials![k]);
        if (missing.length > 0) {
          return c.json(
            {
              error: "VALIDATION_ERROR",
              message: `Missing required fields: ${missing.join(", ")}`,
            },
            400,
          );
        }
      }
    }

    const setClause: Record<string, unknown> = { updatedAt: new Date() };
    if (hasCredentials) {
      setClause.credentialsEncrypted = encryptCredentials(parsed.data.credentials!);
    }
    if (parsed.data.enabled !== undefined) {
      setClause.enabled = parsed.data.enabled;
    }

    await db
      .insert(providerCredentials)
      .values({
        providerId,
        orgId,
        credentialsEncrypted: hasCredentials ? encryptCredentials(parsed.data.credentials!) : null,
        enabled: parsed.data.enabled ?? false,
      })
      .onConflictDoUpdate({
        target: [providerCredentials.providerId, providerCredentials.orgId],
        set: setClause,
      });

    return c.json({ configured: true });
  });

  // DELETE /api/providers/credentials/:scope/:name — delete credentials for a provider
  router.delete("/credentials/:scope{@[^/]+}/:name", async (c) => {
    const orgId = c.get("orgId");
    const providerId = `${c.req.param("scope")}/${c.req.param("name")}`;

    await db
      .update(providerCredentials)
      .set({ credentialsEncrypted: null, enabled: false, updatedAt: new Date() })
      .where(
        and(eq(providerCredentials.providerId, providerId), eq(providerCredentials.orgId, orgId)),
      );

    return c.json({ configured: false });
  });

  // DELETE /api/providers/:scope/:name — delete provider (custom only)
  router.delete("/:scope{@[^/]+}/:name", async (c) => {
    const orgId = c.get("orgId");
    const providerId = `${c.req.param("scope")}/${c.req.param("name")}`;

    // Block deleting system providers (DB-based guard)
    if (await isSystemProviderInDb(providerId)) {
      return c.json(
        {
          error: "OPERATION_NOT_ALLOWED",
          message: `Cannot delete system provider '${providerId}'`,
        },
        403,
      );
    }

    // Block deleting providers that are in use by flows
    const allFlows = await listPackages(orgId);
    let usageCount = 0;
    for (const flow of allFlows) {
      for (const svc of resolveManifestServices(flow.manifest)) {
        if (svc.id === providerId) {
          usageCount++;
          break;
        }
      }
    }
    if (usageCount > 0) {
      return c.json(
        {
          error: "PROVIDER_IN_USE",
          message: `Cannot delete provider '${providerId}': used by ${usageCount} flow(s)`,
        },
        409,
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
      return c.json({ error: "INTERNAL_ERROR", message: "Failed to delete provider" }, 500);
    }

    return c.body(null, 204);
  });

  return router;
}
