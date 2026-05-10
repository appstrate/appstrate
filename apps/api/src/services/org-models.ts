// SPDX-License-Identifier: Apache-2.0

import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { orgModels } from "@appstrate/db/schema";
import { getSystemModels, isSystemModel, type ModelDefinition } from "./model-registry.ts";
import type { ModelCost } from "@appstrate/shared-types";
import { logger } from "../lib/logger.ts";
import { isBlockedUrl } from "@appstrate/core/ssrf";
import type { OrgModelInfo, TestResult } from "@appstrate/shared-types";
import { loadModelProviderKeyCredentials } from "./org-model-provider-keys.ts";
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
      const creds = await loadModelProviderKeyCredentials(orgId, id);
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
  /** Set for OAuth-backed model provider keys; gates provider-specific request shape. */
  providerPackageId?: string;
  /** Codex only: required as `chatgpt-account-id` header on inference probes/runs. */
  accountId?: string;
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
    const creds = await loadModelProviderKeyCredentials(orgId, dbDefault.providerKeyId);
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
        providerPackageId: creds.providerPackageId,
        accountId: creds.accountId,
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

  const creds = await loadModelProviderKeyCredentials(orgId, row.providerKeyId);
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
    providerPackageId: creds.providerPackageId,
    accountId: creds.accountId,
  };
}

// --- Connection test ---

/** Build the discovery URL + headers used to probe a model provider. Pure for unit testing. */
export function buildModelTestRequest(config: {
  api: string;
  baseUrl: string;
  apiKey: string;
  providerPackageId?: string;
}): {
  url: string;
  headers: Record<string, string>;
} {
  const base = config.baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {};
  let url: string;

  // OAuth-backed Anthropic flows (sk-ant-oat API tokens or Claude Code OAuth
  // access tokens) probe `/v1/models` with the OAuth headers; the package id
  // is the canonical signal — sk-ant-oat prefix is the legacy fallback.
  const isAnthropicOAuth =
    config.providerPackageId === "@appstrate/provider-claude-code" ||
    config.apiKey.startsWith("sk-ant-oat");

  switch (config.api) {
    case "anthropic-messages":
      url = `${base}/v1/models`;
      if (isAnthropicOAuth) {
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
  providerPackageId?: string;
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

  // OAuth-backed providers don't expose a `/models` discovery endpoint
  // compatible with the Bearer token (Codex has no /models at all on
  // chatgpt.com/backend-api; Claude Code's /v1/models would 200 even when
  // /v1/messages is blocked by the third-party OAuth ban). Issue a real
  // single-token inference probe so the test reflects whether the key can
  // actually serve traffic.
  if (config.providerPackageId === "@appstrate/provider-codex") {
    return testCodexInference(config);
  }
  if (config.providerPackageId === "@appstrate/provider-claude-code") {
    return testClaudeCodeInference(config);
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
 * Codex (ChatGPT subscription) inference probe — single-token request to
 * `${baseUrl}/codex/responses` with the SSE shape pi-ai uses in production
 * (cf. node_modules/@mariozechner/pi-ai/dist/providers/openai-codex-responses.js).
 *
 * On 200 the connection works end-to-end (oauth + chatgpt backend +
 * subscription + model availability). The streaming body is canceled
 * immediately — we only care about the response status.
 */
async function testCodexInference(config: {
  baseUrl: string;
  modelId: string;
  apiKey: string;
  accountId?: string;
}): Promise<TestResult> {
  if (!config.accountId) {
    return {
      ok: false,
      latency: 0,
      error: "AUTH_FAILED",
      message: "Missing chatgpt-account-id (token may not be a valid Codex JWT)",
    };
  }
  const url = `${config.baseUrl.replace(/\/+$/, "")}/codex/responses`;
  const body = JSON.stringify({
    model: config.modelId,
    store: false,
    stream: true,
    instructions: "ping",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ping" }] }],
    include: [],
  });
  const start = performance.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "chatgpt-account-id": config.accountId,
        originator: "appstrate",
        "OpenAI-Beta": "responses=experimental",
        accept: "text/event-stream",
        "content-type": "application/json",
      },
      body,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const latency = Math.round(performance.now() - start);
    // We only need the response status — abort the stream we've started.
    void res.body?.cancel().catch(() => {});
    if (res.ok) return { ok: true, latency };
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        latency,
        error: "AUTH_FAILED",
        message: "ChatGPT subscription rejected the token (auth failed or subscription inactive)",
      };
    }
    return {
      ok: false,
      latency,
      error: "PROVIDER_ERROR",
      message: `Codex backend returned ${res.status}`,
    };
  } catch (err) {
    return mapFetchErrorToTestResult(err, Math.round(performance.now() - start));
  }
}

