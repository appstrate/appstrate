// SPDX-License-Identifier: Apache-2.0

/**
 * Legacy org-scoped model-provider-keys service.
 *
 * Phase 4-transition shim. The API-key creation/update path still writes
 * to `org_system_provider_keys` to keep the existing routes working
 * unchanged; the OAuth path has fully moved to `model_provider_credentials`
 * via {@link createOAuthCredential}.
 *
 * The read path is polymorphic — `listOrgModelProviderKeys` and
 * `loadModelProviderKeyCredentials` consult both tables and merge their
 * results so a `providerKeyId` referenced from `org_models.providerKeyId`
 * resolves regardless of which table holds it. Phase 5 retires the legacy
 * table and re-adds a strict FK to `model_provider_credentials`.
 */

import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { orgSystemProviderKeys } from "@appstrate/db/schema";
import { encrypt, decrypt } from "@appstrate/connect";
import { getSystemModelProviderKeys } from "./model-registry.ts";
import type { OrgModelProviderKeyInfo, TestResult } from "@appstrate/shared-types";
import { testModelConfig } from "./org-models.ts";
import { mergeSystemAndDb, buildUpdateSet, scopedWhere } from "../lib/db-helpers.ts";
import { toISO, toISORequired } from "../lib/date-helpers.ts";
import { getModelProviderConfig } from "./oauth-model-providers/registry.ts";
import {
  listModelProviderCredentials,
  loadModelProviderCredentials,
  type ModelProviderCredentialInfo,
} from "./model-provider-credentials.ts";

// --- List (system + legacy DB rows + new credentials table) ---

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
  const legacyRows = await db
    .select()
    .from(orgSystemProviderKeys)
    .where(scopedWhere(orgSystemProviderKeys, { orgId }));
  const now = toISORequired(new Date());

  const legacyAsLegacyShape = mergeSystemAndDb({
    system,
    rows: legacyRows,
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
    mapRow: (r): OrgModelProviderKeyInfo => ({
      id: r.id,
      label: r.label,
      api: r.api,
      baseUrl: r.baseUrl,
      source: "custom",
      authMode: r.authMode,
      providerPackageId: r.providerPackageId ?? null,
      oauthConnectionId: r.oauthConnectionId ?? null,
      oauthEmail: null,
      needsReconnection: false,
      createdBy: r.createdBy,
      createdAt: toISO(r.createdAt) ?? now,
      updatedAt: toISO(r.updatedAt) ?? now,
    }),
  });

  const newRows = await listModelProviderCredentials(orgId);
  return [...legacyAsLegacyShape, ...newRows.map(adaptCredentialInfoToLegacyShape)];
}

// --- CRUD (legacy api-key path, still on `org_system_provider_keys`) ---

export async function createOrgModelProviderKey(
  orgId: string,
  label: string,
  api: string,
  baseUrl: string,
  apiKey: string,
  userId: string,
): Promise<string> {
  const [row] = await db
    .insert(orgSystemProviderKeys)
    .values({
      orgId,
      label,
      api,
      baseUrl,
      apiKeyEncrypted: encrypt(apiKey),
      createdBy: userId,
    })
    .returning({ id: orgSystemProviderKeys.id });
  return row!.id;
}

export async function updateOrgModelProviderKey(
  orgId: string,
  id: string,
  data: { label?: string; api?: string; baseUrl?: string; apiKey?: string },
): Promise<void> {
  const { apiKey, ...rest } = data;
  const updates = buildUpdateSet(rest);
  if (apiKey !== undefined) updates.apiKeyEncrypted = encrypt(apiKey);
  await db
    .update(orgSystemProviderKeys)
    .set(updates)
    .where(
      scopedWhere(orgSystemProviderKeys, { orgId, extra: [eq(orgSystemProviderKeys.id, id)] }),
    );
}

export async function deleteOrgModelProviderKey(orgId: string, id: string): Promise<void> {
  await db
    .delete(orgSystemProviderKeys)
    .where(
      scopedWhere(orgSystemProviderKeys, { orgId, extra: [eq(orgSystemProviderKeys.id, id)] }),
    );
}

// --- Credential loading (polymorphic across both tables) ---

/**
 * Returned shape preserved for back-compat. `providerPackageId` is populated
 * for OAuth-backed keys (legacy AFPS form OR new short-form) and `accountId`
 * for Codex.
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
  // 1) System model provider keys (env-driven, platform-wide).
  const systemKey = getSystemModelProviderKeys().get(id);
  if (systemKey) {
    return { api: systemKey.api, baseUrl: systemKey.baseUrl, apiKey: systemKey.apiKey };
  }

  // 2) New unified table (covers both api-key and OAuth credentials).
  const fromNew = await loadModelProviderCredentials(orgId, id);
  if (fromNew) {
    if (fromNew.needsReconnection) return null;
    return {
      api: fromNew.apiShape,
      baseUrl: fromNew.baseUrl,
      apiKey: fromNew.apiKey,
      providerPackageId: fromNew.providerId,
      accountId: fromNew.accountId,
    };
  }

  // 3) Legacy `org_system_provider_keys` table (api-key writes still land here).
  const [row] = await db
    .select({
      api: orgSystemProviderKeys.api,
      baseUrl: orgSystemProviderKeys.baseUrl,
      apiKeyEncrypted: orgSystemProviderKeys.apiKeyEncrypted,
      authMode: orgSystemProviderKeys.authMode,
      providerPackageId: orgSystemProviderKeys.providerPackageId,
    })
    .from(orgSystemProviderKeys)
    .where(scopedWhere(orgSystemProviderKeys, { orgId, extra: [eq(orgSystemProviderKeys.id, id)] }))
    .limit(1);
  if (!row) return null;

  // Defensive: a legacy row with `authMode='oauth'` has no longer any
  // companion `userProviderConnections` row to refresh against (Phase 4
  // moved the OAuth flow off this table). Treat as not loadable.
  if (row.authMode === "oauth" || row.apiKeyEncrypted === null) return null;
  try {
    return { api: row.api, baseUrl: row.baseUrl, apiKey: decrypt(row.apiKeyEncrypted) };
  } catch {
    return null;
  }
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

  // For OAuth-backed credentials the inference probe needs a real model id
  // (the upstream rejects `_test`). Fall back to the registry's first model
  // — sized to be a low-cost probe (single token in/out) regardless.
  let modelId = "_test";
  if (creds.providerPackageId) {
    const cfg = getModelProviderConfig(creds.providerPackageId);
    if (cfg && cfg.models.length > 0) modelId = cfg.models[0]!.id;
  }
  return testModelConfig({ ...creds, modelId });
}
