// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { listResponse } from "../lib/list-response.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { isSystemModelProviderKey } from "../services/model-registry.ts";
import {
  createApiKeyCredential,
  deleteModelProviderCredential,
  deriveCredentialLabel,
  listOrgModelProviderCredentials,
  loadInferenceCredentials,
  updateModelProviderCredential,
} from "../services/model-providers/credentials.ts";
import { getModelProvider, listModelProviders } from "../services/model-providers/registry.ts";
import { listCatalogModels } from "../services/pricing-catalog.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import type { ProviderRegistryEntry, ProviderRegistryModelEntry } from "@appstrate/shared-types";
import type { ModelProviderDefinition } from "@appstrate/core/module";
import { testModelConfig } from "../services/org-models.ts";
import { logger } from "../lib/logger.ts";
import {
  ApiError,
  conflict,
  invalidRequest,
  notFound,
  internalError,
  parseBody,
  systemEntityForbidden,
} from "../lib/errors.ts";
import { recordAuditFromContext } from "../services/audit.ts";

export const createSchema = z.object({
  /**
   * Optional. When omitted, the server derives the label from the provider's
   * `displayName` and dedupes against existing org credentials. See
   * {@link deriveCredentialLabel}.
   */
  label: z.string().min(1).optional(),
  providerId: z.string().min(1, "providerId is required"),
  apiKey: z.string().min(1, "apiKey is required"),
  /** Required only for providers with `baseUrlOverridable: true` (e.g. `openai-compatible`). */
  baseUrlOverride: z.url({ error: "baseUrlOverride must be a valid URL" }).optional().nullable(),
});

/**
 * `apiShape` and `baseUrl` are intentionally absent — they are pinned by the
 * canonical `providerId` selected at create time and cannot be mutated.
 * To switch providers, delete the credential and re-create it.
 */
export const updateSchema = z.object({
  label: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
});

/** PG `foreign_key_violation`. Drizzle wraps the underlying postgres.js error
 * via `new Error(..., { cause })`, so the SQLSTATE code lives on `err.cause`. */
function isForeignKeyViolation(err: unknown): boolean {
  return pgErrorCode(err) === "23503";
}

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const top = (err as { code?: string }).code;
  if (typeof top === "string") return top;
  const cause = (err as { cause?: unknown }).cause;
  if (typeof cause === "object" && cause !== null) {
    const inner = (cause as { code?: string }).code;
    if (typeof inner === "string") return inner;
  }
  return undefined;
}

export const testInlineSchema = z.object({
  apiShape: z.string().min(1),
  baseUrl: z.url(),
  apiKey: z.string().optional(),
  existingKeyId: z.string().optional(),
});

/**
 * Build the picker-facing model list for one provider. The vendored
 * pricing catalog is the single source of truth for per-model metadata
 * — provider definitions just point at catalog ids via `featuredModels`.
 *
 *   - **Own catalog, no `catalogProviderId`** (openai/anthropic/mistral/
 *     google-ai/cerebras/groq/xai): expose every catalog entry; ids in
 *     `featuredModels` get `featured: true`.
 *   - **Foreign catalog** (`catalogProviderId` set — codex → openai,
 *     claude-code → anthropic): expose ONLY `featuredModels`, all
 *     marked `featured: true`. The underlying catalog has more models
 *     than the OAuth product exposes.
 *   - **No catalog** (`featuredModels` empty — openrouter live-search,
 *     openai-compatible Custom): empty list. The picker falls back to
 *     "Custom" or its own live-search UI.
 */
function serializeProviderModels(p: ModelProviderDefinition): ProviderRegistryModelEntry[] {
  const catalogKey = p.catalogProviderId ?? p.providerId;
  const catalog = listCatalogModels(catalogKey);
  if (catalog.length === 0) return [];

  const featuredSet = new Set(p.featuredModels);

  // Foreign-catalog providers expose featuredModels only (the underlying
  // catalog is wider than the OAuth surface). Own-catalog providers
  // expose everything.
  const surfaced = p.catalogProviderId ? catalog.filter((m) => featuredSet.has(m.id)) : catalog;

  return surfaced.map((m) => ({ ...m, featured: featuredSet.has(m.id) }));
}

