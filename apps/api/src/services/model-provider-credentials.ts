// SPDX-License-Identifier: Apache-2.0

/**
 * Unified credentials service for LLM model providers (API-key + OAuth).
 *
 * Backed by the `model_provider_credentials` table. The encrypted blob is
 * a tagged union — see {@link CredentialsBlob}. All inference-specific knobs
 * (apiShape, default base URL, force-stream/store, URL rewriting) come from
 * the platform registry keyed by `providerId`, never from the row itself.
 *
 * Deliberate non-features:
 *   - No auto-refresh on `loadModelProviderCredentials`. OAuth refresh is the
 *     concern of the dedicated worker / on-demand resolver — they call
 *     `updateOAuthCredentialTokens` and `markCredentialNeedsReconnection`
 *     when they finish refreshing or when a refresh fails terminally.
 *   - No system (env-driven) provider keys. Self-hosters override per-model
 *     defaults via `SYSTEM_PROVIDER_KEYS` in `services/model-registry`; this
 *     service is concerned only with org-owned credentials.
 */

import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { modelProviderCredentials } from "@appstrate/db/schema";
import { encryptCredentials, decryptCredentials } from "@appstrate/connect";
import { mergeSystemAndDb, scopedWhere } from "../lib/db-helpers.ts";
import { toISORequired } from "../lib/date-helpers.ts";
import {
  getModelProviderConfig,
  isModelProviderEnabled,
  listModelProviders,
} from "./oauth-model-providers/registry.ts";
import type { ModelApiShape } from "@appstrate/core/sidecar-types";
import { getSystemModelProviderKeys } from "./model-registry.ts";
import { logger } from "../lib/logger.ts";
import type { ModelProviderCredentialInfo } from "@appstrate/shared-types";

// ─── Blob shapes (encrypted at rest) ───────────────────────────────────────

export interface ApiKeyBlob {
  kind: "api_key";
  apiKey: string;
}

export interface OAuthBlob {
  kind: "oauth";
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. `null` when the upstream did not return an expiry. */
  expiresAt: number | null;
  scopesGranted: string[];
  needsReconnection: boolean;
  /** Codex only — `chatgpt-account-id` header value. */
  accountId?: string;
  /** Subscription tier from the OAuth response (Claude). */
  subscriptionType?: string;
  /** Account email — surfaced in the UI; never used in the inference path. */
  email?: string;
}

export type CredentialsBlob = ApiKeyBlob | OAuthBlob;

// ─── Internal DB-row shape (never carries plaintext) ───────────────────────
// Distinct from the public `ModelProviderCredentialInfo` (shared-types) which
// also represents env-driven system keys via `source: "built-in"`.

