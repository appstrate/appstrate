import { getEnv } from "@appstrate/env";
import { logger } from "../lib/logger.ts";
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

interface RawProviderKey {
  id: string;
  label: string;
  api: string;
  baseUrl: string;
  apiKey: string;
  models?: RawModel[];
}

interface RawModel {
  id?: string;
  modelId: string;
  label: string;
  input?: string[] | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
  reasoning?: boolean | null;
  cost?: ModelCost;
  isDefault?: boolean;
  enabled?: boolean;
}

function isValidProviderKey(pk: RawProviderKey): boolean {
  return !!(pk.id && pk.label && pk.api && pk.baseUrl && pk.apiKey);
}

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
    if (!isValidProviderKey(pk)) {
      logger.error(
        "[model-registry] SYSTEM_PROVIDER_KEYS: skipping invalid entry (missing id/label/api/baseUrl/apiKey)",
        { providerKey: { ...pk, apiKey: pk.apiKey ? "***" : undefined } },
      );
      continue;
    }

    pkMap.set(pk.id, {
      id: pk.id,
      label: pk.label,
      api: pk.api,
      baseUrl: pk.baseUrl,
      apiKey: pk.apiKey,
    });

    // Parse models under this provider key
    if (Array.isArray(pk.models)) {
      for (const m of pk.models) {
        if (!m.modelId || !m.label) {
          logger.error(
            "[model-registry] SYSTEM_PROVIDER_KEYS: skipping invalid model (missing modelId/label)",
            { providerKeyId: pk.id, model: m },
          );
          continue;
        }

        const modelId = m.id ?? `${pk.id}:${m.modelId}`;
        mdlMap.set(modelId, {
          id: modelId,
          label: m.label,
          api: pk.api,
          baseUrl: pk.baseUrl,
          modelId: m.modelId,
          apiKey: pk.apiKey,
          providerKeyId: pk.id,
          input: m.input ?? null,
          contextWindow: m.contextWindow ?? null,
          maxTokens: m.maxTokens ?? null,
          reasoning: m.reasoning ?? null,
          cost: m.cost ?? null,
          isDefault: m.isDefault,
          enabled: m.enabled,
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
