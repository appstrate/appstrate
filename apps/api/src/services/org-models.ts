// SPDX-License-Identifier: Apache-2.0

import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { orgModels } from "@appstrate/db/schema";
import { getSystemModels, isSystemModel, type ModelDefinition } from "./model-registry.ts";
import type { ModelCost } from "@appstrate/shared-types";
import { logger } from "../lib/logger.ts";
import { isBlockedUrl } from "@appstrate/core/ssrf";
import type { OAuthWireFormat } from "@appstrate/core/sidecar-types";
import type { OrgModelInfo, TestResult } from "@appstrate/shared-types";
import { loadInferenceCredentials } from "./model-providers/credentials.ts";
import { toISORequired } from "../lib/date-helpers.ts";
import { mergeSystemAndDb, buildUpdateSet, scopedWhere } from "../lib/db-helpers.ts";
import { mapFetchErrorToTestResult } from "../lib/network-error.ts";
import { getModelProvider } from "./model-providers/registry.ts";
import type { InferenceProbeRequest } from "@appstrate/core/module";

// --- List (system + DB) ---

/**
 * Anthropic gates `sk-ant-oat-*` tokens to a specific identity shape at
 * the body level (system prompt + tool-name renaming) — pi-ai injects
 * that locally only when its prefix-based detection fires (see
 * `node_modules/@mariozechner/pi-ai/dist/providers/anthropic.js`). For
 * the LLM proxy path the upstream key never leaves the platform, so we
 * surface its kind to the CLI; the CLI then mirrors the prefix in the
 * placeholder it hands to pi-ai. Returns `null` for non-Anthropic
 * protocols and for Anthropic models whose creds are unavailable. OSS
 * ships no Anthropic OAuth provider; this stays as a contribution point
 * for external operator-installed modules.
 */
function detectKeyKind(apiShape: string, apiKey: string): "oauth" | "api-key" | null {
  if (apiShape !== "anthropic-messages") return null;
  return apiKey.includes("sk-ant-oat") ? "oauth" : "api-key";
}

export async function listOrgModels(orgId: string): Promise<OrgModelInfo[]> {
  const system = getSystemModels();
  const rows = await db.select().from(orgModels).where(scopedWhere(orgModels, { orgId }));
  const orgHasDefault = rows.some((r) => r.isDefault);
  const now = toISORequired(new Date());

  // Resolve keyKind for Anthropic DB models — needs a credentials lookup
  // per distinct credentialId. System models carry `apiKey` inline, so
  // detection there is free. Other protocols don't expose keyKind at all.
  const anthropicProviderKeyIds = new Set(
    rows.filter((r) => r.apiShape === "anthropic-messages").map((r) => r.credentialId),
  );
  const dbKeyKinds = new Map<string, "oauth" | "api-key" | null>();
  await Promise.all(
    Array.from(anthropicProviderKeyIds).map(async (id) => {
      const creds = await loadInferenceCredentials(orgId, id);
      dbKeyKinds.set(id, creds ? detectKeyKind("anthropic-messages", creds.apiKey) : null);
    }),
  );

  return mergeSystemAndDb({
    system,
    rows,
    mapSystem: (id, def) => ({
      id,
      label: def.label,
      apiShape: def.apiShape,
      baseUrl: def.baseUrl,
      modelId: def.modelId,
      input: def.input ?? null,
      contextWindow: def.contextWindow ?? null,
      maxTokens: def.maxTokens ?? null,
      reasoning: def.reasoning ?? null,
      cost: def.cost ?? null,
      enabled: def.enabled !== false,
      isDefault: !orgHasDefault && def.isDefault === true,
      source: "built-in" as const,
      credentialId: def.credentialId,
      keyKind: detectKeyKind(def.apiShape, def.apiKey),
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    }),
    mapRow: (row) => ({
      id: row.id,
      label: row.label,
      apiShape: row.apiShape,
      baseUrl: row.baseUrl,
      modelId: row.modelId,
      input: row.input as string[] | null,
      contextWindow: row.contextWindow,
      maxTokens: row.maxTokens,
      reasoning: row.reasoning,
      cost: row.cost as ModelCost | null,
      enabled: row.enabled,
      isDefault: row.isDefault,
      source: row.source as "custom" | "built-in",
      credentialId: row.credentialId,
      keyKind:
        row.apiShape === "anthropic-messages" ? (dbKeyKinds.get(row.credentialId) ?? null) : null,
      createdBy: row.createdBy,
      createdAt: toISORequired(row.createdAt),
      updatedAt: toISORequired(row.updatedAt),
    }),
  }).sort((a, b) => a.label.localeCompare(b.label));
}

