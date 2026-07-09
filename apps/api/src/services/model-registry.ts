// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { getEnv } from "@appstrate/env";
import { logger } from "../lib/logger.ts";
import { loadSystemRegistry } from "../lib/system-registry.ts";
import { modelCostSchema } from "@appstrate/core/module";
import { checkAliasInvariants } from "@appstrate/core/model-swap";
import type { ModelMetadata } from "@appstrate/shared-types";
import { getModelProvider } from "./model-providers/registry.ts";

// --- Types ---

export interface SystemModelProviderCredentialDefinition {
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
  /**
   * Model-alias flag. When true the `id` is a public alias and the binding
   * (`modelId`, `apiShape`, `baseUrl`, `apiKey`, `providerId`) is hidden from
   * user-facing surfaces — resolved server-side only. See {@link rawModelSchema}.
   */
  aliased?: boolean;
  /**
   * Optional display-icon key (a client `PROVIDER_ICONS` key). Deliberate public
   * choice, decoupled from the backing provider — lets an aliased model show an
   * icon without leaking its hidden binding. See {@link rawModelSchema}.
   */
  iconUrl?: string;
}

// --- State ---

let systemModelProviderCredentials: Map<string, SystemModelProviderCredentialDefinition> | null =
  null;
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
  /**
   * Model-alias flag (LLM-gateway alias pattern). When true, the entry's `id`
   * is a public alias and the real binding (`modelId`, `apiShape`, `baseUrl`,
   * `apiKey`, `providerId`) is hidden from user-facing surfaces: the list
   * projection strips it, the sidecar rewrites the `model` field in both
   * directions, and the agent container only ever sees the alias. The real id
   * stays server-side (resolution + private `llm_usage` ledger).
   */
  aliased: z.boolean().optional(),
  /**
   * Optional display-icon key (a client `PROVIDER_ICONS` key, e.g. `anthropic`,
   * `openai`). Deliberate public choice — decoupled from the backing provider,
   * so an aliased model can show an icon without leaking its hidden binding.
   * Unset → client falls back to a generic alias icon.
   */
  iconUrl: z.string().min(1).optional(),
});

