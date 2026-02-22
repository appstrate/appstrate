import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import type { ProviderConfig, TablesInsert, Json } from "@appstrate/shared-types";
import { requireAdmin } from "../middleware/guards.ts";
import { supabase } from "../lib/supabase.ts";
import { getBuiltInProviders, isBuiltInProvider, encrypt } from "@appstrate/connect";
import type { ProviderConfigRow, AuthMode } from "@appstrate/connect";

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

const createProviderSchema = z.object({
  id: z.string().regex(SLUG_RE, "id must be lowercase alphanumeric with hyphens"),
  displayName: z.string().min(1, "displayName is required"),
  authMode: z.enum(["oauth2", "api_key", "basic", "custom"]),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  authorizationUrl: z.string().optional(),
  tokenUrl: z.string().optional(),
  refreshUrl: z.string().optional(),
  defaultScopes: z.array(z.string()).optional(),
  scopeSeparator: z.string().optional(),
  pkceEnabled: z.boolean().optional(),
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
});

const updateProviderSchema = createProviderSchema.omit({ id: true }).partial();

function rowToProviderConfig(
  row: ProviderConfigRow,
  source: ProviderConfig["source"],
): ProviderConfig {
  return {
    id: row.id,
    displayName: row.display_name,
    authMode: row.auth_mode,
    source,
    hasClientId: !!row.client_id_encrypted,
    hasClientSecret: !!row.client_secret_encrypted,
    authorizationUrl: row.authorization_url ?? undefined,
    tokenUrl: row.token_url ?? undefined,
    refreshUrl: row.refresh_url ?? undefined,
    defaultScopes: row.default_scopes ?? undefined,
    scopeSeparator: row.scope_separator ?? undefined,
    pkceEnabled: row.pkce_enabled ?? undefined,
    authorizationParams: (row.authorization_params as Record<string, string>) ?? undefined,
    tokenParams: (row.token_params as Record<string, string>) ?? undefined,
    credentialSchema: (row.credential_schema as unknown as Record<string, unknown>) ?? undefined,
    credentialFieldName: row.credential_field_name ?? undefined,
    credentialHeaderName: row.credential_header_name ?? undefined,
    credentialHeaderPrefix: row.credential_header_prefix ?? undefined,
    iconUrl: row.icon_url ?? undefined,
    categories: row.categories ?? undefined,
    docsUrl: row.docs_url ?? undefined,
    authorizedUris: row.authorized_uris?.length ? row.authorized_uris : undefined,
    allowAllUris: row.allow_all_uris ?? undefined,
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
    const { data: rows, error } = await supabase
      .from("provider_configs")
      .select("*")
      .eq("org_id", orgId);

    if (error) {
      return c.json({ error: "DB_ERROR", message: error.message }, 500);
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
      });
    }

    // Custom providers (DB only, IDs different from built-in)
    for (const row of (rows ?? []) as ProviderConfigRow[]) {
      if (!builtIn.has(row.id)) {
        providers.push(rowToProviderConfig(row, "custom"));
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
    const { data: existing } = await supabase
      .from("provider_configs")
      .select("id")
      .eq("org_id", orgId)
      .eq("id", data.id)
      .single();

    if (existing) {
      return c.json(
        { error: "NAME_COLLISION", message: `Provider '${data.id}' already exists` },
        400,
      );
    }

    const row: TablesInsert<"provider_configs"> = {
      id: data.id,
      org_id: orgId,
      display_name: data.displayName,
      auth_mode: data.authMode,
      authorization_url: data.authorizationUrl ?? null,
      token_url: data.tokenUrl ?? null,
      refresh_url: data.refreshUrl ?? null,
      default_scopes: data.defaultScopes ?? [],
      scope_separator: data.scopeSeparator ?? " ",
      pkce_enabled: data.pkceEnabled ?? true,
      authorization_params: (data.authorizationParams ?? {}) as Json,
      token_params: (data.tokenParams ?? {}) as Json,
      credential_schema: (data.credentialSchema ?? null) as Json,
      credential_field_name: data.credentialFieldName ?? null,
      credential_header_name: data.credentialHeaderName ?? null,
      credential_header_prefix: data.credentialHeaderPrefix ?? null,
      icon_url: data.iconUrl ?? null,
      categories: data.categories ?? [],
      docs_url: data.docsUrl ?? null,
      client_id_encrypted: data.clientId ? encrypt(data.clientId) : null,
      client_secret_encrypted: data.clientSecret ? encrypt(data.clientSecret) : null,
      authorized_uris: data.authorizedUris ?? [],
      allow_all_uris: data.allowAllUris ?? false,
    };

    const { error } = await supabase.from("provider_configs").insert(row);

    if (error) {
      return c.json({ error: "DB_ERROR", message: error.message }, 500);
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
    const { data: existingRow } = await supabase
      .from("provider_configs")
      .select("*")
      .eq("org_id", orgId)
      .eq("id", providerId)
      .single();

    const existing = existingRow as ProviderConfigRow | null;

    if (!existing) {
      return c.json({ error: "NOT_FOUND", message: `Provider '${providerId}' not found` }, 404);
    }

    const displayName = data.displayName ?? existing.display_name;
    const authMode = (data.authMode as AuthMode) ?? existing.auth_mode;

    // Handle secrets: encrypt if provided, preserve existing if omitted/empty
    let clientIdEncrypted: string | null = existing.client_id_encrypted ?? null;
    let clientSecretEncrypted: string | null = existing.client_secret_encrypted ?? null;

    if (data.clientId && data.clientId.length > 0) {
      clientIdEncrypted = encrypt(data.clientId);
    }
    if (data.clientSecret && data.clientSecret.length > 0) {
      clientSecretEncrypted = encrypt(data.clientSecret);
    }

    const row: TablesInsert<"provider_configs"> = {
      id: providerId,
      org_id: orgId,
      display_name: displayName,
      auth_mode: authMode,
      authorization_url: data.authorizationUrl ?? existing.authorization_url ?? null,
      token_url: data.tokenUrl ?? existing.token_url ?? null,
      refresh_url: data.refreshUrl ?? existing.refresh_url ?? null,
      default_scopes: data.defaultScopes ?? existing.default_scopes ?? [],
      scope_separator: data.scopeSeparator ?? existing.scope_separator ?? " ",
      pkce_enabled: data.pkceEnabled ?? existing.pkce_enabled ?? true,
      authorization_params: (data.authorizationParams ??
        existing.authorization_params ??
        {}) as Json,
      token_params: (data.tokenParams ?? existing.token_params ?? {}) as Json,
      credential_schema: (data.credentialSchema ?? existing.credential_schema ?? null) as Json,
      credential_field_name: data.credentialFieldName ?? existing.credential_field_name ?? null,
      credential_header_name: data.credentialHeaderName ?? existing.credential_header_name ?? null,
      credential_header_prefix:
        data.credentialHeaderPrefix ?? existing.credential_header_prefix ?? null,
      icon_url: data.iconUrl ?? existing.icon_url ?? null,
      categories: data.categories ?? existing.categories ?? [],
      docs_url: data.docsUrl ?? existing.docs_url ?? null,
      client_id_encrypted: clientIdEncrypted,
      client_secret_encrypted: clientSecretEncrypted,
      authorized_uris: data.authorizedUris ?? existing.authorized_uris ?? [],
      allow_all_uris: data.allowAllUris ?? existing.allow_all_uris ?? false,
    };

    const { error } = await supabase
      .from("provider_configs")
      .upsert(row, { onConflict: "org_id,id" });

    if (error) {
      return c.json({ error: "DB_ERROR", message: error.message }, 500);
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

    const { error } = await supabase
      .from("provider_configs")
      .delete()
      .eq("org_id", orgId)
      .eq("id", providerId);

    if (error) {
      return c.json({ error: "DB_ERROR", message: error.message }, 500);
    }

    return c.body(null, 204);
  });

  return router;
}