interface ModelProviderCredentialRow {
  id: string;
  orgId: string;
  label: string;
  providerId: string;
  /** Effective base URL after applying the override, if any. */
  baseUrl: string;
  /** "api_key" | "oauth2" — derived from the registry, not stored on the row. */
  authMode: "api_key" | "oauth2";
  /** OAuth-only: filled when the row's blob is `kind: "oauth"`. */
  oauthEmail?: string | null;
  needsReconnection?: boolean;
  oauthExpiresAt?: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Decrypted-for-inference shape ─────────────────────────────────────────

/**
 * Single decrypted credential shape exposed by `loadInferenceCredentials`
 * (the only public read path). Carries the registry overlay (apiShape,
 * baseUrl, rewriteUrlPath, forceStream/Store) inline so downstream consumers
 * (pi.ts, llm-proxy) don't have to re-look-up `getModelProviderConfig`.
 *
 * `providerId` is optional because env-driven `SYSTEM_PROVIDER_KEYS`
 * entries have no registry providerId — they are flat wire-format
 * descriptors. OAuth + DB rows always carry one.
 */
export interface DecryptedModelProviderCredentials {
  /** Canonical registry id ("anthropic", "codex", …). Absent for env-driven system keys. */
  providerId?: string;
  apiShape: ModelApiShape;
  baseUrl: string;
  /** Either the API key OR the current OAuth access token. */
  apiKey: string;
  forceStream?: boolean;
  forceStore?: false;
  rewriteUrlPath?: { from: string; to: string };
  /** Codex only. */
  accountId?: string;
  /** OAuth only — if true, the connection is dead and apiKey may be stale. */
  needsReconnection?: boolean;
  /** OAuth only — epoch ms. Refresh worker uses this to schedule renewals. */
  expiresAt?: number | null;
}

// ─── Internal helpers ──────────────────────────────────────────────────────

function effectiveBaseUrl(providerId: string, override: string | null): string | null {
  const cfg = getModelProviderConfig(providerId);
  if (!cfg) return null;
  if (override && cfg.baseUrlOverridable) return override;
  return cfg.defaultBaseUrl;
}

function decryptBlob(ciphertext: string): CredentialsBlob | null {
  try {
    return decryptCredentials<CredentialsBlob>(ciphertext);
  } catch {
    return null;
  }
}

// ─── List (org-scoped) ─────────────────────────────────────────────────────

export async function listModelProviderCredentialRows(
  orgId: string,
): Promise<ModelProviderCredentialRow[]> {
  const rows = await db
    .select()
    .from(modelProviderCredentials)
    .where(scopedWhere(modelProviderCredentials, { orgId }));

  return rows.map((r): ModelProviderCredentialRow => {
    const cfg = getModelProviderConfig(r.providerId);
    const baseUrl = effectiveBaseUrl(r.providerId, r.baseUrlOverride) ?? "";
    const blob = decryptBlob(r.credentialsEncrypted);
    const isOauth = blob?.kind === "oauth";
    return {
      id: r.id,
      orgId: r.orgId,
      label: r.label,
      providerId: r.providerId,
      baseUrl,
      authMode: cfg?.authMode ?? "api_key",
      oauthEmail: isOauth ? (blob.email ?? null) : undefined,
      needsReconnection: isOauth ? blob.needsReconnection : undefined,
      oauthExpiresAt:
        isOauth && blob.expiresAt !== null ? new Date(blob.expiresAt).toISOString() : null,
      createdBy: r.createdBy,
      createdAt: toISORequired(r.createdAt),
      updatedAt: toISORequired(r.updatedAt),
    };
  });
}

// ─── Create ────────────────────────────────────────────────────────────────

export interface CreateApiKeyCredentialInput {
  orgId: string;
  userId: string;
  label: string;
  providerId: string;
  apiKey: string;
  baseUrlOverride?: string | null;
}

export async function createApiKeyCredential(input: CreateApiKeyCredentialInput): Promise<string> {
  const cfg = getModelProviderConfig(input.providerId);
  if (!cfg) {
    throw new Error(`Unknown providerId: ${input.providerId}`);
  }
  if (cfg.authMode !== "api_key") {
    throw new Error(
      `Provider ${input.providerId} requires OAuth (authMode=${cfg.authMode}); use createOAuthCredential instead`,
    );
  }
  const baseUrlOverride =
    input.baseUrlOverride && cfg.baseUrlOverridable ? input.baseUrlOverride : null;
  const blob: ApiKeyBlob = { kind: "api_key", apiKey: input.apiKey };
  const [row] = await db
    .insert(modelProviderCredentials)
    .values({
      orgId: input.orgId,
      label: input.label,
      providerId: input.providerId,
      credentialsEncrypted: encryptCredentials(blob as unknown as Record<string, unknown>),
      baseUrlOverride,
      createdBy: input.userId,
    })
    .returning({ id: modelProviderCredentials.id });
  return row!.id;
}

export interface CreateOAuthCredentialInput {
  orgId: string;
  userId: string;
  label: string;
  providerId: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number | null;
  scopesGranted: string[];
  accountId?: string;
  subscriptionType?: string;
  email?: string;
}

export async function createOAuthCredential(input: CreateOAuthCredentialInput): Promise<string> {
  const cfg = getModelProviderConfig(input.providerId);
  if (!cfg) {
    throw new Error(`Unknown providerId: ${input.providerId}`);
  }
  if (cfg.authMode !== "oauth2") {
    throw new Error(
      `Provider ${input.providerId} is api-key only (authMode=${cfg.authMode}); use createApiKeyCredential instead`,
    );
  }
  const blob: OAuthBlob = {
    kind: "oauth",
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    expiresAt: input.expiresAt,
    scopesGranted: input.scopesGranted,
    needsReconnection: false,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.subscriptionType ? { subscriptionType: input.subscriptionType } : {}),
    ...(input.email ? { email: input.email } : {}),
  };
  const [row] = await db
    .insert(modelProviderCredentials)
    .values({
      orgId: input.orgId,
      label: input.label,
      providerId: input.providerId,
      credentialsEncrypted: encryptCredentials(blob as unknown as Record<string, unknown>),
      // Mirror `blob.expiresAt` onto the dedicated column so the refresh
      // worker scan can filter at SQL level. Blob remains source of truth.
      expiresAt: input.expiresAt !== null ? new Date(input.expiresAt) : null,
      createdBy: input.userId,
    })
    .returning({ id: modelProviderCredentials.id });
  return row!.id;
}

