// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { listResponse } from "../lib/list-response.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { requireAnyPermission, requirePermission } from "../middleware/require-permission.ts";
import { isSystemModel, getSystemModelProviderCredentials } from "../services/model-registry.ts";
import { modelCostSchema, modelInputModalitySchema } from "@appstrate/core/module";
import {
  listOrgModels,
  getOrgModel,
  getOrgModelRow,
  createOrgModel,
  updateOrgModel,
  deleteOrgModel,
  setDefaultModel,
  writeDefaultModel,
  seedOrgModelsForCredential,
  testModelConnection,
  testModelConfig,
  deriveModelLabel,
  projectAliasedModel,
  resolveCatalogDefaults,
} from "../services/org-models.ts";
import { getModelProvider, isOAuthModelProvider } from "../services/model-providers/registry.ts";
import { requestPayerUserId } from "../services/model-providers/credential-chain.ts";
import { checkAliasInvariants, type AliasInvariantViolation } from "@appstrate/core/model-swap";
import {
  listCatalogModels,
  lookupCatalogModel,
  restrictsToOffer,
} from "../services/model-catalog.ts";
import type { CatalogModelEntry } from "@appstrate/shared-types";
import {
  createApiKeyCredential,
  dedupeCredentialLabel,
  deriveCredentialLabel,
  loadCredentialBinding,
  loadInferenceCredentials,
  MANAGE_CREDENTIALS,
} from "../services/model-providers/credentials.ts";
import { createSchema as createCredentialSchema } from "./model-provider-credentials.ts";
import { db } from "@appstrate/db/client";
import { orgModels } from "@appstrate/db/schema";
import { and, eq } from "drizzle-orm";
import { getErrorMessage } from "@appstrate/core/errors";
import { logger } from "../lib/logger.ts";
import {
  ApiError,
  invalidRequest,
  notFound,
  internalError,
  systemEntityForbidden,
  validationFailed,
  type ValidationFieldError,
} from "../lib/errors.ts";
import { readJsonBody } from "@appstrate/core/request-body";
import { recordAuditFromContext } from "../services/audit.ts";
import { searchOpenRouterModels } from "../services/model-search.ts";

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
    // slugs (e.g. "anthropic"). Validating as UUID here turns a
    // 500 ("invalid input syntax for type uuid") into a clean 400
    // and lets the route handler emit a hint that points operators at the
    // right knob (either update SYSTEM_PROVIDER_KEYS or create a custom
    // credential). `null`: each member serves the model with their own
    // credential for `providerId`.
    credentialId: z.uuid({ message: "credentialId must be a valid UUID" }).nullable(),
    /** The provider of a model without a credential. A bound model takes its credential's. */
    providerId: z.string().min(1).optional(),
    /**
     * Catalog-derivable overrides. Omit (or send null on update) to let the
     * read path fall back to the catalog — keeps existing rows in sync with
     * a Pi registry bump.
     */
    input: z.array(modelInputModalitySchema).optional(),
    contextWindow: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    reasoning: z.boolean().optional(),
    // Closed HERE, not in `modelCostSchema` itself: that schema doubles as the
    // reader of STORED rows (`appstrate-event-sink.ts`, `model-registry.ts`),
    // where a row carrying a future key must keep parsing or its tokens bill at
    // zero. At the REQUEST site the opposite is true — an open object strips a
    // misspelt `cache_read`/`cache_write` and returns 201 on a row that then
    // bills cache tokens at an absent rate, while the same typo one level up
    // (`costs`) is a 400.
    cost: modelCostSchema.strict().optional(),
    /**
     * Model-alias flag (LLM-gateway alias pattern). When true, this model's
     * `id` becomes a public alias and its real binding (modelId, provider,
     * baseUrl, capabilities/cost) is stripped from user-facing surfaces; the
     * sidecar rewrites the `model` field on every inference call.
     */
    aliased: z.boolean().optional(),
  })
  .strict()
  .refine(
    // Canonical model invariant: `input + output <= context`, so a response
    // cap can never reach the full window. Reject impossible overrides at the
    // edge so the runtime never derives a reserve that swallows the window.
    (d) => d.maxTokens == null || d.contextWindow == null || d.maxTokens < d.contextWindow,
    { message: "maxTokens must be strictly less than contextWindow", path: ["maxTokens"] },
  )
  .refine((d) => d.credentialId !== null || d.providerId !== undefined, {
    message: "providerId is required when credentialId is null",
    path: ["providerId"],
  });

