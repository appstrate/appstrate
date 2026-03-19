import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { requireAdmin } from "../middleware/guards.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { isSystemModel } from "../services/model-registry.ts";
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

const createModelSchema = z.object({
  label: z.string().min(1, "label is required"),
  api: z.string().min(1, "api is required"),
  baseUrl: z.url({ error: "baseUrl must be a valid URL" }),
  modelId: z.string().min(1, "modelId is required"),
  apiKey: z.string().min(1, "apiKey is required"),
  input: z.array(z.string()).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  reasoning: z.boolean().optional(),
});

const updateModelSchema = z.object({
  label: z.string().min(1).optional(),
  api: z.string().min(1).optional(),
  baseUrl: z.url().optional(),
  modelId: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  input: z.array(z.string()).nullable().optional(),
  contextWindow: z.number().int().positive().nullable().optional(),
  maxTokens: z.number().int().positive().nullable().optional(),
  reasoning: z.boolean().nullable().optional(),
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

  // All endpoints are admin-only
  router.use("*", requireAdmin());

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
    const parsed = createModelSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", message: parsed.error.issues[0]!.message }, 400);
    }

    try {
      const { label, api, baseUrl, modelId, apiKey, input, contextWindow, maxTokens, reasoning } =
        parsed.data;
      const id = await createOrgModel(orgId, label, api, baseUrl, modelId, apiKey, user.id, {
        input,
        contextWindow,
        maxTokens,
        reasoning,
      });
      return c.json({ id }, 201);
    } catch (err) {
      logger.error("Model create failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "INTERNAL_ERROR", message: "Failed to create model" }, 500);
    }
  });

  // PUT /api/models/default — set the org default model
  // MUST be registered before PUT /:id
  router.put("/default", async (c) => {
    const orgId = c.get("orgId");
    const body = await c.req.json();
    const parsed = setDefaultSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", message: parsed.error.issues[0]!.message }, 400);
    }

    try {
      await setDefaultModel(orgId, parsed.data.modelId);
      return c.json({ success: true });
    } catch (err) {
      logger.error("Set default model failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "INTERNAL_ERROR", message: "Failed to set default model" }, 500);
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
        return c.json(
          { error: "PROVIDER_ERROR", message: `OpenRouter returned ${res.status}` },
          502,
        );
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json: any = await res.json();
      const rawModels = json?.data;

      if (!Array.isArray(rawModels)) {
        return c.json({ models: [] });
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let models = rawModels.map((m: any) => ({
        id: String(m.id ?? ""),
        name: String(m.name || m.id || ""),
        contextWindow: typeof m.context_length === "number" ? m.context_length : null,
        maxTokens:
          typeof m.top_provider?.max_completion_tokens === "number"
            ? m.top_provider.max_completion_tokens
            : null,
        input: m.architecture?.input_modalities?.includes?.("image") ? ["text", "image"] : ["text"],
        reasoning: false,
      }));

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
      if (err instanceof DOMException && err.name === "TimeoutError") {
        return c.json({ error: "TIMEOUT", message: "OpenRouter request timed out" }, 504);
      }
      logger.error("OpenRouter model search failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "NETWORK_ERROR", message: "Failed to fetch OpenRouter models" }, 502);
    }
  });

  // POST /api/models/test — test model config inline (before saving)
  // MUST be registered before /:id/test
  router.post("/test", rateLimit(5), async (c) => {
    const orgId = c.get("orgId");
    const body = await c.req.json();
    const parsed = testInlineSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", message: parsed.error.issues[0]!.message }, 400);
    }

    let { apiKey } = parsed.data;

    // In edit mode, if no apiKey provided, fall back to the stored key
    if (!apiKey && parsed.data.existingModelId) {
      const existing = await loadModel(orgId, parsed.data.existingModelId);
      if (existing) apiKey = existing.apiKey;
    }

    if (!apiKey) {
      return c.json(
        { ok: false, latency: 0, error: "VALIDATION_ERROR", message: "API key is required" },
        400,
      );
    }

    try {
      const result = await testModelConfig({
        api: parsed.data.api,
        baseUrl: parsed.data.baseUrl,
        modelId: parsed.data.modelId,
        apiKey,
      });
      return c.json(result);
    } catch (err) {
      logger.error("Model inline test failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json(
        { ok: false, latency: 0, error: "INTERNAL_ERROR", message: "Test failed" },
        500,
      );
    }
  });

  // POST /api/models/:id/test — test model connection
  router.post("/:id/test", rateLimit(5), async (c) => {
    const orgId = c.get("orgId");
    const modelId = c.req.param("id")!;
    try {
      const result = await testModelConnection(orgId, modelId);
      return c.json(result, result.error === "MODEL_NOT_FOUND" ? 404 : 200);
    } catch (err) {
      logger.error("Model test failed", {
        modelId,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json(
        { ok: false, latency: 0, error: "INTERNAL_ERROR", message: "Test failed" },
        500,
      );
    }
  });

  // PUT /api/models/:id — update a custom model
  router.put("/:id", async (c) => {
    const orgId = c.get("orgId");
    const modelId = c.req.param("id");
    const body = await c.req.json();
    const parsed = updateModelSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", message: parsed.error.issues[0]!.message }, 400);
    }

    if (isSystemModel(modelId)) {
      return c.json(
        { error: "OPERATION_NOT_ALLOWED", message: `Cannot modify built-in model '${modelId}'` },
        403,
      );
    }

    try {
      await updateOrgModel(orgId, modelId, parsed.data);
      return c.json({ id: modelId });
    } catch (err) {
      logger.error("Model update failed", {
        modelId,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "INTERNAL_ERROR", message: "Failed to update model" }, 500);
    }
  });

  // DELETE /api/models/:id — delete a custom model
  router.delete("/:id", async (c) => {
    const orgId = c.get("orgId");
    const modelId = c.req.param("id");

    if (isSystemModel(modelId)) {
      return c.json(
        { error: "OPERATION_NOT_ALLOWED", message: `Cannot delete built-in model '${modelId}'` },
        403,
      );
    }

    try {
      await deleteOrgModel(orgId, modelId);
      return c.body(null, 204);
    } catch (err) {
      logger.error("Model delete failed", {
        modelId,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "INTERNAL_ERROR", message: "Failed to delete model" }, 500);
    }
  });

  return router;
}