// ─── Update ────────────────────────────────────────────────────────────────

export interface UpdateModelProviderCredentialPatch {
  label?: string;
  baseUrlOverride?: string | null;
  /** Rotate an api_key credential. Rejected on OAuth rows — refresh path uses {@link updateOAuthCredentialTokens}. */
  apiKey?: string;
}

export async function updateModelProviderCredential(
  orgId: string,
  id: string,
  patch: UpdateModelProviderCredentialPatch,
): Promise<void> {
  const updates: Record<string, unknown> = {};
  if (patch.label !== undefined) updates.label = patch.label;
  if (patch.baseUrlOverride !== undefined) updates.baseUrlOverride = patch.baseUrlOverride;

  if (patch.apiKey !== undefined) {
    // Rotate the api key — load the row to verify it's an api_key blob, then re-encrypt.
    const [row] = await db
      .select({
        providerId: modelProviderCredentials.providerId,
        credentialsEncrypted: modelProviderCredentials.credentialsEncrypted,
      })
      .from(modelProviderCredentials)
      .where(
        scopedWhere(modelProviderCredentials, {
          orgId,
          extra: [eq(modelProviderCredentials.id, id)],
        }),
      )
      .limit(1);
    if (!row) return;
    const existing = decryptBlob(row.credentialsEncrypted);
    if (existing?.kind !== "api_key") {
      throw new Error(
        `Cannot rotate apiKey on credential ${id}: stored blob is ${existing?.kind ?? "unreadable"}`,
      );
    }
    const next: ApiKeyBlob = { kind: "api_key", apiKey: patch.apiKey };
    updates.credentialsEncrypted = encryptCredentials(next as unknown as Record<string, unknown>);
  }

  if (Object.keys(updates).length === 0) return;
  updates.updatedAt = new Date();

  await db
    .update(modelProviderCredentials)
    .set(updates)
    .where(
      scopedWhere(modelProviderCredentials, {
        orgId,
        extra: [eq(modelProviderCredentials.id, id)],
      }),
    );
}

/**
 * Persist refreshed OAuth tokens. Called by the refresh worker / on-demand
 * resolver after a successful upstream refresh. Preserves blob fields the
 * upstream didn't return (e.g. `email`, `subscriptionType`, `accountId` when
 * not rotated).
 */
export interface UpdateOAuthCredentialTokensInput {
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
  /** Codex only — Codex re-issues this on every token; pass through. */
  accountId?: string;
}

export async function updateOAuthCredentialTokens(
  orgId: string,
  id: string,
  fresh: UpdateOAuthCredentialTokensInput,
): Promise<void> {
  const [row] = await db
    .select({ credentialsEncrypted: modelProviderCredentials.credentialsEncrypted })
    .from(modelProviderCredentials)
    .where(
      scopedWhere(modelProviderCredentials, {
        orgId,
        extra: [eq(modelProviderCredentials.id, id)],
      }),
    )
    .limit(1);
  if (!row) return;
  const existing = decryptBlob(row.credentialsEncrypted);
  if (existing?.kind !== "oauth") return;

  const next: OAuthBlob = {
    ...existing,
    accessToken: fresh.accessToken,
    refreshToken: fresh.refreshToken,
    expiresAt: fresh.expiresAt,
    needsReconnection: false,
    ...(fresh.accountId ? { accountId: fresh.accountId } : {}),
  };

  await db
    .update(modelProviderCredentials)
    .set({
      credentialsEncrypted: encryptCredentials(next as unknown as Record<string, unknown>),
      // Keep the denormalized cache in lockstep with the blob — the refresh
      // worker scan filters on this column to skip the per-row decrypt.
      expiresAt: fresh.expiresAt !== null ? new Date(fresh.expiresAt) : null,
      updatedAt: new Date(),
    })
    .where(
      scopedWhere(modelProviderCredentials, {
        orgId,
        extra: [eq(modelProviderCredentials.id, id)],
      }),
    );
}

