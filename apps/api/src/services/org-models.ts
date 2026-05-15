// SPDX-License-Identifier: Apache-2.0

import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { orgModels } from "@appstrate/db/schema";
import { getSystemModels, isSystemModel, type ModelDefinition } from "./model-registry.ts";
import { lookupCatalogModel } from "./pricing-catalog.ts";
import type { CatalogModelEntry } from "@appstrate/shared-types";
import type { ModelCost } from "@appstrate/core/module";
import { logger } from "../lib/logger.ts";
import { isBlockedUrl } from "@appstrate/core/ssrf";
import type { ModelMetadata, OrgModelInfo, TestResult } from "@appstrate/shared-types";
import {
  loadInferenceCredentials,
  type DecryptedModelProviderCredentials,
} from "./model-providers/credentials.ts";
import { toISORequired } from "../lib/date-helpers.ts";
import { mergeSystemAndDb, buildUpdateSet, scopedWhere } from "../lib/db-helpers.ts";
import { mapFetchErrorToTestResult } from "../lib/network-error.ts";
import { getModelProvider } from "./model-providers/registry.ts";
import type { InferenceProbeRequest } from "@appstrate/core/module";

// --- Metadata projection ---

/**
 * Project the 6 metadata fields (label + 5 capability/cost fields) by
 * cascading source → catalog defaults → final fallback. This is the single
 * authoritative place where overrides beat the vendored catalog — cost-shape
 * changes touch exactly one function.
 *
 * Used by every site that reads {@link ModelMetadata}: the wire-shape
 * projection (`listOrgModels` for both system and DB rows), and the resolved-
 * model builders for the run executor (`buildSystemResolvedModel`,
 * `buildDbResolvedModel`).
 */
export function resolveModelMetadata(
  src: ModelMetadata,
  modelId: string,
  defaults: CatalogDefaults,
): Required<Omit<ModelMetadata, "label">> & { label: string } {
  return {
    label: src.label ?? defaults.label ?? modelId,
    input: src.input ?? defaults.input ?? null,
    contextWindow: src.contextWindow ?? defaults.contextWindow ?? null,
    maxTokens: src.maxTokens ?? defaults.maxTokens ?? null,
    reasoning: src.reasoning ?? defaults.reasoning ?? null,
    cost: src.cost ?? defaults.cost ?? null,
  };
}

// --- List (system + DB) ---