/** One model of a choice to create: what `POST /api/models` takes, minus the shared binding. */
const choiceModelSchema = z
  .object({
    label: z.string().min(1).optional(),
    modelId: z.string().min(1, "modelId is required"),
    input: z.array(modelInputModalitySchema).optional(),
    contextWindow: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    reasoning: z.boolean().optional(),
    cost: modelCostSchema.strict().optional(),
  })
  .strict()
  .refine((d) => d.maxTokens == null || d.contextWindow == null || d.maxTokens < d.contextWindow, {
    message: "maxTokens must be strictly less than contextWindow",
    path: ["maxTokens"],
  });

/**
 * A model-provider choice, applied as one write: the credential its models run on (an existing
 * one, a new organization API key, or none — each member's own), the models to create, the ones
 * to switch on and off, and the default.
 */
export const applyModelChoiceSchema = z
  .object({
    credential: z
      .union([
        z.object({ id: z.uuid({ message: "credential.id must be a valid UUID" }) }).strict(),
        createCredentialSchema.omit({ owner_type: true }),
      ])
      .nullable(),
    /** The service of a choice without a credential; a credential names its own. */
    providerId: z.string().min(1).optional(),
    add: z.array(choiceModelSchema).max(100).default([]),
    enable: z.array(z.uuid()).max(200).default([]),
    disable: z.array(z.uuid()).max(200).default([]),
    /** The `modelId` (upstream id) of a model of this choice to make the organization's default. */
    default_model_id: z.string().min(1).optional(),
  })
  .strict()
  .refine((d) => d.credential !== null || d.providerId !== undefined, {
    message: "providerId is required when credential is null",
    path: ["providerId"],
  });

export const updateModelSchema = z
  .object({
    label: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    credentialId: z.uuid({ message: "credentialId must be a valid UUID" }).nullable().optional(),
    providerId: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    input: z.array(modelInputModalitySchema).nullable().optional(),
    contextWindow: z.number().int().positive().nullable().optional(),
    maxTokens: z.number().int().positive().nullable().optional(),
    reasoning: z.boolean().nullable().optional(),
    // `.strict()` for the same reason as on create — see the note there.
    cost: modelCostSchema.strict().nullable().optional(),
    aliased: z.boolean().optional(),
  })
  .strict()
  .refine(
    // See createModelSchema: `max_output_tokens < context_window` always holds.
    (d) => d.maxTokens == null || d.contextWindow == null || d.maxTokens < d.contextWindow,
    { message: "maxTokens must be strictly less than contextWindow", path: ["maxTokens"] },
  );

export const setDefaultSchema = z
  .object({
    modelId: z.string().nullable(),
  })
  .strict();

export const seedModelsSchema = z
  .object({
    credentialId: z.uuid({ message: "credentialId must be a valid UUID" }),
    model_ids: z
      .array(z.string().min(1))
      .min(1, "at least one model id is required")
      .max(50)
      // The same id twice is one binding asked for twice, and
      // `uq_org_models_unaliased_binding` refuses it. The seed insert is a
      // single atomic statement, so a self-duplicating body would fail the
      // whole batch on a constraint the caller cannot see — name it here.
      .refine((ids) => new Set(ids).size === ids.length, "model_ids must be unique"),
  })
  .strict();

// The inline test endpoint validates a model config before the user saves it.
// Callers identify the provider via `credentialId` — the registry resolves
// `apiShape` and `baseUrl` server-side, so the wire payload doesn't carry them.
export const testInlineSchema = z
  .object({
    credentialId: z.string().min(1, "credentialId is required"),
    modelId: z.string().min(1),
    api_key: z.string().optional(),
  })
  .strict();

/**
 * Map an alias-invariant violation to its 400 — shared by the create and
 * update handlers so PATCH cannot accept a state POST rejects.
 */
