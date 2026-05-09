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
import { getErrorMessage } from "@appstrate/core/errors";
import { testModelConfig } from "../services/org-models.ts";
import { logger } from "../lib/logger.ts";
import {
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

export function createModelProviderKeysRouter() {
  const router = new Hono<AppEnv>();
  // GET /api/model-provider-keys
  router.get("/", requirePermission("model-provider-keys", "read"), async (c) => {
    const orgId = c.get("orgId");
    const keys = await listOrgModelProviderKeys(orgId);
    return c.json(listResponse(keys));
  });

  // POST /api/model-provider-keys
  router.post("/", requirePermission("model-provider-keys", "write"), async (c) => {
    const orgId = c.get("orgId");
    const user = c.get("user");
    const body = await c.req.json();
    const data = parseBody(createSchema, body);
    try {
      const { label, api, baseUrl, apiKey } = data;
      const id = await createOrgModelProviderKey(orgId, label, api, baseUrl, apiKey, user.id);
      await recordAuditFromContext(c, {
        action: "model_provider_key.created",
        resourceType: "model_provider_key",
        resourceId: id,
        after: { label, api, baseUrl },
      });
      return c.json({ id }, 201);
    } catch (err) {
      logger.error("Model provider key create failed", {
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

  // POST /api/model-provider-keys/test — inline test (before saving)
  router.post(
    "/test",
    rateLimit(5),
    requirePermission("model-provider-keys", "read"),
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
        logger.error("Model provider key inline test failed", {
          error: getErrorMessage(err),
        });
        throw internalError();
      }
    },
  );

  // POST /api/model-provider-keys/:id/test
  router.post(
    "/:id/test",
    rateLimit(5),
    requirePermission("model-provider-keys", "read"),
    async (c) => {
      const orgId = c.get("orgId");
      const id = c.req.param("id")!;
      try {
        const result = await testModelProviderKeyConnection(orgId, id);
        if (result.error === "KEY_NOT_FOUND") {
          throw notFound("Model provider key not found");
        }
        return c.json(result);
      } catch (err) {
        logger.error("Model provider key test failed", {
          id,
          error: getErrorMessage(err),
        });
        throw internalError();
      }
    },
  );

  // PUT /api/model-provider-keys/:id
  router.put("/:id", requirePermission("model-provider-keys", "write"), async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id")!;
    if (isSystemModelProviderKey(id)) {
      throw systemEntityForbidden("model provider key", id);
    }
    const body = await c.req.json();
    const data = parseBody(updateSchema, body);
    try {
      await updateOrgModelProviderKey(orgId, id, data);
      const { apiKey: _apiKey, ...auditData } = data;
      await recordAuditFromContext(c, {
        action: "model_provider_key.updated",
        resourceType: "model_provider_key",
        resourceId: id,
        after: auditData as Record<string, unknown>,
      });
      return c.json({ id });
    } catch (err) {
      logger.error("Model provider key update failed", {
        id,
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

  // DELETE /api/model-provider-keys/:id
  router.delete("/:id", requirePermission("model-provider-keys", "delete"), async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id")!;
    if (isSystemModelProviderKey(id)) {
      throw systemEntityForbidden("model provider key", id, "delete");
    }
    try {
      await deleteOrgModelProviderKey(orgId, id);
      await recordAuditFromContext(c, {
        action: "model_provider_key.deleted",
        resourceType: "model_provider_key",
        resourceId: id,
      });
      return c.body(null, 204);
    } catch (err) {
      logger.error("Model provider key delete failed", {
        id,
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

  return router;
}
