// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { getEnv } from "@appstrate/env";
import { logger } from "../lib/logger.ts";
import { modelCostSchema } from "@appstrate/shared-types";
import type { ModelCost } from "@appstrate/shared-types";

// --- Types ---

export interface SystemModelProviderKeyDefinition {
  id: string;
  label: string;
  apiShape: string;
  baseUrl: string;
  apiKey: string;
}

export interface ModelDefinition {
  id: string;
  label: string;
  apiShape: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
  credentialId: string;
  input?: string[] | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
  reasoning?: boolean | null;
  cost?: ModelCost | null;
  isDefault?: boolean;
  enabled?: boolean;
}

// --- State ---

let systemModelProviderKeys: Map<string, SystemModelProviderKeyDefinition> | null = null;
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

const rawModelProviderKeySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  apiShape: z.string().min(1),
  baseUrl: z.string().min(1),
  apiKey: z.string().min(1),
  models: z.array(rawModelSchema).optional(),
});

type RawModelProviderKey = z.infer<typeof rawModelProviderKeySchema>;

/**
 * Initialize system model provider keys and models from the SYSTEM_PROVIDER_KEYS env var.
 * Call once at boot before any model lookups.
 *
 * NOTE: The env var name is preserved for backward compatibility with self-hosted
 * deployments. The TypeScript identifiers are renamed to disambiguate from OAuth
 * providers (Gmail, ClickUp, etc.).
 *
 * Format:
 * ```json
 * [{
 *   "id": "anthropic-prod",
 *   "label": "Anthropic",
 *   "apiShape": "anthropic-messages",
 *   "baseUrl": "https://api.anthropic.com",
 *   "apiKey": "sk-ant-...",
 *   "models": [
 *     { "modelId": "claude-opus-4-6", "label": "Claude Opus 4.6", "isDefault": true }
 *   ]
 * }]
 * ```
 */
export function initSystemModelProviderKeys(): void {
  const pkMap = new Map<string, SystemModelProviderKeyDefinition>();
  const mdlMap = new Map<string, ModelDefinition>();

  const raw = getEnv().SYSTEM_PROVIDER_KEYS as RawModelProviderKey[];

  for (const pk of raw) {
    const pkResult = rawModelProviderKeySchema.safeParse(pk);
    if (!pkResult.success) {
      logger.error("[model-registry] SYSTEM_PROVIDER_KEYS: skipping invalid entry", {
        error: pkResult.error.issues[0]?.message,
        modelProviderKey: { ...pk, apiKey: pk.apiKey ? "***" : undefined },
      });
      continue;
    }
    const validPk = pkResult.data;

    pkMap.set(validPk.id, {
      id: validPk.id,
      label: validPk.label,
      apiShape: validPk.apiShape,
      baseUrl: validPk.baseUrl,
      apiKey: validPk.apiKey,
    });

    // Parse models under this model provider key
    if (Array.isArray(validPk.models)) {
      for (const m of validPk.models) {
        const mResult = rawModelSchema.safeParse(m);
        if (!mResult.success) {
          logger.error("[model-registry] SYSTEM_PROVIDER_KEYS: skipping invalid model", {
            modelProviderKeyId: validPk.id,
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
          apiShape: validPk.apiShape,
          baseUrl: validPk.baseUrl,
          modelId: validM.modelId,
          apiKey: validPk.apiKey,
          credentialId: validPk.id,
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

  systemModelProviderKeys = pkMap;
  systemModels = mdlMap;
}

// --- Accessors ---

export function getSystemModelProviderKeys(): ReadonlyMap<
  string,
  SystemModelProviderKeyDefinition
> {
  if (!systemModelProviderKeys) {
    throw new Error(
      "[model-registry] System model provider keys not initialized. Call initSystemModelProviderKeys() at boot.",
    );
  }
  return systemModelProviderKeys;
}

export function getSystemModels(): ReadonlyMap<string, ModelDefinition> {
  if (!systemModels) {
    throw new Error(
      "[model-registry] System models not initialized. Call initSystemModelProviderKeys() at boot.",
    );
  }
  return systemModels;
}

export function isSystemModel(modelId: string): boolean {
  return systemModels?.has(modelId) ?? false;
}

export function isSystemModelProviderKey(keyId: string): boolean {
  return systemModelProviderKeys?.has(keyId) ?? false;
}