export async function markCredentialNeedsReconnection(orgId: string, id: string): Promise<void> {
  const [row] = await db
    .select({ credentialsEncrypted: modelProviderCredentials.credentialsEncrypted })
    .from(modelProviderCredentials)
    .where(
      scopedWhere(modelProviderCredentials, {
        orgId,
        extra: [eq(modelProviderCredentials.id, id)],
      }),
    )
    .limit(1);
  if (!row) return;
  const existing = decryptBlob(row.credentialsEncrypted);
  if (existing?.kind !== "oauth") return;

  const next: OAuthBlob = { ...existing, needsReconnection: true };
  await db
    .update(modelProviderCredentials)
    .set({
      credentialsEncrypted: encryptCredentials(next as unknown as Record<string, unknown>),
      updatedAt: new Date(),
    })
    .where(
      scopedWhere(modelProviderCredentials, {
        orgId,
        extra: [eq(modelProviderCredentials.id, id)],
      }),
    );
}

// ─── Delete ────────────────────────────────────────────────────────────────

export async function deleteModelProviderCredential(orgId: string, id: string): Promise<void> {
  await db.delete(modelProviderCredentials).where(
    scopedWhere(modelProviderCredentials, {
      orgId,
      extra: [eq(modelProviderCredentials.id, id)],
    }),
  );
}

// ─── Load (decrypt + apply registry overlay) ───────────────────────────────

/**
 * Internal: decrypt + overlay the registry config for one DB row. Public
 * callers MUST use {@link loadInferenceCredentials} so the env-system-key
 * fallback and `needsReconnection` gate are honored — those two callers
 * differ only by what they wrap around this single read path.
 */
async function loadDbCredential(
  orgId: string,
  id: string,
): Promise<DecryptedModelProviderCredentials | null> {
  const [row] = await db
    .select()
    .from(modelProviderCredentials)
    .where(
      scopedWhere(modelProviderCredentials, {
        orgId,
        extra: [eq(modelProviderCredentials.id, id)],
      }),
    )
    .limit(1);
  if (!row) return null;

  const cfg = getModelProviderConfig(row.providerId);
  if (!cfg) {
    logger.warn("model-provider-credentials: unknown providerId in DB row", {
      credentialId: id,
      providerId: row.providerId,
    });
    return null;
  }
  const baseUrl = effectiveBaseUrl(row.providerId, row.baseUrlOverride);
  if (!baseUrl) return null;

  const blob = decryptBlob(row.credentialsEncrypted);
  if (!blob) return null;

  const common = {
    providerId: row.providerId,
    apiShape: cfg.apiShape,
    baseUrl,
    forceStream: cfg.forceStream,
    forceStore: cfg.forceStore,
    rewriteUrlPath: cfg.rewriteUrlPath,
  };

  if (blob.kind === "api_key") {
    return { ...common, apiKey: blob.apiKey };
  }

  return {
    ...common,
    apiKey: blob.accessToken,
    accountId: blob.accountId,
    needsReconnection: blob.needsReconnection,
    expiresAt: blob.expiresAt,
  };
}

// ─── Aggregated UI surface (system env-driven + DB) ────────────────────────

/**
 * Resolve `(apiShape, baseUrl)` to a registry providerId. Matches an `api_key`
 * provider whose `apiShape` and `defaultBaseUrl` align; falls back to
 * `openai-compatible` with a `baseUrlOverride` for any unrecognized combo.
 *
 * Kept exported because the POST route still accepts the historic
 * `(apiShape, baseUrl, apiKey)` form and reverse-resolves it to a canonical
 * providerId before creating the credential.
 */