const rawModelProviderCredentialSchema = z.object({
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

type RawModelProviderCredential = z.infer<typeof rawModelProviderCredentialSchema>;

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
export function initSystemModelProviderKeys(rawOverride?: unknown[]): void {
  const mdlMap = new Map<string, ModelDefinition>();

  // The provider-key map uses the shared registry skeleton (parse → validate →
  // dedupe → log). The nested models are built as a side effect of mapping each
  // key (they inherit the key's resolved apiShape/baseUrl/apiKey), so they live
  // inside `toDefinition` rather than a second pass.
  systemModelProviderCredentials = loadSystemRegistry<
    RawModelProviderCredential,
    SystemModelProviderCredentialDefinition
  >({
    name: "model-registry",
    envVar: "SYSTEM_PROVIDER_KEYS",
    // Production reads the parsed env; tests inject a raw array directly (the
    // env is cached at first access, so an override seam is cleaner than
    // mutating process.env after boot) — mirrors initSystemIntegrations.
    entries: rawOverride ?? (getEnv().SYSTEM_PROVIDER_KEYS as unknown[]),
    schema: rawModelProviderCredentialSchema,
    // toDefinition populates mdlMap (the nested models) as a side effect, so a
    // duplicate id must be rejected BEFORE it runs — else the losing entry's
    // models still leak into systemModels while its credential is dropped.
    idOf: (raw) => raw.id,
    redact: (entry) => {
      const e = entry as Record<string, unknown>;
      return { ...e, apiKey: e.apiKey ? "***" : undefined };
    },
    toDefinition: (validCredential) => {
      const provider = getModelProvider(validCredential.providerId);
      if (!provider) {
        logger.error("[model-registry] SYSTEM_PROVIDER_KEYS: skipping entry — unknown providerId", {
          modelProviderCredentialId: validCredential.id,
          providerId: validCredential.providerId,
        });
        return null;
      }

      if (validCredential.baseUrlOverride && !provider.baseUrlOverridable) {
        logger.error(
          "[model-registry] SYSTEM_PROVIDER_KEYS: skipping entry — baseUrlOverride supplied " +
            "but provider does not allow it",
          {
            modelProviderCredentialId: validCredential.id,
            providerId: validCredential.providerId,
          },
        );
        return null;
      }

      const apiShape = provider.apiShape;
      const baseUrl = validCredential.baseUrlOverride ?? provider.defaultBaseUrl;

      // Parse models under this model provider key (side effect → mdlMap).
      if (Array.isArray(validCredential.models)) {
        for (const m of validCredential.models) {
          const mResult = rawModelSchema.safeParse(m);
          if (!mResult.success) {
            logger.error("[model-registry] SYSTEM_PROVIDER_KEYS: skipping invalid model", {
              modelProviderCredentialId: validCredential.id,
              error: mResult.error.issues[0]?.message,
              model: m,
            });
            continue;
          }
          const validM = mResult.data;

          // Model-alias guards (issue #727, Threat A) — same invariants the
          // POST /api/models route enforces for DB models. A misconfigured
          // alias would leak its backing rather than hide it, so skip it
          // (loud) instead of registering a half-working alias.
          if (validM.aliased === true) {
            // SYSTEM_PROVIDER_KEYS entries are static API keys by construction,
            // so the oauth_provider violation is unreachable here.
            const violation = checkAliasInvariants({
              label: validM.label,
              apiShape,
              authMode: "api_key",
            });
            if (violation === "missing_label") {
              logger.error(
                "[model-registry] SYSTEM_PROVIDER_KEYS: skipping aliased model without an explicit label (the derived label would name the backing)",
                { modelProviderCredentialId: validCredential.id, model: m },
              );
              continue;
            }
            if (violation === "non_aliasable_shape") {
              logger.error(
                "[model-registry] SYSTEM_PROVIDER_KEYS: skipping aliased model — protocol carries the model id in the URL, not the body, so the swap can't hide it",
                { modelProviderCredentialId: validCredential.id, apiShape, model: m },
              );
              continue;
            }
          }

          const modelId = validM.id ?? `${validCredential.id}:${validM.modelId}`;
          mdlMap.set(modelId, {
            id: modelId,
            // Pass through env-supplied label; read path falls back to the
            // vendored catalog (`<catalogProviderId ?? providerId>.label`).
            ...(validM.label ? { label: validM.label } : {}),
            providerId: validCredential.providerId,
            apiShape,
            baseUrl,
            modelId: validM.modelId,
            apiKey: validCredential.apiKey,
            credentialId: validCredential.id,
            input: validM.input ?? null,
            contextWindow: validM.contextWindow ?? null,
            maxTokens: validM.maxTokens ?? null,
            reasoning: validM.reasoning ?? null,
            cost: validM.cost ?? null,
            isDefault: validM.isDefault,
            enabled: validM.enabled,
            aliased: validM.aliased === true,
            ...(validM.iconUrl ? { iconUrl: validM.iconUrl } : {}),
          });
        }
      }

      return {
        id: validCredential.id,
        // Pass through the env-supplied label as-is. The read path
        // (`org-models.ts` resolved-model builders) falls back to
        // `getModelProvider(providerId).displayName` when unset.
        ...(validCredential.label ? { label: validCredential.label } : {}),
        providerId: validCredential.providerId,
        apiShape,
        baseUrl,
        apiKey: validCredential.apiKey,
      };
    },
  });
  systemModels = mdlMap;
}

// --- Accessors ---

export function getSystemModelProviderCredentials(): ReadonlyMap<
  string,
  SystemModelProviderCredentialDefinition
> {
  if (!systemModelProviderCredentials) {
    throw new Error(
      "[model-registry] System model provider keys not initialized. Call initSystemModelProviderKeys() at boot.",
    );
  }
  return systemModelProviderCredentials;
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

export function isSystemModelProviderCredential(keyId: string): boolean {
  return systemModelProviderCredentials?.has(keyId) ?? false;
}