function throwOnAliasViolation(violation: AliasInvariantViolation | null): void {
  // 1. Require an explicit label. The derive-from-catalog fallback (POST) —
  //    or a label derived at creation time and kept on update — would name
  //    the alias after its REAL backing ("DeepSeek Chat"), and `label`
  //    survives the projection, leaking the backing on /api/models and
  //    run.model_label.
  if (violation === "missing_label") {
    throw invalidRequest(
      "An aliased model requires an explicit label — the derived label would name the backing model.",
      "label",
    );
  }
  // 2. The oauth-subscription run path is a pure sidecar bearer-swap —
  //    it never rewrites the body, so an alias there could not be
  //    swapped (nor masked). Reject up front.
  if (violation === "oauth_provider") {
    throw invalidRequest(
      "Model aliases are not supported for oauth-subscription providers — the subscription run path never rewrites the request body. Bind the alias to an API-key credential instead.",
      "aliased",
    );
  }
}

/**
 * Canonical model invariant (`input + output <= context`) enforced on the
 * EFFECTIVE state. The Zod refines above only fire when both fields ride in
 * the same payload — a lone `maxTokens` override must be checked against the
 * value it will actually be paired with at read/run time (the stored override
 * or the live catalog), and vice versa. `null`/absent on either side (model
 * unknown to the catalog) means there is nothing to compare against — allow.
 */
function throwOnTokenBudgetViolation(
  maxTokens: number | null | undefined,
  contextWindow: number | null | undefined,
): void {
  if (maxTokens != null && contextWindow != null && maxTokens >= contextWindow) {
    throw invalidRequest(
      `maxTokens (${maxTokens}) must be strictly less than the effective contextWindow (${contextWindow})`,
      "maxTokens",
    );
  }
}

function modelNotOffered(providerId: string, modelId: string, param?: string): ApiError {
  return new ApiError({
    status: 400,
    code: "model_not_offered",
    title: "Invalid Request",
    detail: `Model ${modelId} is not offered by provider ${providerId}`,
    param,
  });
}

/** A named provider binds only the ids of its offer — see `restrictsToOffer`. */
function throwOnModelOutsideOffer(providerId: string, modelId: string): void {
  const def = getModelProvider(providerId);
  if (def && restrictsToOffer(def) && !lookupCatalogModel(def, modelId)) {
    throw modelNotOffered(providerId, modelId, "modelId");
  }
}

/** The fields of a model to create that a binding does not decide. */
type ModelCreateFields = Omit<z.infer<typeof createModelSchema>, "credentialId" | "providerId">;

/**
 * The checks a model to create passes and the label it is written with — shared by
 * `POST /api/models` and `POST /api/models/apply`, once each has settled the binding
 * (`providerId` is the binding's provider). Reads only, so it runs before any write.
 */
async function prepareModelCreate(
  orgId: string,
  providerId: string,
  data: ModelCreateFields,
  pendingLabels: readonly string[] = [],
): Promise<{ label: string; capabilities: Parameters<typeof createOrgModel>[5] }> {
  const { modelId, input, contextWindow, maxTokens, reasoning, cost, aliased } = data;
  throwOnModelOutsideOffer(providerId, modelId);
  // Model-alias guards — shared invariant rule:
  if (aliased) {
    throwOnAliasViolation(
      checkAliasInvariants({
        label: data.label,
        authMode: isOAuthModelProvider(providerId) ? "oauth2" : "api_key",
      }),
    );
  }
  // Token-budget invariant on the EFFECTIVE state: an override omitted
  // from the payload falls back to the live catalog at read/run time, so
  // a lone `maxTokens` (or a lone `contextWindow`) must be checked
  // against the catalog value it will be paired with.
  const catalogDefaults = resolveCatalogDefaults(providerId, modelId);
  throwOnTokenBudgetViolation(
    maxTokens ?? catalogDefaults.maxTokens,
    contextWindow ?? catalogDefaults.contextWindow,
  );
  // Label is optional on the wire — derive from the catalog when the
  // caller omits it. Needs the provider to pick the right catalog
  // (handles `catalogProviderId` for OAuth wrappers).
  const label = data.label ?? (await deriveModelLabel(orgId, providerId, modelId, pendingLabels));
  return { label, capabilities: { input, contextWindow, maxTokens, reasoning, cost, aliased } };
}

