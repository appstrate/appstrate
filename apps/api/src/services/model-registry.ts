// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { getEnv } from "@appstrate/env";
import { logger } from "../lib/logger.ts";
import { modelCostSchema } from "@appstrate/shared-types";
import type { ModelMetadata } from "@appstrate/shared-types";
import { getModelProvider } from "./model-providers/registry.ts";

// --- Types ---

export interface SystemModelProviderKeyDefinition {
  id: string;
  /**
   * Optional. Resolved at boot from `getModelProvider(providerId).displayName`
   * when the env entry omits it — the registry is the single source of truth
   * for human-readable names. `id` is the disambiguator across entries that
   * share a `providerId`.
   */
  label?: string;
  /** Registered ModelProviderDefinition id this env entry binds to (e.g. "anthropic", "openai"). */
  providerId: string;
  /** Resolved from registry at boot — never persisted. */
  apiShape: string;
  /** Resolved from registry at boot (with override if `baseUrlOverridable`) — never persisted. */
  baseUrl: string;
  apiKey: string;
}

export interface ModelDefinition extends ModelMetadata {
  id: string;
  /**
   * Optional. The resolver in `org-models.ts` falls back to the vendored
   * pricing catalog (`<catalogProviderId ?? providerId>.label`) at read time
   * when this is unset — keeps env entries minimal and lets catalog refreshes
   * propagate.
   */
  label?: string;
  /** Registered ModelProviderDefinition id — propagated from the parent system key. */
  providerId: string;
  /** Resolved from registry at boot — never persisted. */
  apiShape: string;
  /** Resolved from registry at boot — never persisted. */
  baseUrl: string;
  modelId: string;
  apiKey: string;
  credentialId: string;
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
  /** Optional — falls back to the vendored catalog label at resolve time. */
  label: z.string().min(1).optional(),
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
  /** Optional — falls back to the registry's `displayName` for this providerId. */
  label: z.string().min(1).optional(),
  /**
   * Binds this env entry to a registered ModelProviderDefinition. The
   * registry is the single source of truth for `apiShape` and the default
   * base URL — both are resolved from `providerId` at boot.
   */
  providerId: z.string().min(1),
  /**
   * Override the registry's `defaultBaseUrl`. Honored ONLY when the
   * provider declares `baseUrlOverridable: true` (today: `openai-compatible`).
   * For any other provider, supplying this is a configuration error and
   * the env entry is rejected at boot.
   */
  baseUrlOverride: z.string().min(1).optional(),
  apiKey: z.string().min(1),
  models: z.array(rawModelSchema).optional(),
});

type RawModelProviderKey = z.infer<typeof rawModelProviderKeySchema>;

/**
 * Initialize system model provider keys and models from the SYSTEM_PROVIDER_KEYS env var.
 * Call once at boot AFTER `registerModelProviders()` — the env entries
 * resolve their `apiShape` + `baseUrl` from the registry by `providerId`.
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
 *   "providerId": "anthropic",
 *   "apiKey": "sk-ant-...",
 *   "models": [
 *     { "modelId": "claude-opus-4-6", "label": "Claude Opus 4.6", "isDefault": true }
 *   ]
 * }]
 * ```
 *
 * For `openai-compatible` (the only `baseUrlOverridable: true` provider),
 * add `"baseUrlOverride": "https://my-endpoint/v1"`.
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

    const provider = getModelProvider(validPk.providerId);
    if (!provider) {
      logger.error("[model-registry] SYSTEM_PROVIDER_KEYS: skipping entry — unknown providerId", {
        modelProviderKeyId: validPk.id,
        providerId: validPk.providerId,
      });
      continue;
    }

    if (validPk.baseUrlOverride && !provider.baseUrlOverridable) {
      logger.error(
        "[model-registry] SYSTEM_PROVIDER_KEYS: skipping entry — baseUrlOverride supplied " +
          "but provider does not allow it",
        {
          modelProviderKeyId: validPk.id,
          providerId: validPk.providerId,
        },
      );
      continue;
    }

    const apiShape = provider.apiShape;
    const baseUrl = validPk.baseUrlOverride ?? provider.defaultBaseUrl;

    pkMap.set(validPk.id, {
      id: validPk.id,
      // Pass through the env-supplied label as-is. The read path
      // (`org-models.ts` resolved-model builders) falls back to
      // `getModelProvider(providerId).displayName` when unset.
      ...(validPk.label ? { label: validPk.label } : {}),
      providerId: validPk.providerId,
      apiShape,
      baseUrl,
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
          // Pass through env-supplied label; read path falls back to the
          // vendored catalog (`<catalogProviderId ?? providerId>.label`).
          ...(validM.label ? { label: validM.label } : {}),
          providerId: validPk.providerId,
          apiShape,
          baseUrl,
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
