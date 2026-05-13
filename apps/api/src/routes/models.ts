// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { listResponse } from "../lib/list-response.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { isSystemModel } from "../services/model-registry.ts";
import { modelCostSchema } from "@appstrate/shared-types";
import {
  listOrgModels,
  createOrgModel,
  updateOrgModel,
  deleteOrgModel,
  setDefaultModel,
  seedOrgModelsForCredential,
  testModelConnection,
  testModelConfig,
  loadModel,
  type SeedModelEntry,
} from "../services/org-models.ts";
import { getModelProvider } from "../services/model-providers/registry.ts";
import { loadInferenceCredentials } from "../services/model-providers/credentials.ts";
import { getErrorMessage } from "@appstrate/core/errors";
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

export const createModelSchema = z.object({
  label: z.string().min(1, "label is required"),
  apiShape: z.string().min(1, "apiShape is required"),
  baseUrl: z.url({ error: "baseUrl must be a valid URL" }),
  modelId: z.string().min(1, "modelId is required"),
  credentialId: z.string().min(1, "credentialId is required"),
  input: z.array(z.string()).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  reasoning: z.boolean().optional(),
  cost: modelCostSchema.optional(),
});

export const updateModelSchema = z.object({
  label: z.string().min(1).optional(),
  apiShape: z.string().min(1).optional(),
  baseUrl: z.url().optional(),
  modelId: z.string().min(1).optional(),
  credentialId: z.string().optional(),
  enabled: z.boolean().optional(),
  input: z.array(z.string()).nullable().optional(),
  contextWindow: z.number().int().positive().nullable().optional(),
  maxTokens: z.number().int().positive().nullable().optional(),
  reasoning: z.boolean().nullable().optional(),
  cost: modelCostSchema.nullable().optional(),
});

export const setDefaultSchema = z.object({
  modelId: z.string().nullable(),
});

export const seedModelsSchema = z.object({
  credentialId: z.string().min(1, "credentialId is required"),
  modelIds: z.array(z.string().min(1)).min(1, "at least one modelId is required").max(50),
});

export const testInlineSchema = z.object({
  apiShape: z.string().min(1),
  baseUrl: z.url(),
  modelId: z.string().min(1),
  apiKey: z.string().optional(),
  existingModelId: z.string().optional(),
});

