// SPDX-License-Identifier: Apache-2.0

/**
 * Legacy facade over `model_provider_credentials`.
 *
 * The route contract (`/api/model-provider-keys`) is preserved verbatim — it
 * takes `(api, baseUrl, apiKey)` — but every CRUD operation now reads/writes
 * the unified `model_provider_credentials` table. The `(api, baseUrl)` pair
 * is reverse-resolved against the platform registry to a canonical
 * `providerId`; unknown combinations fall back to `openai-compatible` with a
 * `baseUrlOverride`.
 *
 * Phase 6 will rename the routes and require explicit `providerId`, retiring
 * this shim.
 */

import { listModelProviders, getModelProviderConfig } from "./oauth-model-providers/registry.ts";
import { getSystemModelProviderKeys } from "./model-registry.ts";
import type { OrgModelProviderKeyInfo, TestResult } from "@appstrate/shared-types";
import { testModelConfig } from "./org-models.ts";
import { mergeSystemAndDb } from "../lib/db-helpers.ts";
import { toISORequired } from "../lib/date-helpers.ts";
import {
  listModelProviderCredentials,
  loadModelProviderCredentials,
  createApiKeyCredential,
  updateModelProviderCredential,
  deleteModelProviderCredential,
  type ModelProviderCredentialInfo,
} from "./model-provider-credentials.ts";

// --- Provider resolution (api, baseUrl → providerId) ---

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Resolve `(api, baseUrl)` to a registry providerId. Matches an `api_key`
 * provider whose `apiShape` and `defaultBaseUrl` align; falls back to
 * `openai-compatible` with a `baseUrlOverride` for any unrecognized combo.
 */
export function resolveProviderIdFromApiKeyForm(
  api: string,
  baseUrl: string,
): { providerId: string; baseUrlOverride: string | null } {
  const normalizedBaseUrl = stripTrailingSlash(baseUrl);
  for (const cfg of listModelProviders()) {
    if (cfg.authMode !== "api_key") continue;
    if (cfg.providerId === "openai-compatible") continue; // explicit fallback below
    if (cfg.apiShape === api && stripTrailingSlash(cfg.defaultBaseUrl) === normalizedBaseUrl) {
      return { providerId: cfg.providerId, baseUrlOverride: null };
    }
  }
  return { providerId: "openai-compatible", baseUrlOverride: baseUrl };
}

// --- List (system + unified credentials) ---

function adaptCredentialInfoToLegacyShape(
  info: ModelProviderCredentialInfo,
): OrgModelProviderKeyInfo {
  const cfg = getModelProviderConfig(info.providerId);
  return {
    id: info.id,
    label: info.label,
    api: cfg?.apiShape ?? "openai-chat",
    baseUrl: info.baseUrl,
    source: "custom",
    authMode: info.authMode === "oauth2" ? "oauth" : "api_key",
    providerPackageId: info.providerId,
    oauthConnectionId: info.authMode === "oauth2" ? info.id : null,
    oauthEmail: info.oauthEmail ?? null,
    needsReconnection: info.oauthNeedsReconnection ?? false,
    createdBy: info.createdBy,
    createdAt: info.createdAt,
    updatedAt: info.updatedAt,
  };
}

export async function listOrgModelProviderKeys(orgId: string): Promise<OrgModelProviderKeyInfo[]> {
  const system = getSystemModelProviderKeys();
  const now = toISORequired(new Date());
  const rows = await listModelProviderCredentials(orgId);

  return mergeSystemAndDb({
    system,
    rows,
    mapSystem: (id, def): OrgModelProviderKeyInfo => ({
      id,
      label: def.label,
      api: def.api,
      baseUrl: def.baseUrl,
      source: "built-in",
      authMode: "api_key",
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    }),
    mapRow: adaptCredentialInfoToLegacyShape,
  });
}

// --- CRUD ---

export async function createOrgModelProviderKey(
  orgId: string,
  label: string,
  api: string,
  baseUrl: string,
  apiKey: string,
  userId: string,
): Promise<string> {
  const { providerId, baseUrlOverride } = resolveProviderIdFromApiKeyForm(api, baseUrl);
  return createApiKeyCredential({
    orgId,
    userId,
    label,
    providerId,
    apiKey,
    baseUrlOverride,
  });
}

export async function updateOrgModelProviderKey(
  orgId: string,
  id: string,
  data: { label?: string; api?: string; baseUrl?: string; apiKey?: string },
): Promise<void> {
  // `api` and `baseUrl` mutations are silently ignored — the registry pins
  // both via `providerId`, and rotating those is a Phase 6 concern (the
  // future routes will accept `providerId` explicitly). Label and apiKey
  // rotation flow through the unified service.
  await updateModelProviderCredential(orgId, id, {
    ...(data.label !== undefined ? { label: data.label } : {}),
    ...(data.apiKey !== undefined ? { apiKey: data.apiKey } : {}),
  });
}

export async function deleteOrgModelProviderKey(orgId: string, id: string): Promise<void> {
  await deleteModelProviderCredential(orgId, id);
}

// --- Credential loading ---

/**
 * Returned shape preserved for back-compat. `providerPackageId` is populated
 * for OAuth-backed keys (canonical short form like "codex" / "claude-code");
 * `accountId` for Codex.
 */
export interface ModelProviderKeyCredentials {
  api: string;
  baseUrl: string;
  apiKey: string;
  providerPackageId?: string;
  /** Codex only: extracted from the JWT and required as `chatgpt-account-id` header on inference. */
  accountId?: string;
}

export async function loadModelProviderKeyCredentials(
  orgId: string,
  id: string,
): Promise<ModelProviderKeyCredentials | null> {
  // 1) System (env-driven) keys.
  const systemKey = getSystemModelProviderKeys().get(id);
  if (systemKey) {
    return { api: systemKey.api, baseUrl: systemKey.baseUrl, apiKey: systemKey.apiKey };
  }

  // 2) Unified credentials table (covers api-key + OAuth).
  const creds = await loadModelProviderCredentials(orgId, id);
  if (!creds) return null;
  if (creds.needsReconnection) return null;
  return {
    api: creds.apiShape,
    baseUrl: creds.baseUrl,
    apiKey: creds.apiKey,
    providerPackageId: creds.providerId,
    accountId: creds.accountId,
  };
}

// --- Connection test ---

export async function testModelProviderKeyConnection(
  orgId: string,
  id: string,
): Promise<TestResult> {
  const creds = await loadModelProviderKeyCredentials(orgId, id);
  if (!creds)
    return {
      ok: false,
      latency: 0,
      error: "KEY_NOT_FOUND",
      message: "Model provider key not found",
    };

  // OAuth providers reject the dummy `_test` model id — fall back to the
  // registry's first model (sized for a low-cost probe regardless).
  let modelId = "_test";
  if (creds.providerPackageId) {
    const cfg = getModelProviderConfig(creds.providerPackageId);
    if (cfg && cfg.models.length > 0) modelId = cfg.models[0]!.id;
  }
  return testModelConfig({ ...creds, modelId });
}