export function createModelsRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/models — list all models (system + DB)
  router.get("/", requirePermission("models", "read"), async (c) => {
    const orgId = c.get("orgId");
    const models = await listOrgModels(orgId, requestPayerUserId(c));
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
      const { modelId, credentialId } = data;
      // Block built-in (env-driven) credentials at the route boundary.
      // `org_models.credential_id` is a UUID FK to `model_provider_credentials.id`;
      // system keys live in `SYSTEM_PROVIDER_KEYS` env and are never present in
      // that table. Without this check the insert succeeds Zod validation
      // (the operator can declare a UUID in env if they want), then fails at
      // the Postgres FK with a 500 the caller can't act on. Pointing them at
      // the env var instead is the actionable fix.
      if (credentialId !== null && getSystemModelProviderCredentials().has(credentialId)) {
        throw invalidRequest(
          "Cannot add custom models against a built-in credential — declare the model in the " +
            "SYSTEM_PROVIDER_KEYS env var (models[] field), or create a custom credential via " +
            "POST /api/model-provider-credentials and bind the model to that.",
          "credentialId",
        );
      }
      // Reachability gate — MUST run on both the explicit-label and the
      // derive-label paths, before the insert. `loadInferenceCredentials`
      // returns null for a dead credential (OAuth in needs_reconnection, a
      // blob that no longer decrypts, missing row, unresolvable baseUrl).
      // Two things depend on it: everything below reads `creds` (alias
      // invariants, the catalog defaults the token-budget check is measured
      // against) and cannot be established without it; and `needs_reconnection`
      // exists to explain a model that WENT dead, not to license minting one
      // dead on arrival — such a row could never run, and could not even
      // become the org default.
      const creds =
        credentialId === null ? null : await loadInferenceCredentials(orgId, credentialId);
      if (credentialId !== null && !creds) {
        throw invalidRequest(
          "credentialId is unreachable — the credential needs reconnection or no longer exists",
          "credentialId",
        );
      }
      // A bound model takes its credential's provider; an unbound one names it.
      const providerId = creds ? creds.providerId : data.providerId;
      if (!providerId || !getModelProvider(providerId)) {
        throw invalidRequest("providerId must name a registered provider", "providerId");
      }
      const { label, capabilities } = await prepareModelCreate(orgId, providerId, data);
      const id = await createOrgModel(
        orgId,
        label,
        modelId,
        user.id,
        { credentialId, providerId: data.providerId },
        capabilities,
      );
      await recordAuditFromContext(c, {
        action: "model.created",
        resourceType: "model",
        resourceId: id,
        after: { label, modelId, credentialId },
      });
      // Return the bare created resource (same shape as GET/list) so callers
      // see the resolved state without a follow-up fetch. The row was
      // just inserted — failing to re-project it (e.g. credential became
      // unreachable mid-request) is a server-side inconsistency.
      const model = await getOrgModel(orgId, id, requestPayerUserId(c));
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
  // The credential's providerId pins the registry entry; model_ids are validated
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

    // Only ids of the provider's catalog offer are seedable — for a
    // static-discovery provider that is exactly the credential's served set.
    const catalogById = new Map(listCatalogModels(registry).map((m) => [m.id, m]));
    const models: Array<CatalogModelEntry & { id: string }> = [];
    for (const modelId of data.model_ids) {
      const cat = catalogById.get(modelId);
      if (!cat) {
        throw modelNotOffered(creds.providerId, modelId);
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
      return c.json(
        { created: result.created, ids: result.ids, promoted_default: result.promotedDefault },
        201,
      );
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
      // without a follow-up GET. When no default remains in effect
      // (cleared with no system fallback) there is no resource: 204.
      const all = await listOrgModels(orgId, requestPayerUserId(c));
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

  // POST /api/models/apply — a model-provider choice in one transaction
  router.post("/apply", requirePermission("models", "write"), async (c) => {
    const orgId = c.get("orgId");
    const user = c.get("user");
    const data = await readJsonBody(c, applyModelChoiceSchema);
    const minting = data.credential !== null && !("id" in data.credential);
    if (minting) {
      await requireAnyPermission(MANAGE_CREDENTIALS)(c, async () => {});
    }

    // 1. The binding, settled before any write: reads only.
    let credentialId: string | null = null;
    let providerId: string;
    let newCredential: {
      label: string;
      providerId: string;
      apiKey: string;
      baseUrlOverride: string | null;
    } | null = null;
    if (data.credential === null) {
      providerId = data.providerId!;
      if (!getModelProvider(providerId)) {
        throw invalidRequest("providerId must name a registered provider", "providerId");
      }
    } else if ("id" in data.credential) {
      credentialId = data.credential.id;
      if (getSystemModelProviderCredentials().has(credentialId)) {
        throw invalidRequest("A built-in credential takes no custom models", "credential.id");
      }
      const creds = await loadInferenceCredentials(orgId, credentialId);
      if (!creds) {
        throw invalidRequest(
          "credential.id is unreachable — the credential needs reconnection or no longer exists",
          "credential.id",
        );
      }
      providerId = creds.providerId;
    } else {
      const cfg = getModelProvider(data.credential.providerId);
      if (!cfg) {
        throw invalidRequest(
          `Unknown providerId: ${data.credential.providerId}`,
          "credential.providerId",
        );
      }
      if (cfg.authMode !== "api_key") {
        throw invalidRequest(
          `Provider ${cfg.providerId} requires OAuth; use the OAuth pairing flow instead`,
          "credential.providerId",
        );
      }
      providerId = cfg.providerId;
      const baseUrlOverride = data.credential.base_url_override ?? null;
      newCredential = {
        label: await dedupeCredentialLabel(
          orgId,
          data.credential.label?.trim() || deriveCredentialLabel(cfg, baseUrlOverride),
          null,
        ),
        providerId,
        apiKey: data.credential.api_key,
        baseUrlOverride,
      };
    }

    // 2. Every model judged before any write, each refusal kept against its entry.
    const refusals: ValidationFieldError[] = [];
    const refuse = (field: string, err: unknown) => {
      if (!(err instanceof ApiError)) throw err;
      refusals.push({ field, code: err.code, message: err.message });
    };
    const prepared: {
      modelId: string;
      label: string;
      capabilities: Parameters<typeof createOrgModel>[5];
    }[] = [];
    for (const [index, entry] of data.add.entries()) {
      try {
        const ready = await prepareModelCreate(
          orgId,
          providerId,
          entry,
          prepared.map((p) => p.label),
        );
        prepared.push({ modelId: entry.modelId, ...ready });
      } catch (err) {
        refuse(`add.${index}`, err);
      }
    }
    if (refusals.length > 0) throw validationFailed(refusals);

    // 3. One transaction: the key, the models, the switches, the default — all or nothing.
    const sameBinding = (row: { credentialId: string | null; providerId: string }) =>
      credentialId === null && !minting
        ? row.credentialId === null && row.providerId === providerId
        : row.credentialId === credentialId;
    const outcome = await db.transaction(async (tx) => {
      const boundTo = newCredential
        ? await createApiKeyCredential(
            {
              orgId,
              userId: user.id,
              ownerUserId: null,
              label: newCredential.label,
              providerId: newCredential.providerId,
              apiKey: newCredential.apiKey,
              baseUrlOverride: newCredential.baseUrlOverride,
            },
            tx,
          )
        : credentialId;
      credentialId = boundTo;
      const created = new Map<string, string>();
      for (const [index, model] of prepared.entries()) {
        try {
          const id = await createOrgModel(
            orgId,
            model.label,
            model.modelId,
            user.id,
            { credentialId: boundTo, ...(boundTo === null ? { providerId } : {}) },
            model.capabilities,
            tx,
          );
          created.set(model.modelId, id);
        } catch (err) {
          refuse(`add.${index}`, err);
        }
      }
      // A switch only moves a model of this choice.
      const switchModel = async (field: string, id: string, enabled: boolean) => {
        const row = await getOrgModelRow(orgId, id, tx);
        if (!row || !sameBinding(row)) {
          refusals.push({
            field,
            code: "model_not_in_choice",
            message: "This model does not run on the choice's credential",
          });
          return;
        }
        try {
          await updateOrgModel(orgId, id, { enabled }, tx);
        } catch (err) {
          refuse(field, err);
        }
      };
      for (const [index, id] of data.enable.entries())
        await switchModel(`enable.${index}`, id, true);
      let defaultId: string | null = null;
      if (data.default_model_id !== undefined) {
        defaultId = created.get(data.default_model_id) ?? null;
        if (!defaultId) {
          const [existing] = await tx
            .select({
              id: orgModels.id,
              credentialId: orgModels.credentialId,
              providerId: orgModels.providerId,
            })
            .from(orgModels)
            .where(
              and(
                eq(orgModels.orgId, orgId),
                eq(orgModels.modelId, data.default_model_id),
                eq(orgModels.aliased, false),
              ),
            );
          defaultId = existing && sameBinding(existing) ? existing.id : null;
        }
        if (!defaultId) {
          refusals.push({
            field: "default_model_id",
            code: "model_not_in_choice",
            message: `No model '${data.default_model_id}' runs on the choice's credential`,
          });
        } else {
          try {
            await writeDefaultModel(tx, orgId, defaultId, true);
          } catch (err) {
            refuse("default_model_id", err);
          }
        }
      }
      for (const [index, id] of data.disable.entries()) {
        await switchModel(`disable.${index}`, id, false);
      }
      // Any refusal rolls the whole choice back: nothing is half-applied.
      if (refusals.length > 0) throw validationFailed(refusals);
      return { credentialId: boundTo, created, defaultId };
    });

    if (newCredential && outcome.credentialId) {
      await recordAuditFromContext(c, {
        action: "model_provider_credential.created",
        resourceType: "model_provider_credential",
        resourceId: outcome.credentialId,
        after: {
          label: newCredential.label,
          providerId: newCredential.providerId,
          baseUrlOverride: newCredential.baseUrlOverride,
          ownerType: "org",
        },
      });
    }
    for (const [modelId, id] of outcome.created) {
      await recordAuditFromContext(c, {
        action: "model.created",
        resourceType: "model",
        resourceId: id,
        after: { modelId, credentialId: outcome.credentialId },
      });
    }
    for (const [enabled, ids] of [
      [true, data.enable],
      [false, data.disable],
    ] as const) {
      for (const id of ids) {
        await recordAuditFromContext(c, {
          action: "model.updated",
          resourceType: "model",
          resourceId: id,
          after: { enabled },
        });
      }
    }
    if (outcome.defaultId) {
      await recordAuditFromContext(c, {
        action: "model.default_set",
        resourceType: "model",
        resourceId: outcome.defaultId,
      });
    }

    const payer = requestPayerUserId(c);
    const touched = [...outcome.created.values(), ...data.enable, ...data.disable];
    const models = (await Promise.all(touched.map((id) => getOrgModel(orgId, id, payer)))).flatMap(
      (model) => (model ? [projectAliasedModel(model)] : []),
    );
    return c.json({
      object: "model_choice" as const,
      credential_id: outcome.credentialId,
      models,
      default_model_id: outcome.defaultId,
    });
  });

  // GET /api/models/openrouter — search OpenRouter models (proxy)
  router.get("/openrouter", rateLimit(10), requirePermission("models", "read"), async (c) =>
    c.json(listResponse(await searchOpenRouterModels(c.req.query("q") || ""))),
  );

  // POST /api/models/test — test model config inline (before saving)
  // MUST be registered before /:id/test
  router.post("/test", rateLimit(5), requirePermission("models", "write"), async (c) => {
    const orgId = c.get("orgId");
    const data = await readJsonBody(c, testInlineSchema);

    // Resolve the provider via the credential's providerId — the registry
    // owns apiShape and the default baseUrl. The user-supplied `api_key` (if
    // any) overrides the stored key for "verify before save" flows. A built-in
    // credential is refused: its key never reaches a caller-chosen probe.
    if (getSystemModelProviderCredentials().has(data.credentialId)) {
      throw systemEntityForbidden("model provider credential", data.credentialId, "test");
    }
    // A model binds organization credentials only; a personal one is probed on its own route.
    const binding = await loadCredentialBinding(orgId, data.credentialId);
    const creds =
      binding?.ownerUserId === null
        ? await loadInferenceCredentials(orgId, data.credentialId)
        : null;
    if (!creds) {
      throw notFound("Credential not found");
    }
    const apiKey = data.api_key || creds.apiKey;
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

    // A model alias must not be probed through this route (Threat A). The test
    // issues a live `GET {realBaseUrl}/models` on the platform's own
    // credential and answers `{ ok, latency, status }` — which reports the
    // BACKING's round-trip time and its upstream HTTP status to a caller who is
    // never told which vendor that is. Two distinct leaks (a timing signal and
    // a status signal), plus an unmetered spend of a platform credential on a
    // request the caller has no stake in.
    //
    // Refused before `testModelConnection` so no fetch is issued at all — a
    // late refusal would still have spent the credential and still have taken
    // the backing's round-trip time to answer.
    //
    // `aliased` is already public on the projection, so a 400 here discloses
    // nothing new; the message names no binding detail. Non-aliased models are
    // untouched — their contract is reaching the provider, not hiding it.
    const existing = await getOrgModel(orgId, modelId, requestPayerUserId(c));
    if (existing?.aliased) {
      throw invalidRequest("Connection testing is not available for a managed model.");
    }

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

  // PATCH /api/models/:id — update a custom model
  router.patch("/:id", requirePermission("models", "write"), async (c) => {
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
    // Reachability gate (same as POST) — re-pointing a model AT a credential
    // that can no longer serve inference is a deliberate move into a broken
    // state: the row would come back flagged `needs_reconnection`, refuse to
    // become the org default, and fail every run. Reject before the write.
    // `newCreds` is what the offer and catalog checks below run against.
    let newCreds: Awaited<ReturnType<typeof loadInferenceCredentials>> = null;
    if (data.credentialId) {
      newCreds = await loadInferenceCredentials(orgId, data.credentialId);
      if (!newCreds) {
        throw invalidRequest(
          "credentialId is unreachable — the credential needs reconnection or no longer exists",
          "credentialId",
        );
      }
    }

    // Model-alias guards on the EFFECTIVE post-update state —
    // without this, PATCH is a bypass of every invariant POST enforces: flip
    // `aliased` on an oauth-subscription or non-backing row, or re-point an
    // aliased row to such a credential, and the row becomes a state creation
    // rejects (runs then fail-close late at launch; chat would diverge).
    const current = await getOrgModelRow(orgId, modelId);
    if (!current) {
      throw notFound("Model not found");
    }
    // The provider after this write: a new credential's, else the row's own
    // (kept when the binding is removed). Stored on the row, so it reads
    // without decrypting — a dead credential still names its provider.
    const providerId = newCreds?.providerId ?? data.providerId ?? current.providerId;
    if (data.aliased ?? current.aliased) {
      throwOnAliasViolation(
        checkAliasInvariants({
          // A false→true flip must carry a fresh explicit label: the row's
          // existing label may be catalog-derived and name the backing. An
          // already-aliased row's label is explicit by construction (POST
          // enforced it), so it stays valid when this PATCH omits `label`.
          label: data.label ?? (current.aliased ? current.label : undefined),
          authMode: isOAuthModelProvider(providerId) ? "oauth2" : "api_key",
        }),
      );
    }

    // The offer and token-budget checks run on the EFFECTIVE post-update
    // state, gated on the fields they read so a row that fails them can still
    // be disabled or relabelled. The Zod refine only sees the payload: a lone
    // `maxTokens` can exceed the stored (or catalog) contextWindow, and a
    // binding change swaps the catalog defaults under a kept override.
    const rebinds =
      data.modelId !== undefined ||
      data.credentialId !== undefined ||
      data.providerId !== undefined;
    if (rebinds || data.maxTokens !== undefined || data.contextWindow !== undefined) {
      const effectiveModelId = data.modelId ?? current.modelId;
      if (rebinds) throwOnModelOutsideOffer(providerId, effectiveModelId);
      const catalogDefaults = resolveCatalogDefaults(providerId, effectiveModelId);
      throwOnTokenBudgetViolation(
        (data.maxTokens === undefined ? current.maxTokens : data.maxTokens) ??
          catalogDefaults.maxTokens,
        (data.contextWindow === undefined ? current.contextWindow : data.contextWindow) ??
          catalogDefaults.contextWindow,
      );
    }

    try {
      await updateOrgModel(orgId, modelId, data);
      await recordAuditFromContext(c, {
        action: "model.updated",
        resourceType: "model",
        resourceId: modelId,
        after: data,
      });
      // Return the bare updated resource, projected for a model alias
      // (Threat A) — the same projection the list and effective-default paths
      // apply.
      //
      // The asymmetry with POST is deliberate, not an oversight. A create
      // response echoes a binding the operator just sent in the request body,
      // so it discloses nothing the caller did not already hold. An update
      // does not: `PATCH {"enabled":true}` names no binding field, yet the raw
      // row answers with `apiShape`, `providerId`, `baseUrl`, `modelId`,
      // `contextWindow` and `cost`. `isSystemModel` above does not cover this
      // — it rejects env-declared models, while an alias is an ordinary DB row
      // — so without this projection the update route is a read oracle for
      // every backing an org admin (or a `models:write` API key) can name.
      const model = await getOrgModel(orgId, modelId, requestPayerUserId(c));
      if (!model) throw notFound("Model not found");
      return c.json(projectAliasedModel(model));
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
