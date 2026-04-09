// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { getEnv } from "@appstrate/env";
import { logger } from "../lib/logger.ts";
import { modelCostSchema } from "./adapters/types.ts";
import type { ModelCost } from "./adapters/types.ts";

// --- Types ---

export interface SystemProviderKeyDefinition {
  id: string;
  label: string;
  api: string;
  baseUrl: string;
  apiKey: string;
}

export interface ModelDefinition {
  id: string;
  label: string;
  api: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
  providerKeyId: string;
  input?: string[] | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
  reasoning?: boolean | null;
  cost?: ModelCost | null;
  isDefault?: boolean;
  enabled?: boolean;
}

// --- State ---

let systemProviderKeys: Map<string, SystemProviderKeyDefinition> | null = null;
let systemModels: Map<string, ModelDefinition> | null = null;

// --- Parsing ---

const rawModelSchema = z.object({
  id: z.string().optional(),
  modelId: z.string().min(1),
  label: z.string().min(1),
  input: z.array(z.string()).nullable().optional(),
  contextWindow: z.number().positive().nullable().optional(),
  maxTokens: z.number().positive().nullable().optional(),
  reasoning: z.boolean().nullable().optional(),
  cost: modelCostSchema.optional(),
  isDefault: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

const rawProviderKeySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  api: z.string().min(1),
  baseUrl: z.string().min(1),
  apiKey: z.string().min(1),
  models: z.array(rawModelSchema).optional(),
});

type RawProviderKey = z.infer<typeof rawProviderKeySchema>;

/**
 * Initialize system provider keys and models from the SYSTEM_PROVIDER_KEYS env var.
 * Call once at boot before any model lookups.
 *
 * Format:
 * ```json
 * [{
 *   "id": "anthropic-prod",
 *   "label": "Anthropic",
 *   "api": "anthropic-messages",
 *   "baseUrl": "https://api.anthropic.com",
 *   "apiKey": "sk-ant-...",
 *   "models": [
 *     { "modelId": "claude-opus-4-6", "label": "Claude Opus 4.6", "isDefault": true }
 *   ]
 * }]
 * ```
 */
export function initSystemProviderKeys(): void {
  const pkMap = new Map<string, SystemProviderKeyDefinition>();
  const mdlMap = new Map<string, ModelDefinition>();

  const raw = getEnv().SYSTEM_PROVIDER_KEYS as RawProviderKey[];

  for (const pk of raw) {
    const pkResult = rawProviderKeySchema.safeParse(pk);
    if (!pkResult.success) {
      logger.error("[model-registry] SYSTEM_PROVIDER_KEYS: skipping invalid entry", {
        error: pkResult.error.issues[0]?.message,
        providerKey: { ...pk, apiKey: pk.apiKey ? "***" : undefined },
      });
      continue;
    }
    const validPk = pkResult.data;

    pkMap.set(validPk.id, {
      id: validPk.id,
      label: validPk.label,
      api: validPk.api,
      baseUrl: validPk.baseUrl,
      apiKey: validPk.apiKey,
    });

    // Parse models under this provider key
    if (Array.isArray(validPk.models)) {
      for (const m of validPk.models) {
        const mResult = rawModelSchema.safeParse(m);
        if (!mResult.success) {
          logger.error("[model-registry] SYSTEM_PROVIDER_KEYS: skipping invalid model", {
            providerKeyId: validPk.id,
            error: mResult.error.issues[0]?.message,
            model: m,
          });
          continue;
        }
        const validM = mResult.data;

        const modelId = validM.id ?? `${validPk.id}:${validM.modelId}`;
        mdlMap.set(modelId, {
          id: modelId,
          label: validM.label,
          api: validPk.api,
          baseUrl: validPk.baseUrl,
          modelId: validM.modelId,
          apiKey: validPk.apiKey,
          providerKeyId: validPk.id,
          input: validM.input ?? null,
          contextWindow: validM.contextWindow ?? null,
          maxTokens: validM.maxTokens ?? null,
          reasoning: validM.reasoning ?? null,
          cost: validM.cost ?? null,
          isDefault: validM.isDefault,
          enabled: validM.enabled,
        });
      }
    }
  }

  systemProviderKeys = pkMap;
  systemModels = mdlMap;
}

// --- Accessors ---

export function getSystemProviderKeys(): ReadonlyMap<string, SystemProviderKeyDefinition> {
  if (!systemProviderKeys) {
    throw new Error(
      "[model-registry] System provider keys not initialized. Call initSystemProviderKeys() at boot.",
    );
  }
  return systemProviderKeys;
}

export function getSystemModels(): ReadonlyMap<string, ModelDefinition> {
  if (!systemModels) {
    throw new Error(
      "[model-registry] System models not initialized. Call initSystemProviderKeys() at boot.",
    );
  }
  return systemModels;
}

export function isSystemModel(modelId: string): boolean {
  return systemModels?.has(modelId) ?? false;
}

export function isSystemProviderKey(keyId: string): boolean {
  return systemProviderKeys?.has(keyId) ?? false;
}

/**
 * Resolve a model from system models only (SYSTEM_PROVIDER_KEYS env).
 * Used as fallback when the provider-management module is not loaded.
 * Returns the specified model or the system default, or null.
 */
import type { ResolvedModelResult as SystemResolvedModel } from "@appstrate/core/module";
export type { SystemResolvedModel };

export function resolveSystemModel(modelId?: string | null): SystemResolvedModel | null {
  const models = getSystemModels();
  if (modelId) {
    const def = models.get(modelId);
    if (!def) return null;
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
  // Find system default
  for (const def of models.values()) {
    if (def.isDefault) {
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
  }
  return null;
}
