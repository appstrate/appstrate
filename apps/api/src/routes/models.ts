import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { isSystemModel } from "../services/model-registry.ts";
import { modelCostSchema } from "../services/adapters/types.ts";
import {
  listOrgModels,
  createOrgModel,
  updateOrgModel,
  deleteOrgModel,
  setDefaultModel,
  testModelConnection,
  testModelConfig,
  loadModel,
} from "../services/org-models.ts";
import { logger } from "../lib/logger.ts";
import {
  ApiError,
  invalidRequest,
  notFound,
  internalError,
  parseBody,
  systemEntityForbidden,
} from "../lib/errors.ts";

const createModelSchema = z.object({
  label: z.string().min(1, "label is required"),
  api: z.string().min(1, "api is required"),
  baseUrl: z.url({ error: "baseUrl must be a valid URL" }),
  modelId: z.string().min(1, "modelId is required"),
  providerKeyId: z.string().min(1, "providerKeyId is required"),
  input: z.array(z.string()).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  reasoning: z.boolean().optional(),
  cost: modelCostSchema.optional(),
});

const updateModelSchema = z.object({
  label: z.string().min(1).optional(),
  api: z.string().min(1).optional(),
  baseUrl: z.url().optional(),
  modelId: z.string().min(1).optional(),
  providerKeyId: z.string().optional(),
  enabled: z.boolean().optional(),
  input: z.array(z.string()).nullable().optional(),
  contextWindow: z.number().int().positive().nullable().optional(),
  maxTokens: z.number().int().positive().nullable().optional(),
  reasoning: z.boolean().nullable().optional(),
  cost: modelCostSchema.nullable().optional(),
});

const setDefaultSchema = z.object({
  modelId: z.string().nullable(),
});

const testInlineSchema = z.object({
  api: z.string().min(1),
  baseUrl: z.url(),
  modelId: z.string().min(1),
  apiKey: z.string().optional(),
  existingModelId: z.string().optional(),
});

export function createModelsRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/models — list all models (system + DB)
  router.get("/", async (c) => {
    const orgId = c.get("orgId");
    const models = await listOrgModels(orgId);
    return c.json({ models });
  });

  // POST /api/models — create a custom model
  router.post("/", async (c) => {
    const orgId = c.get("orgId");
    const user = c.get("user");
    const body = await c.req.json();
    const data = parseBody(createModelSchema, body);

    try {
      const {
        label,
        api,
        baseUrl,
        modelId,
        providerKeyId,
        input,
        contextWindow,
        maxTokens,
        reasoning,
        cost,
      } = data;
      const id = await createOrgModel(orgId, label, api, baseUrl, modelId, user.id, providerKeyId, {
        input,
        contextWindow,
        maxTokens,
        reasoning,
        cost,
      });
      return c.json({ id }, 201);
    } catch (err) {
      logger.error("Model create failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw internalError();
    }
  });

  // PUT /api/models/default — set the org default model
  // MUST be registered before PUT /:id
  router.put("/default", async (c) => {
    const orgId = c.get("orgId");
    const body = await c.req.json();
    const data = parseBody(setDefaultSchema, body);

    try {
      await setDefaultModel(orgId, data.modelId);
      return c.json({ success: true });
    } catch (err) {
      logger.error("Set default model failed", {
        error: err instanceof Error ? err.message : String(err),
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
        return c.json({ models: [] });
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

      return c.json({ models });
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
        error: err instanceof Error ? err.message : String(err),
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
        api: data.api,
        baseUrl: data.baseUrl,
        modelId: data.modelId,
        apiKey,
      });
      return c.json(result);
    } catch (err) {
      logger.error("Model inline test failed", {
        error: err instanceof Error ? err.message : String(err),
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
        error: err instanceof Error ? err.message : String(err),
      });
      throw internalError();
    }
  });

  // PUT /api/models/:id — update a custom model
  router.put("/:id", async (c) => {
    const orgId = c.get("orgId");
    const modelId = c.req.param("id");
    const body = await c.req.json();
    const data = parseBody(updateModelSchema, body);

    if (isSystemModel(modelId)) {
      throw systemEntityForbidden("model", modelId);
    }

    try {
      await updateOrgModel(orgId, modelId, data);
      return c.json({ id: modelId });
    } catch (err) {
      logger.error("Model update failed", {
        modelId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw internalError();
    }
  });

  // DELETE /api/models/:id — delete a custom model
  router.delete("/:id", async (c) => {
    const orgId = c.get("orgId");
    const modelId = c.req.param("id");

    if (isSystemModel(modelId)) {
      throw systemEntityForbidden("model", modelId, "delete");
    }

    try {
      await deleteOrgModel(orgId, modelId);
      return c.body(null, 204);
    } catch (err) {
      logger.error("Model delete failed", {
        modelId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw internalError();
    }
  });

  return router;
}