export function createModelsRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/models — list all models (system + DB)
  router.get("/", requirePermission("models", "read"), async (c) => {
    const orgId = c.get("orgId");
    const models = await listOrgModels(orgId);
    return c.json(listResponse(models));
  });

  // POST /api/models — create a custom model
  router.post("/", requirePermission("models", "write"), async (c) => {
    const orgId = c.get("orgId");
    const user = c.get("user");
    const body = await c.req.json();
    const data = parseBody(createModelSchema, body);

    try {
      const {
        label,
        apiShape,
        baseUrl,
        modelId,
        credentialId,
        input,
        contextWindow,
        maxTokens,
        reasoning,
        cost,
      } = data;
      const id = await createOrgModel(
        orgId,
        label,
        apiShape,
        baseUrl,
        modelId,
        user.id,
        credentialId,
        {
          input,
          contextWindow,
          maxTokens,
          reasoning,
          cost,
        },
      );
      await recordAuditFromContext(c, {
        action: "model.created",
        resourceType: "model",
        resourceId: id,
        after: { label, apiShape, baseUrl, modelId, credentialId },
      });
      return c.json({ id }, 201);
    } catch (err) {
      logger.error("Model create failed", {
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

  // POST /api/models/seed — bulk-seed models from the registry for one credential.
  // The credential's providerId pins the registry entry; modelIds are validated
  // against it. Atomic — either all rows insert or none. Idempotent: returns
  // `created: 0` when the org already has any model bound to this credential.
  router.post("/seed", requirePermission("models", "write"), async (c) => {
    const orgId = c.get("orgId");
    const user = c.get("user");
    const body = await c.req.json();
    const data = parseBody(seedModelsSchema, body);

    const creds = await loadInferenceCredentials(orgId, data.credentialId);
    if (!creds || !creds.providerId) {
      throw notFound("Credential not found or not registry-bound");
    }
    const registry = getModelProvider(creds.providerId);
    if (!registry) {
      throw notFound(`Provider ${creds.providerId} not registered`);
    }

    const knownIds = new Map(registry.models.map((m) => [m.id, m]));
    const entries: SeedModelEntry[] = [];
    for (const modelId of data.modelIds) {
      const model = knownIds.get(modelId);
      if (!model) {
        throw invalidRequest(`Model ${modelId} is not part of provider ${creds.providerId}`);
      }
      entries.push({
        modelId: model.id,
        label: model.id,
        apiShape: registry.apiShape,
        baseUrl: creds.baseUrl,
        input: model.capabilities.filter(
          (c): c is "text" | "image" => c === "text" || c === "image",
        ),
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens ?? undefined,
        reasoning: model.capabilities.includes("reasoning"),
      });
    }

    try {
      const result = await seedOrgModelsForCredential(orgId, user.id, data.credentialId, entries);
      await recordAuditFromContext(c, {
        action: "model.seeded",
        resourceType: "model",
        resourceId: data.credentialId,
        after: {
          credentialId: data.credentialId,
          providerId: creds.providerId,
          created: result.created,
          ids: result.ids,
          promotedDefault: result.promotedDefault,
        },
      });
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      logger.error("Model seed failed", { error: getErrorMessage(err) });
      throw internalError();
    }
  });

  // PUT /api/models/default — set the org default model
  // MUST be registered before PUT /:id
  router.put("/default", requirePermission("models", "write"), async (c) => {
    const orgId = c.get("orgId");
    const body = await c.req.json();
    const data = parseBody(setDefaultSchema, body);

    try {
      await setDefaultModel(orgId, data.modelId);
      await recordAuditFromContext(c, {
        action: "model.default_set",
        resourceType: "model",
        resourceId: data.modelId,
      });
      return c.json({ success: true });
    } catch (err) {
      logger.error("Set default model failed", {
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

  // GET /api/models/openrouter — search OpenRouter models (proxy)
  router.get("/openrouter", rateLimit(10), async (c) => {
    const q = c.req.query("q") || "";

    try {
      const res = await fetch("https://openrouter.ai/api/v1/models", {
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        throw new ApiError({
          status: 502,
          code: "provider_error",
          title: "Provider Error",
          detail: `OpenRouter returned ${res.status}`,
        });
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json: any = await res.json();
      const rawModels = json?.data;

      if (!Array.isArray(rawModels)) {
        return c.json(listResponse<unknown>([]));
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let models = rawModels.map((m: any) => {
        // OpenRouter pricing is per-token; convert to $/M tokens for ModelCost
        const pricing = m.pricing;
        const promptPerToken = parseFloat(pricing?.prompt);
        const completionPerToken = parseFloat(pricing?.completion);
        const cacheReadPerToken = parseFloat(pricing?.input_cache_read);
        const hasValidPricing = !isNaN(promptPerToken) && !isNaN(completionPerToken);

        return {
          id: String(m.id ?? ""),
          name: String(m.name || m.id || ""),
          contextWindow: typeof m.context_length === "number" ? m.context_length : null,
          maxTokens:
            typeof m.top_provider?.max_completion_tokens === "number"
              ? m.top_provider.max_completion_tokens
              : null,
          input: m.architecture?.input_modalities?.includes?.("image")
            ? ["text", "image"]
            : ["text"],
          reasoning: false,
          cost: hasValidPricing
            ? {
                input: promptPerToken * 1_000_000,
                output: completionPerToken * 1_000_000,
                cacheRead: isNaN(cacheReadPerToken) ? 0 : cacheReadPerToken * 1_000_000,
                cacheWrite: 0,
              }
            : null,
        };
      });

      // Filter by search query
      if (q.trim()) {
        const lower = q.toLowerCase();
        models = models.filter(
          (m) => m.id.toLowerCase().includes(lower) || m.name.toLowerCase().includes(lower),
        );
      }

      // Limit results
      models = models.slice(0, 50);

      return c.json(listResponse(models));
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err instanceof DOMException && err.name === "TimeoutError") {
        throw new ApiError({
          status: 504,
          code: "timeout",
          title: "Gateway Timeout",
          detail: "OpenRouter request timed out",
        });
      }
      logger.error("OpenRouter model search failed", {
        error: getErrorMessage(err),
      });
      throw new ApiError({
        status: 502,
        code: "network_error",
        title: "Bad Gateway",
        detail: "Failed to fetch OpenRouter models",
      });
    }
  });

  // POST /api/models/test — test model config inline (before saving)
  // MUST be registered before /:id/test
  router.post("/test", rateLimit(5), async (c) => {
    const orgId = c.get("orgId");
    const body = await c.req.json();
    const data = parseBody(testInlineSchema, body);

    let { apiKey } = data;

    // In edit mode, if no apiKey provided, fall back to the stored key
    if (!apiKey && data.existingModelId) {
      const existing = await loadModel(orgId, data.existingModelId);
      if (existing) apiKey = existing.apiKey;
    }

    if (!apiKey) {
      throw invalidRequest("API key is required");
    }

    try {
      const result = await testModelConfig({
        apiShape: data.apiShape,
        baseUrl: data.baseUrl,
        modelId: data.modelId,
        apiKey,
      });
      return c.json(result);
    } catch (err) {
      logger.error("Model inline test failed", {
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

  // POST /api/models/:id/test — test model connection
  router.post("/:id/test", rateLimit(5), async (c) => {
    const orgId = c.get("orgId");
    const modelId = c.req.param("id")!;
    try {
      const result = await testModelConnection(orgId, modelId);
      if (result.error === "MODEL_NOT_FOUND") {
        throw notFound("Model not found");
      }
      return c.json(result);
    } catch (err) {
      logger.error("Model test failed", {
        modelId,
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

  // PUT /api/models/:id — update a custom model
  router.put("/:id", requirePermission("models", "write"), async (c) => {
    const orgId = c.get("orgId");
    const modelId = c.req.param("id")!;
    const body = await c.req.json();
    const data = parseBody(updateModelSchema, body);

    if (isSystemModel(modelId)) {
      throw systemEntityForbidden("model", modelId);
    }

    try {
      await updateOrgModel(orgId, modelId, data);
      await recordAuditFromContext(c, {
        action: "model.updated",
        resourceType: "model",
        resourceId: modelId,
        after: data as unknown as Record<string, unknown>,
      });
      return c.json({ id: modelId });
    } catch (err) {
      logger.error("Model update failed", {
        modelId,
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

  // DELETE /api/models/:id — delete a custom model
  router.delete("/:id", requirePermission("models", "delete"), async (c) => {
    const orgId = c.get("orgId");
    const modelId = c.req.param("id")!;

    if (isSystemModel(modelId)) {
      throw systemEntityForbidden("model", modelId, "delete");
    }

    try {
      await deleteOrgModel(orgId, modelId);
      await recordAuditFromContext(c, {
        action: "model.deleted",
        resourceType: "model",
        resourceId: modelId,
      });
      return c.body(null, 204);
    } catch (err) {
      logger.error("Model delete failed", {
        modelId,
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

  return router;
}
