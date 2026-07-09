// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { listResponse } from "../lib/list-response.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { isSystemModel, getSystemModelProviderCredentials } from "../services/model-registry.ts";
import { modelCostSchema } from "@appstrate/core/module";
import {
  listOrgModels,
  getOrgModel,
  createOrgModel,
  updateOrgModel,
  deleteOrgModel,
  setDefaultModel,
  seedOrgModelsForCredential,
  testModelConnection,
  testModelConfig,
  loadModel,
  deriveModelLabel,
  projectAliasedModel,
} from "../services/org-models.ts";
import { getModelProvider, isOAuthModelProvider } from "../services/model-providers/registry.ts";
import { checkAliasInvariants } from "@appstrate/core/model-swap";
import { listCatalogModels } from "../services/pricing-catalog.ts";
import type { CatalogModelEntry } from "@appstrate/shared-types";
import {
  getOrgModelProviderCredential,
  loadInferenceCredentials,
} from "../services/model-providers/credentials.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { logger } from "../lib/logger.ts";
import {
  ApiError,
  invalidRequest,
  notFound,
  internalError,
  systemEntityForbidden,
} from "../lib/errors.ts";
import { readJsonBody } from "../lib/request-body.ts";
import { recordAuditFromContext } from "../services/audit.ts";

export const createModelSchema = z
  .object({
    /**
     * Optional. When omitted, the server derives the label from the catalog
     * (`<catalog>.label`) and dedupes against existing org rows. See
     * {@link deriveModelLabel}.
     */
    label: z.string().min(1).optional(),
    modelId: z.string().min(1, "modelId is required"),
    // `org_models.credential_id` is a strict UUID FK to
    // `model_provider_credentials.id` — built-in (system) credentials live
    // in `SYSTEM_PROVIDER_KEYS` env, NOT in that table, and identify as
    // slugs (e.g. "anthropic"). Validating as UUID here turns the
    // legacy 500 ("invalid input syntax for type uuid") into a clean 400
    // and lets the route handler emit a hint that points operators at the
    // right knob (either update SYSTEM_PROVIDER_KEYS or create a custom
    // credential).
    credentialId: z.uuid({ message: "credentialId must be a valid UUID" }),
    /**
     * Catalog-derivable overrides. Omit (or send null on update) to let the
     * read path fall back to the live catalog — keeps existing rows in sync
     * with the weekly `refresh-pricing-catalog.ts` bump.
     */
    input: z.array(z.string()).optional(),
    contextWindow: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    reasoning: z.boolean().optional(),
    cost: modelCostSchema.optional(),
    /**
     * Model-alias flag (LLM-gateway alias pattern). When true, this model's
     * `id` becomes a public alias and its real binding (modelId, provider,
     * baseUrl, capabilities/cost) is stripped from user-facing surfaces; the
     * sidecar rewrites the `model` field on every inference call.
     */
    aliased: z.boolean().optional(),
  })
  .refine(
    // Canonical model invariant: `input + output <= context`, so a response
    // cap can never reach the full window. Reject impossible overrides at the
    // edge so the runtime never derives a reserve that swallows the window.
    (d) => d.maxTokens == null || d.contextWindow == null || d.maxTokens < d.contextWindow,
    { message: "maxTokens must be strictly less than contextWindow", path: ["maxTokens"] },
  );

export const updateModelSchema = z
  .object({
    label: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    credentialId: z.uuid({ message: "credentialId must be a valid UUID" }).optional(),
    enabled: z.boolean().optional(),
    input: z.array(z.string()).nullable().optional(),
    contextWindow: z.number().int().positive().nullable().optional(),
    maxTokens: z.number().int().positive().nullable().optional(),
    reasoning: z.boolean().nullable().optional(),
    cost: modelCostSchema.nullable().optional(),
    aliased: z.boolean().optional(),
  })
  .refine(
    // See createModelSchema: `max_output_tokens < context_window` always holds.
    (d) => d.maxTokens == null || d.contextWindow == null || d.maxTokens < d.contextWindow,
    { message: "maxTokens must be strictly less than contextWindow", path: ["maxTokens"] },
  );

export const setDefaultSchema = z.object({
  modelId: z.string().nullable(),
});

export const seedModelsSchema = z.object({
  credentialId: z.uuid({ message: "credentialId must be a valid UUID" }),
  modelIds: z.array(z.string().min(1)).min(1, "at least one modelId is required").max(50),
});