export async function listOrgModels(orgId: string): Promise<OrgModelInfo[]> {
  const system = getSystemModels();
  const rows = await db.select().from(orgModels).where(scopedWhere(orgModels, { orgId }));
  const orgHasDefault = rows.some((r) => r.isDefault);
  const now = toISORequired(new Date());

  // Resolve apiShape/baseUrl from the registry via the credential's providerId.
  // The DB row no longer stores these — they're derivatives of `providerId`.
  // Rows whose credential is unreachable (deleted upstream, decryption failed,
  // dead OAuth) are skipped silently — they can't be loaded for inference
  // anyway, so surfacing them in the list would only confuse the UI.
  const credByRow = new Map<string, DecryptedModelProviderCredentials>();
  await Promise.all(
    rows.map(async (r) => {
      const creds = await loadInferenceCredentials(orgId, r.credentialId);
      if (creds) credByRow.set(r.id, creds);
    }),
  );
  const reachableRows = rows.filter((r) => credByRow.has(r.id));

  return mergeSystemAndDb<ModelDefinition, (typeof reachableRows)[number], OrgModelInfo>({
    system,
    rows: reachableRows,
    mapSystem: (id, def): OrgModelInfo => ({
      id,
      ...resolveModelMetadata(
        def,
        def.modelId,
        resolveCatalogDefaults(def.providerId, def.modelId),
      ),
      apiShape: def.apiShape,
      baseUrl: def.baseUrl,
      modelId: def.modelId,
      enabled: def.enabled !== false,
      isDefault: !orgHasDefault && def.isDefault === true,
      source: "built-in",
      credentialId: def.credentialId,
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    }),
    mapRow: (row): OrgModelInfo => {
      const creds = credByRow.get(row.id)!;
      return {
        id: row.id,
        ...resolveModelMetadata(
          { ...row, input: row.input as string[] | null, cost: row.cost as ModelCost | null },
          row.modelId,
          resolveCatalogDefaults(creds.providerId, row.modelId),
        ),
        apiShape: creds.apiShape,
        baseUrl: creds.baseUrl,
        modelId: row.modelId,
        enabled: row.enabled,
        isDefault: row.isDefault,
        source: row.source as "custom" | "built-in",
        credentialId: row.credentialId,
        createdBy: row.createdBy,
        createdAt: toISORequired(row.createdAt),
        updatedAt: toISORequired(row.updatedAt),
      };
    },
  }).sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Derive a model label when the caller doesn't supply one. Picks the catalog
 * label (`(catalogProviderId ?? providerId, modelId)`) and dedupes against
 * existing org rows by appending ` (2)`, ` (3)`, …  Unknown models fall back
 * to `modelId` so the column (`NOT NULL`) always gets a value.
 */
export async function deriveModelLabel(
  orgId: string,
  providerId: string,
  modelId: string,
): Promise<string> {
  const defaults = resolveCatalogDefaults(providerId, modelId);
  const base = defaults.label ?? modelId;
  const rows = await db
    .select({ label: orgModels.label })
    .from(orgModels)
    .where(scopedWhere(orgModels, { orgId }));
  const existing = new Set(rows.map((r) => r.label));
  if (!existing.has(base)) return base;
  let counter = 2;
  while (existing.has(`${base} (${counter})`)) counter++;
  return `${base} (${counter})`;
}

// --- CRUD (DB models only) ---

export async function createOrgModel(
  orgId: string,
  label: string,
  modelId: string,
  userId: string,
  credentialId: string,
  capabilities?: {
    input?: string[];
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
    cost?: ModelCost;
  },
): Promise<string> {
  // If this is the first model for the org, set it as default
  const existing = await db
    .select({ id: orgModels.id })
    .from(orgModels)
    .where(scopedWhere(orgModels, { orgId }))
    .limit(1);
  const isFirst = existing.length === 0;

  const [row] = await db
    .insert(orgModels)
    .values({
      orgId,
      label,
      modelId,
      credentialId,
      input: capabilities?.input ?? null,
      contextWindow: capabilities?.contextWindow ?? null,
      maxTokens: capabilities?.maxTokens ?? null,
      reasoning: capabilities?.reasoning ?? null,
      cost: capabilities?.cost ?? null,
      isDefault: isFirst,
      source: "custom",
      createdBy: userId,
    })
    .returning({ id: orgModels.id });
  return row!.id;
}

export async function updateOrgModel(
  orgId: string,
  modelDbId: string,
  data: {
    label?: string;
    modelId?: string;
    enabled?: boolean;
    input?: string[] | null;
    contextWindow?: number | null;
    maxTokens?: number | null;
    reasoning?: boolean | null;
    cost?: ModelCost | null;
    credentialId?: string;
  },
): Promise<void> {
  if (isSystemModel(modelDbId)) {
    throw new Error("Cannot modify built-in model");
  }

  const updates = buildUpdateSet(data);

  await db
    .update(orgModels)
    .set(updates)
    .where(scopedWhere(orgModels, { orgId, extra: [eq(orgModels.id, modelDbId)] }));
}

export async function deleteOrgModel(orgId: string, modelDbId: string): Promise<void> {
  if (isSystemModel(modelDbId)) {
    throw new Error("Cannot delete built-in model");
  }
  await db
    .delete(orgModels)
    .where(scopedWhere(orgModels, { orgId, extra: [eq(orgModels.id, modelDbId)] }));
}

/**
 * Atomically seed multiple catalog models for a single credential. Called by
 * the onboarding quick-connect flow right after a pairing succeeds — replaces
 * N client-side POST /models calls.
 *
 * Skips entirely if the org already has any model bound to the credential
 * (idempotent for re-connect flows). Promotes the first newly-created row to
 * default when the org has no default yet.
 *
 * Models are taken verbatim from {@link CatalogModelEntry}. The provider's
 * `apiShape` and `baseUrl` are resolved from the registry by the credential's
 * `providerId` at read time — no need to pass them through here.
 */
export interface SeedModelsResult {
  created: number;
  ids: string[];
  promotedDefault: boolean;
}

export interface SeedModelsInput {
  models: ReadonlyArray<CatalogModelEntry & { id: string }>;
}

export async function seedOrgModelsForCredential(
  orgId: string,
  userId: string,
  credentialId: string,
  input: SeedModelsInput,
): Promise<SeedModelsResult> {
  if (input.models.length === 0) return { created: 0, ids: [], promotedDefault: false };

  return db.transaction(async (tx) => {
    // Dedup: skip if any model already references this credential.
    const existingForCred = await tx
      .select({ id: orgModels.id })
      .from(orgModels)
      .where(scopedWhere(orgModels, { orgId, extra: [eq(orgModels.credentialId, credentialId)] }))
      .limit(1);
    if (existingForCred.length > 0) {
      return { created: 0, ids: [], promotedDefault: false };
    }

    const orgHasDefault = await tx
      .select({ id: orgModels.id })
      .from(orgModels)
      .where(scopedWhere(orgModels, { orgId, extra: [eq(orgModels.isDefault, true)] }))
      .limit(1);
    const needsDefault = orgHasDefault.length === 0;

    // Store catalog-derivable columns as null — read path falls back to
    // the live catalog via `resolveCatalogDefaults`, so a weekly catalog
    // refresh propagates to these rows without a backfill migration.
    // Only `label` is materialised (DB column is NOT NULL); explicit
    // user-side renames remain stable across catalog bumps.
    const inserted = await tx
      .insert(orgModels)
      .values(
        input.models.map((m, idx) => ({
          orgId,
          label: m.label,
          modelId: m.id,
          credentialId,
          input: null,
          contextWindow: null,
          maxTokens: null,
          reasoning: null,
          cost: null,
          isDefault: needsDefault && idx === 0,
          source: "custom",
          createdBy: userId,
        })),
      )
      .returning({ id: orgModels.id });

    return {
      created: inserted.length,
      ids: inserted.map((r) => r.id),
      promotedDefault: needsDefault && inserted.length > 0,
    };
  });
}

export async function setDefaultModel(orgId: string, modelDbId: string | null): Promise<void> {
  // Reset all defaults for this org
  await db
    .update(orgModels)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(scopedWhere(orgModels, { orgId }));

  if (modelDbId === null) return;

  // Only DB models can be flagged — system defaults are handled by the resolution cascade
  if (!isSystemModel(modelDbId)) {
    await db
      .update(orgModels)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(scopedWhere(orgModels, { orgId, extra: [eq(orgModels.id, modelDbId)] }));
  }
}

// --- Resolution ---

/**
 * Canonical resolved-model shape — produced by {@link resolveModel} /
 * {@link loadModel}, consumed by the env-builder. Passed through to the
 * run executor verbatim as `AppstrateRunPlan.llmConfig`; the executor
 * only reads inference fields. `accountId` is set for OAuth credentials
 * whose provider hook surfaced an identity claim — the sidecar re-reads
 * it from the credential row on each request, so the executor ignores it.
 *
 * Inference fields (providerId, apiShape, …, cost) mirror
 * {@link ModelDefinition} so the env-driven and DB-driven paths feed the
 * run executor the same shape.
 */
export interface ResolvedModel extends Pick<
  ModelDefinition,
  | "providerId"
  | "apiShape"
  | "baseUrl"
  | "modelId"
  | "apiKey"
  | "input"
  | "contextWindow"
  | "maxTokens"
  | "reasoning"
  | "cost"
> {
  /**
   * Always set — the builders fall back to the catalog and finally `modelId`
   * so callers can read it as a plain string even when the env entry or DB
   * row omitted it. `ModelDefinition.label` stays optional on purpose
   * (storage-side) — `ResolvedModel.label` is its post-resolution view.
   */
  label: string;
  /** Whether the model comes from SYSTEM_PROVIDER_KEYS (platform-provided). */
  isSystemModel: boolean;
  /**
   * Abstract account/tenant identifier surfaced by the credential's
   * `extractTokenIdentity` hook — passed to the provider's
   * `buildInferenceProbe` hook so it can be echoed as a routing header.
   */
  accountId?: string;
  /** `model_provider_credentials` row id — passed to the sidecar so it can pull fresh OAuth tokens at request time. Unset for system (env-driven) keys. */
  credentialId?: string;
}

interface DbOrgModelRow {
  modelId: string;
  credentialId: string;
  label: string;
  input: unknown;
  contextWindow: number | null;
  maxTokens: number | null;
  reasoning: boolean | null;
  cost: unknown;
}

interface DbModelCredentials {
  apiKey: string;
  providerId: string;
  apiShape: string;
  baseUrl: string;
  accountId?: string;
}

/**
 * Catalog-derived defaults for `(providerId, modelId)`. Each `org_models`
 * column is an *optional override* — when the row stores null, the catalog
 * value flows through here. Storing nulls instead of frozen catalog values
 * lets the weekly `refresh-pricing-catalog.ts` bump propagate to existing
 * rows. Honors `catalogProviderId` so OAuth wrappers (codex → openai,
 * claude-code → anthropic) hit the right catalog file.
 *
 * Returns `{}` on any miss (unmapped provider, unknown model id, dropped
 * entry). Callers fall through to row values or final defaults.
 */
export interface CatalogDefaults {
  label?: string;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number | null;
  reasoning?: boolean;
  cost?: ModelCost;
}

export function resolveCatalogDefaults(providerId: string, modelId: string): CatalogDefaults {
  const provider = getModelProvider(providerId);
  const catalogKey = provider?.catalogProviderId ?? providerId;
  const entry = lookupCatalogModel(catalogKey, modelId);
  if (!entry) return {};
  return {
    label: entry.label,
    input: entry.capabilities.filter((c): c is "text" | "image" => c === "text" || c === "image"),
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    reasoning: entry.capabilities.includes("reasoning"),
    cost: entry.cost,
  };
}

/** Build a `ResolvedModel` from a system `ModelDefinition` (env-driven). */
function buildSystemResolvedModel(def: ModelDefinition): ResolvedModel {
  return {
    providerId: def.providerId,
    apiShape: def.apiShape,
    baseUrl: def.baseUrl,
    modelId: def.modelId,
    apiKey: def.apiKey,
    ...resolveModelMetadata(def, def.modelId, resolveCatalogDefaults(def.providerId, def.modelId)),
    isSystemModel: true,
  };
}

/** Build a `ResolvedModel` from a DB `org_models` row + its credentials.
 *
 * `apiShape` and `baseUrl` come straight from the credential — the credential
 * service resolves them from the registry by `providerId` (with the per-row
 * `baseUrlOverride` honored when `baseUrlOverridable: true`). Every catalog-
 * derivable column on `org_models` is an optional override that defers to
 * the catalog on null — so a weekly catalog refresh propagates to existing
 * rows.
 */
function buildDbResolvedModel(row: DbOrgModelRow, creds: DbModelCredentials): ResolvedModel {
  return {
    providerId: creds.providerId,
    apiShape: creds.apiShape,
    baseUrl: creds.baseUrl,
    modelId: row.modelId,
    apiKey: creds.apiKey,
    ...resolveModelMetadata(
      { ...row, input: row.input as string[] | null, cost: row.cost as ModelCost | null },
      row.modelId,
      resolveCatalogDefaults(creds.providerId, row.modelId),
    ),
    isSystemModel: false,
    accountId: creds.accountId,
    credentialId: row.credentialId,
  };
}

export async function resolveModel(
  orgId: string,
  packageId: string,
  modelId: string | null,
): Promise<ResolvedModel | null> {
  // 1. Explicit override (agent column or per-run)
  if (modelId) {
    const result = await loadModel(orgId, modelId);
    if (result) return result;
    logger.warn("Agent model override not found, falling through to org default", {
      packageId,
      modelId,
    });
  }

  // 2. Org default
  const [dbDefault] = await db
    .select()
    .from(orgModels)
    .where(
      scopedWhere(orgModels, {
        orgId,
        extra: [eq(orgModels.isDefault, true), eq(orgModels.enabled, true)],
      }),
    )
    .limit(1);

  if (dbDefault) {
    const creds = await loadInferenceCredentials(orgId, dbDefault.credentialId);
    if (creds) return buildDbResolvedModel(dbDefault, creds);
  }

  // 3. System default
  const system = getSystemModels();
  for (const [, def] of system) {
    if (def.isDefault && def.enabled !== false) {
      return buildSystemResolvedModel(def);
    }
  }

  // 4. No model configured
  return null;
}

export async function loadModel(orgId: string, modelDbId: string): Promise<ResolvedModel | null> {
  // Check system models first
  const system = getSystemModels();
  const systemDef = system.get(modelDbId);
  if (systemDef) {
    return buildSystemResolvedModel(systemDef);
  }

  // Check DB
  const [row] = await db
    .select({
      modelId: orgModels.modelId,
      credentialId: orgModels.credentialId,
      enabled: orgModels.enabled,
      label: orgModels.label,
      input: orgModels.input,
      contextWindow: orgModels.contextWindow,
      maxTokens: orgModels.maxTokens,
      reasoning: orgModels.reasoning,
      cost: orgModels.cost,
    })
    .from(orgModels)
    .where(scopedWhere(orgModels, { orgId, extra: [eq(orgModels.id, modelDbId)] }))
    .limit(1);

  if (!row || !row.enabled) return null;

  const creds = await loadInferenceCredentials(orgId, row.credentialId);
  if (!creds) return null;

  return buildDbResolvedModel(row, creds);
}

// --- Connection test ---

/** Build the discovery URL + headers used to probe a model provider. Pure for unit testing. */
export function buildModelTestRequest(config: {
  apiShape: string;
  baseUrl: string;
  apiKey: string;
  providerId?: string;
}): {
  url: string;
  headers: Record<string, string>;
} {
  const base = config.baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {};
  let url: string;

  switch (config.apiShape) {
    case "anthropic-messages":
      // API-key only — OAuth subscription tokens (`sk-ant-oat-*`) are
      // not used by any provider Appstrate ships out of the box.
      url = `${base}/v1/models`;
      headers["x-api-key"] = config.apiKey;
      headers["anthropic-version"] = "2023-06-01";
      break;
    case "mistral-conversations":
      url = `${base}/v1/models`;
      headers["Authorization"] = `Bearer ${config.apiKey}`;
      break;
    case "google-generative-ai":
      url = `${base}/models?key=${encodeURIComponent(config.apiKey)}`;
      break;
    case "google-vertex":
      url = `${base}/models`;
      headers["Authorization"] = `Bearer ${config.apiKey}`;
      break;
    case "azure-openai-responses":
      url = `${base}/models`;
      headers["api-key"] = config.apiKey;
      break;
    case "openai-completions":
    case "openai-responses":
    case "bedrock-converse-stream":
    default:
      url = `${base}/models`;
      headers["Authorization"] = `Bearer ${config.apiKey}`;
      break;
  }

  return { url, headers };
}

/** Test a model config directly (no DB lookup). */
export async function testModelConfig(config: {
  apiShape: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
  providerId?: string;
  accountId?: string;
}): Promise<TestResult> {
  if (isBlockedUrl(config.baseUrl)) {
    return {
      ok: false,
      latency: 0,
      error: "BLOCKED_URL",
      message: "URL targets a blocked network",
    };
  }

  // Provider-agnostic inference-probe override — modules whose backend
  // doesn't accept the generic `/models` discovery probe implement
  // `buildInferenceProbe` to provide the real wire format. The platform
  // sends whatever the module builds without inspecting the contents.
  const provider = config.providerId ? getModelProvider(config.providerId) : null;
  const probe = provider?.hooks?.buildInferenceProbe?.({
    baseUrl: config.baseUrl,
    modelId: config.modelId,
    apiKey: config.apiKey,
    accountId: config.accountId,
  });
  if (probe) {
    if ("error" in probe) {
      return { ok: false, latency: 0, error: probe.error, message: probe.message };
    }
    return runInferenceProbe(probe);
  }

  const { url, headers } = buildModelTestRequest(config);

  const start = performance.now();
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    const latency = Math.round(performance.now() - start);

    if (res.ok) return { ok: true, latency };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, latency, error: "AUTH_FAILED", message: "Authentication failed" };
    }
    return {
      ok: false,
      latency,
      error: "PROVIDER_ERROR",
      message: `Provider returned ${res.status}`,
    };
  } catch (err) {
    return mapFetchErrorToTestResult(err, Math.round(performance.now() - start));
  }
}

