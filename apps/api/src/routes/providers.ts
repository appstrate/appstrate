import { Hono } from "hono";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { providerConfigs } from "@appstrate/db/schema";
import type { AppEnv } from "../types/index.ts";
import type { ProviderConfig, AvailableScope } from "@appstrate/shared-types";
import { requireAdmin } from "../middleware/guards.ts";
import { logger } from "../lib/logger.ts";
import { getBuiltInProviders, isBuiltInProvider, encrypt } from "@appstrate/connect";
import type { AuthMode } from "@appstrate/connect";
import { listFlows } from "../services/flow-service.ts";

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

const createProviderSchema = z.object({
  id: z.string().regex(SLUG_RE, "id must be lowercase alphanumeric with hyphens"),
  displayName: z.string().min(1, "displayName is required"),
  authMode: z.enum(["oauth2", "oauth1", "api_key", "basic", "custom", "proxy"]),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  authorizationUrl: z.string().optional(),
  tokenUrl: z.string().optional(),
  refreshUrl: z.string().optional(),
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

function rowToProviderConfig(
  row: typeof providerConfigs.$inferSelect,
  source: ProviderConfig["source"],
): ProviderConfig {
  return {
    id: row.id,
    displayName: row.displayName,
    authMode: row.authMode,
    source,
    hasClientId: !!row.clientIdEncrypted,
    hasClientSecret: !!row.clientSecretEncrypted,
    authorizationUrl: row.authorizationUrl ?? undefined,
    tokenUrl: row.tokenUrl ?? undefined,
    refreshUrl: row.refreshUrl ?? undefined,
    defaultScopes: row.defaultScopes ?? undefined,
    scopeSeparator: row.scopeSeparator ?? undefined,
    pkceEnabled: row.pkceEnabled ?? undefined,
    tokenAuthMethod: (row.tokenAuthMethod as ProviderConfig["tokenAuthMethod"]) ?? undefined,
    authorizationParams: (row.authorizationParams as Record<string, string>) ?? undefined,
    tokenParams: (row.tokenParams as Record<string, string>) ?? undefined,
    credentialSchema: (row.credentialSchema as unknown as Record<string, unknown>) ?? undefined,
    credentialFieldName: row.credentialFieldName ?? undefined,
    credentialHeaderName: row.credentialHeaderName ?? undefined,
    credentialHeaderPrefix: row.credentialHeaderPrefix ?? undefined,
    iconUrl: row.iconUrl ?? undefined,
    categories: row.categories ?? undefined,
    docsUrl: row.docsUrl ?? undefined,
    authorizedUris: row.authorizedUris?.length ? row.authorizedUris : undefined,
    allowAllUris: row.allowAllUris ?? undefined,
    availableScopes: (row.availableScopes as unknown as AvailableScope[])?.length
      ? (row.availableScopes as unknown as AvailableScope[])
      : undefined,
  };
}

export function createProvidersRouter() {
  const router = new Hono<AppEnv>();

  // All endpoints are admin-only
  router.use("*", requireAdmin());

  // GET /api/providers — list all providers (built-in + DB custom)
  router.get("/", async (c) => {
    const orgId = c.get("orgId");
    const builtIn = getBuiltInProviders();

    // Fetch all DB configs for this org
    const rows = await db.select().from(providerConfigs).where(eq(providerConfigs.orgId, orgId));

    // Count provider usage across all flows (built-in + user)
    const allFlows = await listFlows(orgId);
    const providerUsage = new Map<string, number>();
    for (const flow of allFlows) {
      for (const svc of flow.manifest.requires?.services ?? []) {
        providerUsage.set(svc.provider, (providerUsage.get(svc.provider) ?? 0) + 1);
      }
    }

    const providers: ProviderConfig[] = [];

    // Built-in providers — always source "built-in"
    for (const [id, def] of builtIn) {
      providers.push({
        id,
        displayName: def.displayName,
        authMode: def.authMode,
        source: "built-in",
        hasClientId: !!def.clientId,
        hasClientSecret: !!def.clientSecret,
        authorizationUrl: def.authorizationUrl,
        tokenUrl: def.tokenUrl,
        refreshUrl: def.refreshUrl,
        defaultScopes: def.defaultScopes,
        scopeSeparator: def.scopeSeparator,
        pkceEnabled: def.pkceEnabled,
        tokenAuthMethod: def.tokenAuthMethod,
        authorizationParams: def.authorizationParams,
        tokenParams: def.tokenParams,
        credentialSchema: def.credentialSchema as Record<string, unknown> | undefined,
        credentialFieldName: def.credentialFieldName,
        credentialHeaderName: def.credentialHeaderName,
        credentialHeaderPrefix: def.credentialHeaderPrefix,
        iconUrl: def.iconUrl,
        categories: def.categories,
        docsUrl: def.docsUrl,
        authorizedUris: def.authorizedUris,
        allowAllUris: def.allowAllUris,
        availableScopes: def.availableScopes,
        usedByFlows: providerUsage.get(id) ?? 0,
      });
    }

    // Custom providers (DB only, IDs different from built-in)
    for (const row of rows) {
      if (!builtIn.has(row.id)) {
        const cfg = rowToProviderConfig(row, "custom");
        cfg.usedByFlows = providerUsage.get(row.id) ?? 0;
        providers.push(cfg);
      }
    }

    return c.json({ providers });
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

    // Block creation if ID matches a built-in provider
    if (isBuiltInProvider(data.id)) {
      return c.json(
        {
          error: "OPERATION_NOT_ALLOWED",
          message: `Cannot create provider '${data.id}': conflicts with a built-in provider`,
        },
        403,
      );
    }

    // Check ID doesn't already exist in DB for this org
    const existing = await db
      .select({ id: providerConfigs.id })
      .from(providerConfigs)
      .where(and(eq(providerConfigs.orgId, orgId), eq(providerConfigs.id, data.id)))
      .limit(1);

    if (existing.length > 0) {
      return c.json(
        { error: "NAME_COLLISION", message: `Provider '${data.id}' already exists` },
        400,
      );
    }

    // Force defaults for proxy providers
    if (data.authMode === "proxy") {
      data.allowAllUris = true;
      data.credentialFieldName = "url";
      data.credentialSchema = {
        type: "object",
        properties: {
          url: { type: "string", description: "Proxy URL (http://user:pass@host:port)" },
        },
        required: ["url"],
      };
      if (!data.categories?.includes("proxy")) {
        data.categories = [...(data.categories ?? []), "proxy"];
      }
    }

    try {
      await db.insert(providerConfigs).values({
        id: data.id,
        orgId,
        displayName: data.displayName,
        authMode: data.authMode as AuthMode,
        authorizationUrl: data.authorizationUrl ?? null,
        tokenUrl: data.tokenUrl ?? null,
        refreshUrl: data.refreshUrl ?? null,
        defaultScopes: data.defaultScopes ?? [],
        scopeSeparator: data.scopeSeparator ?? " ",
        pkceEnabled: data.pkceEnabled ?? true,
        tokenAuthMethod: data.tokenAuthMethod ?? null,
        authorizationParams: data.authorizationParams ?? {},
        tokenParams: data.tokenParams ?? {},
        credentialSchema: data.credentialSchema ?? null,
        credentialFieldName: data.credentialFieldName ?? null,
        credentialHeaderName: data.credentialHeaderName ?? null,
        credentialHeaderPrefix: data.credentialHeaderPrefix ?? null,
        iconUrl: data.iconUrl ?? null,
        categories: data.categories ?? [],
        docsUrl: data.docsUrl ?? null,
        clientIdEncrypted: data.clientId ? encrypt(data.clientId) : null,
        clientSecretEncrypted: data.clientSecret ? encrypt(data.clientSecret) : null,
        authorizedUris: data.authorizedUris ?? [],
        allowAllUris: data.allowAllUris ?? false,
        availableScopes: data.availableScopes ?? [],
      });
    } catch (err) {
      logger.error("Provider create failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "INTERNAL_ERROR", message: "Failed to create provider" }, 500);
    }

    return c.json({ id: data.id }, 201);
  });

  // PUT /api/providers/:id — update a provider (custom only)
  router.put("/:id", async (c) => {
    const orgId = c.get("orgId");
    const providerId = c.req.param("id");
    const body = await c.req.json();
    const parsed = updateProviderSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", message: parsed.error.issues[0]!.message }, 400);
    }

    // Block editing built-in providers
    if (isBuiltInProvider(providerId)) {
      return c.json(
        {
          error: "OPERATION_NOT_ALLOWED",
          message: `Cannot modify built-in provider '${providerId}'`,
        },
        403,
      );
    }

    const data = parsed.data;

    // Fetch existing row
    const existingRows = await db
      .select()
      .from(providerConfigs)
      .where(and(eq(providerConfigs.orgId, orgId), eq(providerConfigs.id, providerId)))
      .limit(1);

    const existing = existingRows[0];
    if (!existing) {
      return c.json({ error: "NOT_FOUND", message: `Provider '${providerId}' not found` }, 404);
    }

    const displayName = data.displayName ?? existing.displayName;
    const authMode = (data.authMode as AuthMode) ?? existing.authMode;

    // Force defaults for proxy providers
    if (authMode === "proxy") {
      data.allowAllUris = true;
      data.credentialFieldName = "url";
      data.credentialSchema = data.credentialSchema ?? {
        type: "object",
        properties: {
          url: { type: "string", description: "Proxy URL (http://user:pass@host:port)" },
        },
        required: ["url"],
      };
      if (!(data.categories ?? existing.categories ?? []).includes("proxy")) {
        data.categories = [...(data.categories ?? existing.categories ?? []), "proxy"];
      }
    }

    // Handle secrets: encrypt if provided, preserve existing if omitted/empty
    let clientIdEncrypted: string | null = existing.clientIdEncrypted ?? null;
    let clientSecretEncrypted: string | null = existing.clientSecretEncrypted ?? null;

    if (data.clientId && data.clientId.length > 0) {
      clientIdEncrypted = encrypt(data.clientId);
    }
    if (data.clientSecret && data.clientSecret.length > 0) {
      clientSecretEncrypted = encrypt(data.clientSecret);
    }

    try {
      await db
        .update(providerConfigs)
        .set({
          displayName,
          authMode,
          authorizationUrl: data.authorizationUrl ?? existing.authorizationUrl ?? null,
          tokenUrl: data.tokenUrl ?? existing.tokenUrl ?? null,
          refreshUrl: data.refreshUrl ?? existing.refreshUrl ?? null,
          defaultScopes: data.defaultScopes ?? existing.defaultScopes ?? [],
          scopeSeparator: data.scopeSeparator ?? existing.scopeSeparator ?? " ",
          pkceEnabled: data.pkceEnabled ?? existing.pkceEnabled ?? true,
          tokenAuthMethod: data.tokenAuthMethod ?? existing.tokenAuthMethod ?? null,
          authorizationParams: data.authorizationParams ?? existing.authorizationParams ?? {},
          tokenParams: data.tokenParams ?? existing.tokenParams ?? {},
          credentialSchema: data.credentialSchema ?? existing.credentialSchema ?? null,
          credentialFieldName: data.credentialFieldName ?? existing.credentialFieldName ?? null,
          credentialHeaderName: data.credentialHeaderName ?? existing.credentialHeaderName ?? null,
          credentialHeaderPrefix:
            data.credentialHeaderPrefix ?? existing.credentialHeaderPrefix ?? null,
          iconUrl: data.iconUrl ?? existing.iconUrl ?? null,
          categories: data.categories ?? existing.categories ?? [],
          docsUrl: data.docsUrl ?? existing.docsUrl ?? null,
          clientIdEncrypted,
          clientSecretEncrypted,
          authorizedUris: data.authorizedUris ?? existing.authorizedUris ?? [],
          allowAllUris: data.allowAllUris ?? existing.allowAllUris ?? false,
          availableScopes: data.availableScopes ?? existing.availableScopes ?? [],
          updatedAt: new Date(),
        })
        .where(and(eq(providerConfigs.orgId, orgId), eq(providerConfigs.id, providerId)));
    } catch (err) {
      logger.error("Provider update failed", {
        providerId,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "INTERNAL_ERROR", message: "Failed to update provider" }, 500);
    }

    return c.json({ id: providerId });
  });

  // DELETE /api/providers/:id — delete provider DB config (custom only)
  router.delete("/:id", async (c) => {
    const orgId = c.get("orgId");
    const providerId = c.req.param("id");

    // Block deleting built-in providers
    if (isBuiltInProvider(providerId)) {
      return c.json(
        {
          error: "OPERATION_NOT_ALLOWED",
          message: `Cannot delete built-in provider '${providerId}'`,
        },
        403,
      );
    }

    // Block deleting providers that are in use by flows
    const allFlows = await listFlows(orgId);
    let usageCount = 0;
    for (const flow of allFlows) {
      for (const svc of flow.manifest.requires?.services ?? []) {
        if (svc.provider === providerId) {
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
      await db
        .delete(providerConfigs)
        .where(and(eq(providerConfigs.orgId, orgId), eq(providerConfigs.id, providerId)));
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