export function createModelProviderCredentialsRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/model-provider-credentials/registry — surfaces the in-code
  // MODEL_PROVIDERS registry so the UI can render a provider picker without
  // hard-coding the catalog client-side. Read-only; admin-only because it
  // sits behind the same `model-provider-credentials:read` permission as
  // the rest of this resource (the catalog itself is non-sensitive metadata
  // — the gate is for surface uniformity, not the data).
  router.get("/registry", requirePermission("model-provider-credentials", "read"), (c) => {
    const data: ProviderRegistryEntry[] = listModelProviders().map((p) => ({
      providerId: p.providerId,
      displayName: p.displayName,
      iconUrl: p.iconUrl,
      description: p.description ?? null,
      docsUrl: p.docsUrl ?? null,
      apiShape: p.apiShape,
      defaultBaseUrl: p.defaultBaseUrl,
      baseUrlOverridable: p.baseUrlOverridable,
      authMode: p.authMode,
      featured: p.featured ?? false,
      models: serializeProviderModels(p),
    }));
    return c.json(listResponse(data));
  });

  // GET /api/model-provider-credentials
  router.get("/", requirePermission("model-provider-credentials", "read"), async (c) => {
    const orgId = c.get("orgId");
    const keys = await listOrgModelProviderCredentials(orgId);
    return c.json(listResponse(keys));
  });

  // POST /api/model-provider-credentials
  router.post("/", requirePermission("model-provider-credentials", "write"), async (c) => {
    const orgId = c.get("orgId");
    const user = c.get("user");
    const body = await c.req.json();
    const data = parseBody(createSchema, body);
    const { providerId, apiKey, baseUrlOverride } = data;

    const cfg = getModelProvider(providerId);
    if (!cfg) {
      throw invalidRequest(`Unknown providerId: ${providerId}`, "providerId");
    }
    if (cfg.authMode !== "api_key") {
      throw invalidRequest(
        `Provider ${providerId} requires OAuth; use the OAuth pairing flow instead`,
        "providerId",
      );
    }

    const label = data.label ?? (await deriveCredentialLabel(orgId, providerId));

    try {
      const id = await createApiKeyCredential({
        orgId,
        userId: user.id,
        label,
        providerId,
        apiKey,
        baseUrlOverride: baseUrlOverride ?? null,
      });
      await recordAuditFromContext(c, {
        action: "model_provider_credential.created",
        resourceType: "model_provider_credential",
        resourceId: id,
        after: { label, providerId, baseUrlOverride: baseUrlOverride ?? null },
      });
      return c.json({ id }, 201);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      logger.error("Model provider credential create failed", {
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

  // POST /api/model-provider-credentials/test — inline test (before saving)
  router.post(
    "/test",
    rateLimit(5),
    requirePermission("model-provider-credentials", "read"),
    async (c) => {
      const orgId = c.get("orgId");
      const body = await c.req.json();
      const data = parseBody(testInlineSchema, body);
      let { apiKey } = data;
      if (!apiKey && data.existingKeyId) {
        const existing = await loadInferenceCredentials(orgId, data.existingKeyId);
        if (existing) apiKey = existing.apiKey;
      }
      if (!apiKey) {
        throw invalidRequest("API key is required");
      }
      try {
        const result = await testModelConfig({
          apiShape: data.apiShape,
          baseUrl: data.baseUrl,
          modelId: "_test",
          apiKey,
        });
        return c.json(result);
      } catch (err) {
        logger.error("Model provider credential inline test failed", {
          error: getErrorMessage(err),
        });
        throw internalError();
      }
    },
  );

  // POST /api/model-provider-credentials/:id/test
  router.post(
    "/:id/test",
    rateLimit(5),
    requirePermission("model-provider-credentials", "read"),
    async (c) => {
      const orgId = c.get("orgId");
      const id = c.req.param("id")!;
      try {
        const creds = await loadInferenceCredentials(orgId, id);
        if (!creds) {
          throw notFound("Model provider credential not found");
        }
        // OAuth providers reject the dummy `_test` model id — fall back to
        // the registry's first model (sized for a low-cost probe regardless).
        let modelId = "_test";
        if (creds.providerId) {
          const cfg = getModelProvider(creds.providerId);
          if (cfg && cfg.featuredModels.length > 0) modelId = cfg.featuredModels[0]!;
        }
        const result = await testModelConfig({ ...creds, modelId });
        return c.json(result);
      } catch (err) {
        // Don't swallow our own structured errors — `notFound()` thrown
        // above must reach the global error handler as 404, not get
        // remapped to 500.
        if (err instanceof ApiError) throw err;
        logger.error("Model provider credential test failed", {
          id,
          error: getErrorMessage(err),
        });
        throw internalError();
      }
    },
  );

  // PUT /api/model-provider-credentials/:id
  router.put("/:id", requirePermission("model-provider-credentials", "write"), async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id")!;
    if (isSystemModelProviderKey(id)) {
      throw systemEntityForbidden("model provider credential", id);
    }
    const body = await c.req.json();
    const data = parseBody(updateSchema, body);
    try {
      await updateModelProviderCredential(orgId, id, data);
      const { apiKey: _apiKey, ...auditData } = data;
      await recordAuditFromContext(c, {
        action: "model_provider_credential.updated",
        resourceType: "model_provider_credential",
        resourceId: id,
        after: auditData as Record<string, unknown>,
      });
      return c.json({ id });
    } catch (err) {
      logger.error("Model provider credential update failed", {
        id,
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

  // DELETE /api/model-provider-credentials/:id
  router.delete("/:id", requirePermission("model-provider-credentials", "delete"), async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id")!;
    if (isSystemModelProviderKey(id)) {
      throw systemEntityForbidden("model provider credential", id, "delete");
    }
    try {
      await deleteModelProviderCredential(orgId, id);
      await recordAuditFromContext(c, {
        action: "model_provider_credential.deleted",
        resourceType: "model_provider_credential",
        resourceId: id,
      });
      return c.body(null, 204);
    } catch (err) {
      // `org_models.credential_id` has ON DELETE RESTRICT — surface the
      // PG `foreign_key_violation` (23503) as a 409 with an actionable
      // message rather than a generic 500.
      if (isForeignKeyViolation(err)) {
        throw conflict(
          "credential_in_use",
          "Cannot delete this credential while one or more models reference it. Detach the model first.",
        );
      }
      logger.error("Model provider credential delete failed", {
        id,
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

  return router;
}