/** Test a saved model by ID (loads from DB/system registry then delegates to testModelConfig). */
export async function testModelConnection(orgId: string, modelDbId: string): Promise<TestResult> {
  const model = await loadModel(orgId, modelDbId);
  if (!model)
    return { ok: false, latency: 0, error: "MODEL_NOT_FOUND", message: "Model not found" };

  return testModelConfig(model);
}

// --- OAuth inference probes ---

const PROBE_TIMEOUT_MS = 15_000;

/**
 * Send a module-supplied {@link InferenceProbeRequest} and map the response
 * to a {@link TestResult}. The platform is provider-agnostic here — the
 * module's `buildInferenceProbe` hook owns the wire format; this helper
 * only knows how to send it and classify the outcome.
 *
 * Streaming bodies are aborted immediately — we only care about the
 * response status.
 */
async function runInferenceProbe(req: InferenceProbeRequest): Promise<TestResult> {
  const start = performance.now();
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const latency = Math.round(performance.now() - start);
    void res.body?.cancel().catch(() => {});
    if (res.ok) return { ok: true, latency };
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        latency,
        error: "AUTH_FAILED",
        message: "Provider rejected the token (auth failed or subscription inactive)",
      };
    }
    return {
      ok: false,
      latency,
      error: "PROVIDER_ERROR",
      message: `Provider returned ${res.status}`,
    };
  } catch (err) {
    return mapFetchErrorToTestResult(err, Math.round(performance.now() - start));
  }
}

// OSS supports only the API-key flow for Anthropic, via the `anthropic`
// provider in the `core-providers` module. Anthropic Consumer ToS forbids
// using OAuth subscription tokens in any third-party product, so OSS
// ships no Anthropic OAuth provider.