export function resolveProviderIdFromApiKeyForm(
  apiShape: string,
  baseUrl: string,
): { providerId: string; baseUrlOverride: string | null } {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  // Unfiltered: existing credentials for disabled providers must keep working.
  // The POST route enforces `isModelProviderEnabled` BEFORE calling this
  // helper, so disabled providers never reach create. Resolution itself stays
  // total over the registry so update/delete paths on existing rows keep
  // matching their canonical providerId.
  for (const cfg of listModelProviders()) {
    if (cfg.authMode !== "api_key") continue;
    if (cfg.providerId === "openai-compatible") continue; // explicit fallback below
    if (cfg.apiShape === apiShape && cfg.defaultBaseUrl.replace(/\/+$/, "") === normalizedBaseUrl) {
      return { providerId: cfg.providerId, baseUrlOverride: null };
    }
  }
  return { providerId: "openai-compatible", baseUrlOverride: baseUrl };
}

/**
 * List the aggregated UI view of an organization's model provider credentials.
 *
 * Combines two sources:
 *   1. `SYSTEM_PROVIDER_KEYS` env-driven keys (built-in, immutable, env-controlled)
 *   2. The unified `model_provider_credentials` table (custom, OAuth + api-key)
 *
 * Returns the public `ModelProviderCredentialInfo` shape (shared-types) —
 * never carries plaintext. `apiShape` is derived from the registry for DB
 * rows and from the system definition for env-driven keys.
 */
export async function listOrgModelProviderCredentials(
  orgId: string,
): Promise<ModelProviderCredentialInfo[]> {
  const system = getSystemModelProviderKeys();
  const now = toISORequired(new Date());
  const rows = await listModelProviderCredentialRows(orgId);

  return mergeSystemAndDb({
    system,
    rows,
    mapSystem: (id, def): ModelProviderCredentialInfo => ({
      id,
      label: def.label,
      apiShape: def.apiShape,
      baseUrl: def.baseUrl,
      source: "built-in",
      authMode: "api_key",
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    }),
    mapRow: (row): ModelProviderCredentialInfo => {
      const cfg = getModelProviderConfig(row.providerId);
      return {
        id: row.id,
        label: row.label,
        apiShape: cfg?.apiShape ?? "openai-chat",
        baseUrl: row.baseUrl,
        source: "custom",
        authMode: row.authMode,
        providerId: row.providerId,
        oauthEmail: row.oauthEmail ?? null,
        oauthExpiresAt: row.oauthExpiresAt ?? null,
        needsReconnection: row.needsReconnection ?? false,
        providerDisabled: !isModelProviderEnabled(row.providerId),
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    },
  });
}

/**
 * Resolve a credential id to plaintext credentials usable for inference
 * (model probe, LLM proxy, sidecar config). Combines the two read paths
 * into one — system (env-driven) keys from `SYSTEM_PROVIDER_KEYS` and
 * DB-stored credentials (api-key or OAuth, decrypted on demand) — and
 * gates dead OAuth rows (`needsReconnection`).
 *
 * The returned shape carries the registry overlay (rewriteUrlPath,
 * forceStream/Store) inline so downstream consumers (pi.ts, llm-proxy)
 * don't have to re-look-up `getModelProviderConfig(providerId)`.
 *
 * Returns `null` when the id is unknown to either source, or when the
 * OAuth credential is dead and the caller must treat it as missing.
 */
export async function loadInferenceCredentials(
  orgId: string,
  id: string,
): Promise<DecryptedModelProviderCredentials | null> {
  // 1) System (env-driven) keys — no registry providerId, just wire format.
  const systemKey = getSystemModelProviderKeys().get(id);
  if (systemKey) {
    return {
      apiShape: systemKey.apiShape as ModelApiShape,
      baseUrl: systemKey.baseUrl,
      apiKey: systemKey.apiKey,
    };
  }

  // 2) Unified credentials table (api-key + OAuth).
  const creds = await loadDbCredential(orgId, id);
  if (!creds) return null;
  if (creds.needsReconnection) return null;
  return creds;
}
