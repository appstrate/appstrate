// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { listResponse } from "../lib/list-response.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { isSystemModelProviderKey } from "../services/model-registry.ts";
import {
  listOrgModelProviderKeys,
  createOrgModelProviderKey,
  updateOrgModelProviderKey,
  deleteOrgModelProviderKey,
  testModelProviderKeyConnection,
  loadModelProviderKeyCredentials,
} from "../services/org-model-provider-keys.ts";
import { listModelProviders } from "../services/oauth-model-providers/registry.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { testModelConfig } from "../services/org-models.ts";
import { logger } from "../lib/logger.ts";
import {
  ApiError,
  invalidRequest,
  notFound,
  internalError,
  parseBody,
  systemEntityForbidden,
} from "../lib/errors.ts";
import { recordAuditFromContext } from "../services/audit.ts";

export const createSchema = z.object({
  label: z.string().min(1, "label is required"),
  api: z.string().min(1, "api is required"),
  baseUrl: z.url({ error: "baseUrl must be a valid URL" }),
  apiKey: z.string().min(1, "apiKey is required"),
});

export const updateSchema = z.object({
  label: z.string().min(1).optional(),
  api: z.string().min(1).optional(),
  baseUrl: z.url().optional(),
  apiKey: z.string().min(1).optional(),
});

export const testInlineSchema = z.object({
  api: z.string().min(1),
  baseUrl: z.url(),
  apiKey: z.string().optional(),
  existingKeyId: z.string().optional(),
});

export function createModelProviderCredentialsRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/model-provider-credentials/registry — surfaces the in-code
  // MODEL_PROVIDERS registry so the UI can render a provider picker without
  // hard-coding the catalog client-side. Read-only; member-level scope is
  // sufficient (the catalog itself is non-sensitive metadata).
  router.get("/registry", requirePermission("model-provider-credentials", "read"), (c) => {
    const data = listModelProviders().map((p) => ({
      providerId: p.providerId,
      displayName: p.displayName,
      iconUrl: p.iconUrl,
      description: p.description ?? null,
      docsUrl: p.docsUrl ?? null,
      apiShape: p.apiShape,
      defaultBaseUrl: p.defaultBaseUrl,
      baseUrlOverridable: p.baseUrlOverridable,
      authMode: p.authMode,
      models: p.models.map((m) => ({
        id: m.id,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens ?? null,
        capabilities: m.capabilities,
      })),
    }));
    return c.json(listResponse(data));
  });

  // GET /api/model-provider-credentials
  router.get("/", requirePermission("model-provider-credentials", "read"), async (c) => {
    const orgId = c.get("orgId");
    const keys = await listOrgModelProviderKeys(orgId);
    return c.json(listResponse(keys));
  });

  // POST /api/model-provider-credentials
  router.post("/", requirePermission("model-provider-credentials", "write"), async (c) => {
    const orgId = c.get("orgId");
    const user = c.get("user");
    const body = await c.req.json();
    const data = parseBody(createSchema, body);
    try {
      const { label, api, baseUrl, apiKey } = data;
      const id = await createOrgModelProviderKey(orgId, label, api, baseUrl, apiKey, user.id);
      await recordAuditFromContext(c, {
        action: "model_provider_credential.created",
        resourceType: "model_provider_credential",
        resourceId: id,
        after: { label, api, baseUrl },
      });
      return c.json({ id }, 201);
    } catch (err) {
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
        const existing = await loadModelProviderKeyCredentials(orgId, data.existingKeyId);
        if (existing) apiKey = existing.apiKey;
      }
      if (!apiKey) {
        throw invalidRequest("API key is required");
      }
      try {
        const result = await testModelConfig({
          api: data.api,
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
        const result = await testModelProviderKeyConnection(orgId, id);
        if (result.error === "KEY_NOT_FOUND") {
          throw notFound("Model provider credential not found");
        }
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
      await updateOrgModelProviderKey(orgId, id, data);
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
      await deleteOrgModelProviderKey(orgId, id);
      await recordAuditFromContext(c, {
        action: "model_provider_credential.deleted",
        resourceType: "model_provider_credential",
        resourceId: id,
      });
      return c.body(null, 204);
    } catch (err) {
      logger.error("Model provider credential delete failed", {
        id,
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

  return router;
}