/**
 * Claude Code (Anthropic subscription) inference probe — single-token
 * `/v1/messages` call mirroring pi-ai's "stealth mode" exactly: Anthropic
 * 429s/403s requests that don't impersonate the official Claude Code CLI
 * (third-party enforcement since 2026-01-09). The required signals are:
 *
 *   - `anthropic-beta: claude-code-20250219,oauth-2025-04-20`
 *   - `user-agent: claude-cli/<version>`
 *   - `x-app: cli`
 *   - `anthropic-dangerous-direct-browser-access: true`
 *   - First system message: "You are Claude Code, Anthropic's official CLI for Claude."
 *
 * cf. node_modules/@mariozechner/pi-ai/dist/providers/anthropic.js (search
 * for `claudeCodeVersion`). Keep the version in sync with what pi-ai pins.
 */
const CLAUDE_CODE_CLI_VERSION = "2.1.75";

async function testClaudeCodeInference(config: {
  baseUrl: string;
  modelId: string;
  apiKey: string;
}): Promise<TestResult> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/v1/messages`;
  const body = JSON.stringify({
    model: config.modelId,
    max_tokens: 1,
    system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
    messages: [{ role: "user", content: "ping" }],
  });
  const start = performance.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        "user-agent": `claude-cli/${CLAUDE_CODE_CLI_VERSION}`,
        "x-app": "cli",
        accept: "application/json",
        "content-type": "application/json",
      },
      body,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const latency = Math.round(performance.now() - start);
    if (res.ok) {
      void res.body?.cancel().catch(() => {});
      return { ok: true, latency };
    }
    // Read the error body up to 1 KB to catch the third-party enforcement signal.
    const text = await res
      .text()
      .then((t) => t.slice(0, 1024))
      .catch(() => "");
    if (
      (res.status === 403 || res.status === 429) &&
      /third.?party|claude code|oauth.{0,40}(not allowed|not permitted|disabled)/i.test(text)
    ) {
      return {
        ok: false,
        latency,
        error: "OAUTH_TIER_BLOCKED",
        message:
          "Anthropic blocks third-party use of Claude Code OAuth tokens (in effect since 2026-01-09). Use a paid API plan instead.",
      };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        latency,
        error: "AUTH_FAILED",
        message: "Anthropic rejected the token (auth failed or subscription inactive)",
      };
    }
    if (res.status === 429) {
      // Anthropic's per-IP / per-account rate limit on Claude Code OAuth is
      // aggressive (kicks in after a handful of probes from the same IP).
      // Surface a Retry-After hint when the upstream provides one.
      const retryAfter = res.headers.get("retry-after");
      return {
        ok: false,
        latency,
        error: "RATE_LIMITED",
        message: retryAfter
          ? `Anthropic rate limit hit — retry in ${retryAfter}s`
          : "Anthropic rate limit hit on the OAuth tier — try again in a minute",
      };
    }
    return {
      ok: false,
      latency,
      error: "PROVIDER_ERROR",
      message: `Anthropic returned ${res.status}`,
    };
  } catch (err) {
    return mapFetchErrorToTestResult(err, Math.round(performance.now() - start));
  }
}
