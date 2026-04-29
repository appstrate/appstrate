// SPDX-License-Identifier: Apache-2.0

import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { orgModels } from "@appstrate/db/schema";
import { getSystemModels, isSystemModel, type ModelDefinition } from "./model-registry.ts";
import type { ModelCost } from "./adapters/types.ts";
import { logger } from "../lib/logger.ts";
import { isBlockedUrl } from "@appstrate/core/ssrf";
import type { OrgModelInfo, TestResult } from "@appstrate/shared-types";
import { loadProviderKeyCredentials } from "./org-provider-keys.ts";
import { toISORequired } from "../lib/date-helpers.ts";
import { mergeSystemAndDb, buildUpdateSet, scopedWhere } from "../lib/db-helpers.ts";
import { mapFetchErrorToTestResult } from "../lib/network-error.ts";

// --- List (system + DB) ---

/**
 * Anthropic gates `sk-ant-oat-*` tokens to Claude-Code identity at the
 * body level (system prompt + tool-name renaming) — pi-ai injects that
 * locally only when its prefix-based detection fires (see
 * `node_modules/@mariozechner/pi-ai/dist/providers/anthropic.js`). For
 * the LLM proxy path the upstream key never leaves the platform, so we
 * surface its kind to the CLI; the CLI then mirrors the prefix in the
 * placeholder it hands to pi-ai. Returns `null` for non-Anthropic
 * protocols and for Anthropic models whose creds are unavailable.
 */
function detectKeyKind(api: string, apiKey: string): "oauth" | "api-key" | null {
  if (api !== "anthropic-messages") return null;
  return apiKey.includes("sk-ant-oat") ? "oauth" : "api-key";
}

export async function listOrgModels(orgId: string): Promise<OrgModelInfo[]> {
  const system = getSystemModels();
  const rows = await db.select().from(orgModels).where(scopedWhere(orgModels, { orgId }));
  const orgHasDefault = rows.some((r) => r.isDefault);
  const now = toISORequired(new Date());

  // Resolve keyKind for Anthropic DB models — needs a credentials lookup
  // per distinct providerKeyId. System models carry `apiKey` inline, so
  // detection there is free. Other protocols don't expose keyKind at all.
  const anthropicProviderKeyIds = new Set(
    rows.filter((r) => r.api === "anthropic-messages").map((r) => r.providerKeyId),
  );
  const dbKeyKinds = new Map<string, "oauth" | "api-key" | null>();
  await Promise.all(
    Array.from(anthropicProviderKeyIds).map(async (id) => {
      const creds = await loadProviderKeyCredentials(orgId, id);
      dbKeyKinds.set(id, creds ? detectKeyKind("anthropic-messages", creds.apiKey) : null);
    }),
  );

  return mergeSystemAndDb({
    system,
    rows,
    mapSystem: (id, def) => ({
      id,
      label: def.label,
      api: def.api,
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
      providerKeyId: def.providerKeyId,
      providerKeyLabel: null,
      keyKind: detectKeyKind(def.api, def.apiKey),
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    }),
    mapRow: (row) => ({
      id: row.id,
      label: row.label,
      api: row.api,
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
      providerKeyId: row.providerKeyId,
      providerKeyLabel: null,
      keyKind:
        row.api === "anthropic-messages" ? (dbKeyKinds.get(row.providerKeyId) ?? null) : null,
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
  api: string,
  baseUrl: string,
  modelId: string,
  userId: string,
  providerKeyId: string,
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
      api,
      baseUrl,
      modelId,
      providerKeyId,
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
    api?: string;
    baseUrl?: string;
    modelId?: string;
    enabled?: boolean;
    input?: string[] | null;
    contextWindow?: number | null;
    maxTokens?: number | null;
    reasoning?: boolean | null;
    cost?: ModelCost | null;
    providerKeyId?: string;
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

interface ResolvedModel {
  api: string;
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
}

function systemDefToResolved(def: ModelDefinition): ResolvedModel {
  return {
    api: def.api,
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
    const creds = await loadProviderKeyCredentials(orgId, dbDefault.providerKeyId);
    if (creds) {
      return {
        api: dbDefault.api,
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
      api: orgModels.api,
      baseUrl: orgModels.baseUrl,
      modelId: orgModels.modelId,
      providerKeyId: orgModels.providerKeyId,
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

  const creds = await loadProviderKeyCredentials(orgId, row.providerKeyId);
  if (!creds) return null;

  return {
    api: row.api,
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
  };
}

// --- Connection test ---

/** Build the discovery URL + headers used to probe a model provider. Pure for unit testing. */
export function buildModelTestRequest(config: { api: string; baseUrl: string; apiKey: string }): {
  url: string;
  headers: Record<string, string>;
} {
  const base = config.baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {};
  let url: string;

  switch (config.api) {
    case "anthropic-messages":
      url = `${base}/v1/models`;
      if (config.apiKey.startsWith("sk-ant-oat")) {
        headers["Authorization"] = `Bearer ${config.apiKey}`;
        headers["anthropic-beta"] = "oauth-2025-04-20";
      } else {
        headers["x-api-key"] = config.apiKey;
      }
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
  api: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
}): Promise<TestResult> {
  if (isBlockedUrl(config.baseUrl)) {
    return {
      ok: false,
      latency: 0,
      error: "BLOCKED_URL",
      message: "URL targets a blocked network",
    };
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