// --- CRUD (DB models only) ---

export async function createOrgModel(
  orgId: string,
  label: string,
  apiShape: string,
  baseUrl: string,
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
      apiShape,
      baseUrl,
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
    apiShape?: string;
    baseUrl?: string;
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
 * {@link loadModel}, consumed by the env-builder (which strips the
 * display-only fields into the `LlmConfig` slot of `AppstrateRunPlan`).
 * `accountId` is set for OAuth credentials whose provider hook surfaced
 * an identity claim; the env-builder doesn't propagate it (the sidecar
 * re-reads it from the credential row on each request).
 */
export interface ResolvedModel {
  apiShape: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
  label: string;
  input?: string[] | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
  reasoning?: boolean | null;
  cost?: ModelCost | null;
  /** Whether the model comes from SYSTEM_PROVIDER_KEYS (platform-provided). */
  isSystemModel: boolean;
  /** Set for OAuth-backed model provider keys; gates provider-specific request shape. */
  providerId?: string;
  /**
   * Abstract account/tenant identifier surfaced by the credential's
   * `extractTokenIdentity` hook — passed to the provider's
   * `buildInferenceProbe` hook so it can be echoed as a routing header.
   */
  accountId?: string;
  /** `model_provider_credentials` row id — passed to the sidecar so it can pull fresh OAuth tokens at request time. Unset for system (env-driven) keys. */
  credentialId?: string;
  /** OAuth registry overlay — passed through so the sidecar config can be built without a second `getModelProviderConfig` lookup downstream. */
  rewriteUrlPath?: { from: string; to: string };
  forceStream?: boolean;
  forceStore?: false;
  /** OAuth registry overlay — declarative wire-format quirks forwarded to the sidecar. */
  wireFormat?: OAuthWireFormat;
}

function systemDefToResolved(def: ModelDefinition): ResolvedModel {
  return {
    apiShape: def.apiShape,
    baseUrl: def.baseUrl,
    modelId: def.modelId,
    apiKey: def.apiKey,
    label: def.label,
    input: def.input ?? null,
    contextWindow: def.contextWindow ?? null,
    maxTokens: def.maxTokens ?? null,
    reasoning: def.reasoning ?? null,
    cost: def.cost ?? null,
    isSystemModel: true,
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
    if (creds) {
      return {
        apiShape: dbDefault.apiShape,
        baseUrl: dbDefault.baseUrl,
        modelId: dbDefault.modelId,
        apiKey: creds.apiKey,
        label: dbDefault.label,
        input: dbDefault.input as string[] | null,
        contextWindow: dbDefault.contextWindow,
        maxTokens: dbDefault.maxTokens,
        reasoning: dbDefault.reasoning,
        cost: dbDefault.cost as ModelCost | null,
        isSystemModel: false,
        providerId: creds.providerId,
        accountId: creds.accountId,
        credentialId: dbDefault.credentialId,
        rewriteUrlPath: creds.rewriteUrlPath,
        forceStream: creds.forceStream,
        forceStore: creds.forceStore,
        wireFormat: creds.wireFormat,
      };
    }
  }

  // 3. System default
  const system = getSystemModels();
  for (const [, def] of system) {
    if (def.isDefault && def.enabled !== false) {
      return systemDefToResolved(def);
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
    return systemDefToResolved(systemDef);
  }

  // Check DB
  const [row] = await db
    .select({
      apiShape: orgModels.apiShape,
      baseUrl: orgModels.baseUrl,
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

  return {
    apiShape: row.apiShape,
    baseUrl: row.baseUrl,
    modelId: row.modelId,
    apiKey: creds.apiKey,
    label: row.label,
    input: row.input as string[] | null,
    contextWindow: row.contextWindow,
    maxTokens: row.maxTokens,
    reasoning: row.reasoning,
    cost: row.cost as ModelCost | null,
    isSystemModel: false,
    providerId: creds.providerId,
    accountId: creds.accountId,
    credentialId: row.credentialId,
    rewriteUrlPath: creds.rewriteUrlPath,
    forceStream: creds.forceStream,
    forceStore: creds.forceStore,
    wireFormat: creds.wireFormat,
  };
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
  // doesn't accept the generic `/models` discovery probe (e.g. Codex's
  // chatgpt.com backend has no `/models` endpoint) implement
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
