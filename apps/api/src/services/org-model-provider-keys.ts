// SPDX-License-Identifier: Apache-2.0

import { eq, inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { orgSystemProviderKeys, userProviderConnections } from "@appstrate/db/schema";
import { encrypt, decrypt, decryptCredentials } from "@appstrate/connect";
import { getSystemModelProviderKeys } from "./model-registry.ts";
import type { OrgModelProviderKeyInfo, TestResult } from "@appstrate/shared-types";
import { testModelConfig } from "./org-models.ts";
import { mergeSystemAndDb, buildUpdateSet, scopedWhere } from "../lib/db-helpers.ts";
import { toISO, toISORequired } from "../lib/date-helpers.ts";
import type { OAuthModelProviderCredentials } from "./oauth-model-providers/credentials.ts";
import { resolveOAuthTokenForSidecar } from "./oauth-model-providers/token-resolver.ts";
import { getOAuthModelProviderConfig } from "./oauth-model-providers/registry.ts";
import { logger } from "../lib/logger.ts";

// --- List (system + DB) ---

export async function listOrgModelProviderKeys(orgId: string): Promise<OrgModelProviderKeyInfo[]> {
  const system = getSystemModelProviderKeys();
  const rows = await db
    .select()
    .from(orgSystemProviderKeys)
    .where(scopedWhere(orgSystemProviderKeys, { orgId }));
  const now = toISORequired(new Date());

  // Batch-load OAuth connection state (email, needsReconnection) for the rows
  // bound to OAuth connections — single query, in-memory join below.
  const oauthIds = rows
    .filter((r) => r.authMode === "oauth" && r.oauthConnectionId)
    .map((r) => r.oauthConnectionId!);
  const oauthState = new Map<string, { email: string | null; needsReconnection: boolean }>();
  if (oauthIds.length > 0) {
    const conns = await db
      .select({
        id: userProviderConnections.id,
        credentialsEncrypted: userProviderConnections.credentialsEncrypted,
        needsReconnection: userProviderConnections.needsReconnection,
      })
      .from(userProviderConnections)
      .where(inArray(userProviderConnections.id, oauthIds));
    for (const c of conns) {
      let email: string | null = null;
      try {
        const creds = decryptCredentials<OAuthModelProviderCredentials>(c.credentialsEncrypted);
        email = creds.email ?? null;
      } catch {
        // Stale ciphertext after key rotation — surface as "no email" rather than failing the whole list.
      }
      oauthState.set(c.id, { email, needsReconnection: c.needsReconnection });
    }
  }

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
    mapRow: (r): OrgModelProviderKeyInfo => {
      const isOauth = r.authMode === "oauth";
      const state = isOauth && r.oauthConnectionId ? oauthState.get(r.oauthConnectionId) : null;
      return {
        id: r.id,
        label: r.label,
        api: r.api,
        baseUrl: r.baseUrl,
        source: "custom",
        authMode: r.authMode,
        providerPackageId: r.providerPackageId ?? null,
        oauthConnectionId: r.oauthConnectionId ?? null,
        oauthEmail: state?.email ?? null,
        needsReconnection: state?.needsReconnection ?? false,
        createdBy: r.createdBy,
        createdAt: toISO(r.createdAt) ?? now,
        updatedAt: toISO(r.updatedAt) ?? now,
      };
    },
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

// --- Credential loading ---

/**
 * `providerPackageId` is populated for OAuth-backed keys (and only for those).
 * Downstream consumers branch on it to apply provider-specific request shapes
 * — e.g. Codex tokens need `chatgpt-account-id` headers and a special probe,
 * Claude Code tokens need `anthropic-beta: oauth-2025-04-20`. API-key rows
 * leave it undefined.
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
  // Check system model provider keys first (same pattern as loadModel checks system models)
  const systemKey = getSystemModelProviderKeys().get(id);
  if (systemKey) {
    return { api: systemKey.api, baseUrl: systemKey.baseUrl, apiKey: systemKey.apiKey };
  }

  const [row] = await db
    .select({
      api: orgSystemProviderKeys.api,
      baseUrl: orgSystemProviderKeys.baseUrl,
      apiKeyEncrypted: orgSystemProviderKeys.apiKeyEncrypted,
      authMode: orgSystemProviderKeys.authMode,
      oauthConnectionId: orgSystemProviderKeys.oauthConnectionId,
      providerPackageId: orgSystemProviderKeys.providerPackageId,
    })
    .from(orgSystemProviderKeys)
    .where(scopedWhere(orgSystemProviderKeys, { orgId, extra: [eq(orgSystemProviderKeys.id, id)] }))
    .limit(1);
  if (!row) return null;

  // OAuth path: resolve a fresh access token via the resolver (auto-refreshes
  // when expired). Throws `gone(needsReconnection)` when the connection is
  // dead — surface that as `null` so callers fall through to their own
  // "key not found / unusable" handling.
  if (row.authMode === "oauth" && row.oauthConnectionId) {
    try {
      const token = await resolveOAuthTokenForSidecar(row.oauthConnectionId);
      return {
        api: row.api,
        baseUrl: row.baseUrl,
        apiKey: token.accessToken,
        providerPackageId: row.providerPackageId ?? undefined,
        accountId: token.accountId,
      };
    } catch (err) {
      logger.warn("OAuth model provider token resolution failed", {
        keyId: id,
        connectionId: row.oauthConnectionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  if (row.apiKeyEncrypted === null) return null;
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

  // For OAuth keys the inference probe needs a real model id (the upstream
  // rejects `_test`). Fall back to the registry's first model — sized to be
  // a low-cost probe (single token in/out) regardless of which one we pick.
  let modelId = "_test";
  if (creds.providerPackageId) {
    const cfg = getOAuthModelProviderConfig(creds.providerPackageId);
    if (cfg && cfg.models.length > 0) modelId = cfg.models[0]!.id;
  }
  return testModelConfig({ ...creds, modelId });
}