// The inline test endpoint validates a model config before the user saves it.
// Callers identify the provider via `credentialId` — the registry resolves
// `apiShape` and `baseUrl` server-side, so the wire payload doesn't carry them.
export const testInlineSchema = z.object({
  credentialId: z.string().min(1, "credentialId is required"),
  modelId: z.string().min(1),
  apiKey: z.string().optional(),
  existingModelId: z.string().optional(),
});

export function createModelsRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/models — list all models (system + DB)
  router.get("/", requirePermission("models", "read"), async (c) => {
    const orgId = c.get("orgId");
    // `metadata_only`: resolve protocol family/baseUrl from the registry without
    // decrypting each model's credential. For callers that only need to pick a
    // model row (e.g. the chat picker), not to call inference. Rows with a gone
    // credential/provider are still dropped, but a model whose secret is unusable
    // (dead OAuth) is NOT filtered here — it surfaces and errors at inference.
    const metadataOnly = c.req.query("metadata_only") === "true";
    const models = await listOrgModels(orgId, { metadataOnly });
    // Strip the backing of any model alias before it reaches the dashboard user
    // (Threat A) — see projectAliasedModel. Non-aliased models pass through.
    //
    // EXCEPTION: a first-party loopback caller (server-minted, process-local —
    // the chat inference path today) needs the real `apiShape`/`providerId` to
    // route an aliased model to the right engine/proxy — otherwise aliases are
    // unusable in chat. We gate on the declared `firstPartyLoopback` capability,
    // NOT on a specific module's auth-method id. Trusted server code (same trust
    // boundary as `loadModel`); the backing it reads never reaches the browser
    // (chat streams AI output, not the model list). The dashboard's own picker
    // calls this with a cookie and still gets the stripped view.
    const firstPartyLoopback = c.get("firstPartyLoopback") === true;
    return c.json(listResponse(firstPartyLoopback ? models : models.map(projectAliasedModel)));
  });

  // POST /api/models — create a custom model
  router.post("/", requirePermission("models", "write"), async (c) => {
    const orgId = c.get("orgId");
    const user = c.get("user");
    const data = await readJsonBody(c, createModelSchema);

    try {
      const { modelId, credentialId, input, contextWindow, maxTokens, reasoning, cost, aliased } =
        data;
      // Block built-in (env-driven) credentials at the route boundary.
      // `org_models.credential_id` is a UUID FK to `model_provider_credentials.id`;
      // system keys live in `SYSTEM_PROVIDER_KEYS` env and are never present in
      // that table. Without this check the insert succeeds Zod validation
      // (the operator can declare a UUID in env if they want), then fails at
      // the Postgres FK with a 500 the caller can't act on. Pointing them at
      // the env var instead is the actionable fix.
      if (getSystemModelProviderCredentials().has(credentialId)) {
        throw invalidRequest(
          "Cannot add custom models against a built-in credential — declare the model in the " +
            "SYSTEM_PROVIDER_KEYS env var (models[] field), or create a custom credential via " +
            "POST /api/model-provider-credentials and bind the model to that.",
          "credentialId",
        );
      }
      // Reachability gate — MUST run on both the explicit-label and the
      // derive-label paths, before the insert. `loadInferenceCredentials`
      // returns null for a dead credential (OAuth in needs_reconnection,
      // missing row, unresolvable baseUrl); the list serializer filters
      // models bound to such credentials, so inserting first would 500 on
      // the bare-resource re-projection below and leave a phantom row the
      // caller can't see.
      const creds = await loadInferenceCredentials(orgId, credentialId);
      if (!creds) {
        throw invalidRequest(
          "credentialId is unreachable — the credential needs reconnection or no longer exists",
          "credentialId",
        );
      }
      // Model-alias guards (issue #727, Threat A) — shared invariant rule:
      if (aliased) {
        const violation = checkAliasInvariants({
          label: data.label,
          apiShape: creds.apiShape,
          authMode: isOAuthModelProvider(creds.providerId) ? "oauth2" : "api_key",
        });
        // 1. Require an explicit label. The derive-from-catalog fallback below
        //    would name the alias after its REAL backing ("DeepSeek Chat"),
        //    and `label` survives the projection — leaking the backing on
        //    /api/models and run.model_label.
        if (violation === "missing_label") {
          throw invalidRequest(
            "An aliased model requires an explicit label — the derived label would name the backing model.",
            "label",
          );
        }
        // 2. The swap only rewrites the body `model` field, which exists for
        //    openai/anthropic/mistral shapes; google/azure/bedrock carry the
        //    model id in the URL path, so an alias there forwards verbatim and
        //    404s upstream (and never gets swapped). Reject up front.
        if (violation === "non_aliasable_shape") {
          throw invalidRequest(
            `Model aliases are not supported for the "${creds.apiShape}" protocol (the model id is carried in the URL, not the request body).`,
            "aliased",
          );
        }
        // 3. The oauth-subscription run path is a pure sidecar bearer-swap —
        //    it never rewrites the body, so an alias there could not be
        //    swapped (nor masked). Reject up front.
        if (violation === "oauth_provider") {
          throw invalidRequest(
            "Model aliases are not supported for oauth-subscription providers — the subscription run path never rewrites the request body. Bind the alias to an API-key credential instead.",
            "aliased",
          );
        }
      }
      // Label is optional on the wire — derive from the catalog when the
      // caller omits it. Needs the credential's providerId to pick the
      // right catalog (handles `catalogProviderId` for OAuth wrappers).
      let label = data.label;
      if (!label) {
        label = await deriveModelLabel(orgId, creds.providerId, modelId);
      }
      const id = await createOrgModel(orgId, label, modelId, user.id, credentialId, {
        input,
        contextWindow,
        maxTokens,
        reasoning,
        cost,
        aliased,
      });
      await recordAuditFromContext(c, {
        action: "model.created",
        resourceType: "model",
        resourceId: id,
        after: { label, modelId, credentialId },
      });
      // Return the bare created resource (same shape as GET/list) so callers
      // see the resolved state without a follow-up fetch (#657). The row was
      // just inserted — failing to re-project it (e.g. credential became
      // unreachable mid-request) is a server-side inconsistency.
      const model = await getOrgModel(orgId, id);
      if (!model) throw internalError();
      return c.json(model, 201);
    } catch (err) {
      if (err instanceof ApiError) throw err;
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
    const data = await readJsonBody(c, seedModelsSchema);

    // Same constraint as POST /api/models — seeding a built-in credential
    // would FK-fail the org_models insert. Block early with an actionable
    // hint instead of cascading to a 500.
    if (getSystemModelProviderCredentials().has(data.credentialId)) {
      throw invalidRequest(
        "Cannot seed models against a built-in credential — declare them in the " +
          "SYSTEM_PROVIDER_KEYS env var (models[] field), or create a custom credential.",
        "credentialId",
      );
    }
    const creds = await loadInferenceCredentials(orgId, data.credentialId);
    if (!creds || !creds.providerId) {
      throw notFound("Credential not found or not registry-bound");
    }
    const registry = getModelProvider(creds.providerId);
    if (!registry) {
      throw notFound(`Provider ${creds.providerId} not registered`);
    }

    // The vendored pricing catalog is the single source of truth for
    // per-model metadata. The picker surfaces ids from this catalog
    // (filtered by `featuredModels` when `catalogProviderId` is set), so
    // we accept any id that lives in the resolved catalog.
    const catalogKey = registry.catalogProviderId ?? creds.providerId;
    const catalogById = new Map(listCatalogModels(catalogKey).map((m) => [m.id, m]));
    // Foreign-catalog (subscription OAuth) gate: a model is seedable when
    // it's in the static featured list OR empirically verified against
    // this credential by the discovery probe (`available_model_ids`) —
    // the probe knows the account's plan, the static list doesn't.
    const credentialInfo = registry.catalogProviderId
      ? await getOrgModelProviderCredential(orgId, data.credentialId)
      : undefined;
    const allowedSet = new Set([
      ...registry.featuredModels,
      ...(credentialInfo?.available_model_ids ?? []),
    ]);
    const models: Array<CatalogModelEntry & { id: string }> = [];
    for (const modelId of data.modelIds) {
      const cat = catalogById.get(modelId);
      if (!cat) {
        throw invalidRequest(`Model ${modelId} is not in the ${catalogKey} catalog`);
      }
      if (registry.catalogProviderId && !allowedSet.has(modelId)) {
        throw invalidRequest(
          `Model ${modelId} is not featured or verified for provider ${creds.providerId}`,
        );
      }
      models.push(cat);
    }

    try {
      const result = await seedOrgModelsForCredential(orgId, user.id, data.credentialId, {
        models,
      });
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
    const data = await readJsonBody(c, setDefaultSchema);

    try {
      await setDefaultModel(orgId, data.modelId);
      await recordAuditFromContext(c, {
        action: "model.default_set",
        resourceType: "model",
        resourceId: data.modelId,
      });
      // Return the bare *effective* default model resource — `is_default` is
      // recomputed by listOrgModels (DB flag, or the system-default fallback
      // when no DB row is flagged) — so callers see the resulting state
      // without a follow-up GET (#657). When no default remains in effect
      // (cleared with no system fallback) there is no resource: 204.
      const all = await listOrgModels(orgId);
      const def = all.find((m) => m.is_default);
      // Project in case the effective default is a model alias (Threat A).
      return def ? c.json(projectAliasedModel(def)) : c.body(null, 204);
    } catch (err) {
      // A deliberate client error (e.g. unknown model ref → 404) must surface as
      // itself, not be masked as a 500 by the catch-all.
      if (err instanceof ApiError) throw err;
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
  router.post("/test", rateLimit(5), requirePermission("models", "write"), async (c) => {
    const orgId = c.get("orgId");
    const data = await readJsonBody(c, testInlineSchema);

    // Resolve the provider via the credential's providerId — the registry
    // owns apiShape and the default baseUrl. The user-supplied apiKey (if
    // any) overrides the stored credential for "verify before save" flows.
    const creds = await loadInferenceCredentials(orgId, data.credentialId);
    if (!creds) {
      throw notFound("Credential not found");
    }

    let apiKey = data.apiKey;
    if (!apiKey && data.existingModelId) {
      const existing = await loadModel(orgId, data.existingModelId);
      if (existing) apiKey = existing.apiKey;
    }
    if (!apiKey) {
      apiKey = creds.apiKey;
    }
    if (!apiKey) {
      throw invalidRequest("API key is required");
    }

    try {
      const result = await testModelConfig({
        apiShape: creds.apiShape,
        baseUrl: creds.baseUrl,
        modelId: data.modelId,
        apiKey,
        providerId: creds.providerId,
        accountId: creds.accountId,
        expiresAt: creds.expiresAt,
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
  router.post("/:id/test", rateLimit(5), requirePermission("models", "write"), async (c) => {
    const orgId = c.get("orgId");
    const modelId = c.req.param("id")!;
    try {
      const result = await testModelConnection(orgId, modelId);
      if (result.error === "MODEL_NOT_FOUND") {
        throw notFound("Model not found");
      }
      return c.json(result);
    } catch (err) {
      // A deliberate client error (e.g. notFound above) must surface as itself,
      // not be masked as a 500 by the catch-all.
      if (err instanceof ApiError) throw err;
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
    const data = await readJsonBody(c, updateModelSchema);

    if (isSystemModel(modelId)) {
      throw systemEntityForbidden("model", modelId);
    }
    // Same FK constraint applies to updates that re-point a model to a
    // different credential. Catch the same case here.
    if (data.credentialId && getSystemModelProviderCredentials().has(data.credentialId)) {
      throw invalidRequest(
        "Cannot bind a custom model to a built-in credential — declare it in the " +
          "SYSTEM_PROVIDER_KEYS env var instead.",
        "credentialId",
      );
    }
    // Reachability gate (same as POST) — re-pointing a model to a dead
    // credential (needs_reconnection OAuth) would let the UPDATE succeed,
    // then the bare-resource re-projection below 404s because the list
    // serializer filters models bound to unreachable credentials — a
    // misleading "Model not found" after a write that DID land. Reject
    // before the write instead.
    if (data.credentialId) {
      const creds = await loadInferenceCredentials(orgId, data.credentialId);
      if (!creds) {
        throw invalidRequest(
          "credentialId is unreachable — the credential needs reconnection or no longer exists",
          "credentialId",
        );
      }
    }

    try {
      await updateOrgModel(orgId, modelId, data);
      await recordAuditFromContext(c, {
        action: "model.updated",
        resourceType: "model",
        resourceId: modelId,
        after: data as unknown as Record<string, unknown>,
      });
      // Return the bare updated resource (#657).
      const model = await getOrgModel(orgId, modelId);
      if (!model) throw notFound("Model not found");
      return c.json(model);
    } catch (err) {
      if (err instanceof ApiError) throw err;
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
