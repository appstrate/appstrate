import { getEnv } from "@appstrate/env";
import { logger } from "../lib/logger.ts";

export interface ModelDefinition {
  id: string;
  label: string;
  api: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
  isDefault?: boolean;
  enabled?: boolean;
}

let systemModels: Map<string, ModelDefinition> | null = null;

function isValidModel(m: ModelDefinition): boolean {
  return !!(m.id && m.label && m.api && m.baseUrl && m.modelId && m.apiKey);
}

function parseEnvModels(): ModelDefinition[] {
  const raw = getEnv().SYSTEM_MODELS;
  return raw as ModelDefinition[];
}

/**
 * Initialize system models from the SYSTEM_MODELS env var.
 * Call once at boot before any model lookups.
 */
export function initSystemModels(): void {
  const map = new Map<string, ModelDefinition>();
  const models = parseEnvModels();

  for (const m of models) {
    if (!isValidModel(m)) {
      logger.error(
        "[model-registry] SYSTEM_MODELS: skipping invalid entry (missing id/label/api/baseUrl/modelId/apiKey)",
        {
          model: { ...m, apiKey: m.apiKey ? "***" : undefined },
        },
      );
      continue;
    }
    map.set(m.id, m);
  }

  systemModels = map;
}

export function getSystemModels(): ReadonlyMap<string, ModelDefinition> {
  if (!systemModels) {
    throw new Error(
      "[model-registry] System models not initialized. Call initSystemModels() at boot.",
    );
  }
  return systemModels;
}

export function isSystemModel(modelId: string): boolean {
  return systemModels?.has(modelId) ?? false;
}
