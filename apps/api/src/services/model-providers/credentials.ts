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

import { eq, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { modelProviderCredentials } from "@appstrate/db/schema";
import { encryptCredentials, decryptCredentials } from "@appstrate/connect";
import { mergeSystemAndDb, scopedWhere } from "../../lib/db-helpers.ts";
import { toISORequired } from "../../lib/date-helpers.ts";
import { getModelProvider } from "./registry.ts";
import type { ModelApiShape, OAuthTokenResponse } from "@appstrate/core/sidecar-types";
import type { ModelProviderIdentity } from "@appstrate/core/module";
import { dedupeLabel } from "@appstrate/core/dedupe-label";
import { getSystemModelProviderCredentials, getSystemModels } from "../model-registry.ts";
import { logger } from "../../lib/logger.ts";
import type { ModelProviderCredentialInfo } from "@appstrate/shared-types";
import { clearResolvedModelCache } from "../resolved-model-cache.ts";

// ─── Blob shapes (encrypted at rest) ───────────────────────────────────────

export interface ApiKeyBlob {
  kind: "api_key";
  apiKey: string;
}

/**
 * OAuth credential as stored at rest. Structurally a superset of
 * {@link OAuthTokenResponse} (the wire shape consumed by the sidecar) plus
 * the fields the platform keeps private: the rotating `refreshToken`, the
 * `needsReconnection` death flag, and the surface-only `email`. Keeping the
 * relationship explicit (intersection, not parallel declaration) means a
 * field added to the wire contract is automatically required here.
 */
export type OAuthBlob = OAuthTokenResponse & {
  kind: "oauth";
  refreshToken: string;
  needsReconnection: boolean;
  /** Account email — surfaced in the UI; never used in the inference path. */
  email?: string;
};

export type CredentialsBlob = ApiKeyBlob | OAuthBlob;

// ─── Decrypted-for-inference shape ─────────────────────────────────────────

/**
 * Single decrypted credential shape exposed by `loadInferenceCredentials`
 * (the only public read path). Carries the registry-derived `apiShape` and
 * `baseUrl` inline so downstream consumers don't have to re-look-up
 * `getModelProvider`.
 */
export interface DecryptedModelProviderCredentials {
  /** Canonical registry id ("anthropic", "openai", …). */
  providerId: string;
  apiShape: ModelApiShape;
  baseUrl: string;
  /** Either the API key OR the current OAuth access token. */
  apiKey: string;
  /**
   * OAuth only — abstract account/tenant identifier (used at connect time for
   * required-claim validation). The platform does NOT forward this generic
   * `accountId` as an upstream request header. (The codex vend path is a
   * distinct, provider-specific mechanism: sidecar-side it writes the real
   * `chatgpt_account_id` into the CLI's local auth state, used by the official
   * binary — not an HTTP header set by the platform.)
   */
  accountId?: string;
  /** OAuth only — if true, the connection is dead and apiKey may be stale. */
  needsReconnection?: boolean;
  /** OAuth only — epoch ms. Refresh worker uses this to schedule renewals. */
  expiresAt?: number | null;
}

// ─── Internal helpers ──────────────────────────────────────────────────────

/**
 * Project an OAuth credential source into the wire shape consumed by the
 * sidecar. The conditional `accountId` spread is the actual contract — when
 * the provider didn't surface one, the field is omitted entirely (rather
 * than serialized as `null`).
 */
export function pickOAuthTokenResponse(source: {
  accessToken: string;
  expiresAt: number | null;
  accountId?: string;
}): OAuthTokenResponse {
  const { accessToken, expiresAt, accountId } = source;
  return accountId !== undefined
    ? { accessToken, expiresAt, accountId }
    : { accessToken, expiresAt };
}

/**
 * Return the subset of provider-declared required identity claims that
 * aren't populated. Used both by the import gate (throws when non-empty)
 * and by the runtime warn paths (logs when non-empty). Centralizing this
 * means adding a new claim (e.g. `email`) to a provider's required list
 * picks up at every site automatically.
 */
export function findMissingIdentityClaims(
  required: readonly (keyof ModelProviderIdentity)[] | undefined,
  identity: ModelProviderIdentity,
): (keyof ModelProviderIdentity)[] {
  return (required ?? []).filter((k) => !identity[k]);
}

function effectiveBaseUrl(providerId: string, override: string | null): string | null {
  const cfg = getModelProvider(providerId);
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

/**
 * Shared "raw load" used by both `loadDbCredential` (inference read path)
 * and the OAuth token resolver. Returns the decrypted blob + the registry
 * overlay + the row id/orgId, or `null` when the row is missing, the
 * provider is unknown, or decryption fails. Caller maps `null` to its
 * preferred error mode (notFound() vs silent fallback).
 *
 * `expectedOrgId` is enforced when provided — used as defense-in-depth by
 * the sidecar token-resolver path (run pinned to a specific org).
 */
export interface RawCredentialLoad {
  id: string;
  orgId: string;
  providerId: string;
  baseUrlOverride: string | null;
  blob: CredentialsBlob;
  config: ReturnType<typeof getModelProvider>;
}

export async function loadCredentialRow(
  id: string,
  expectedOrgId?: string,
): Promise<RawCredentialLoad | null> {
  const [row] = await db
    .select({
      id: modelProviderCredentials.id,
      orgId: modelProviderCredentials.orgId,
      providerId: modelProviderCredentials.providerId,
      baseUrlOverride: modelProviderCredentials.baseUrlOverride,
      credentialsEncrypted: modelProviderCredentials.credentialsEncrypted,
    })
    .from(modelProviderCredentials)
    .where(eq(modelProviderCredentials.id, id))
    .limit(1);
  if (!row) return null;
  if (expectedOrgId !== undefined && row.orgId !== expectedOrgId) return null;
  const config = getModelProvider(row.providerId);
  if (!config) {
    logger.warn("model-provider-credentials: unknown providerId in DB row", {
      credentialId: id,
      providerId: row.providerId,
    });
    return null;
  }
  const blob = decryptBlob(row.credentialsEncrypted);
  if (!blob) return null;
  return {
    id: row.id,
    orgId: row.orgId,
    providerId: row.providerId,
    baseUrlOverride: row.baseUrlOverride,
    blob,
    config,
  };
}

/**
 * Registry-derived credential metadata WITHOUT decrypting the secret blob.
 * `providerId` is a plaintext column; `apiShape`/`baseUrl` come from the
 * provider registry. Used by metadata-only listings (e.g. the chat model
 * picker) that need to resolve the protocol family + base URL but never the
 * key itself — the real secret is decrypted later, at inference time.
 */
export interface CredentialMetadata {
  providerId: string;
  apiShape: ModelApiShape;
  baseUrl: string;
}

export async function loadCredentialMetadata(
  id: string,
  orgId: string,
): Promise<CredentialMetadata | null> {
  const [row] = await db
    .select({
      orgId: modelProviderCredentials.orgId,
      providerId: modelProviderCredentials.providerId,
      baseUrlOverride: modelProviderCredentials.baseUrlOverride,
    })
    .from(modelProviderCredentials)
    .where(eq(modelProviderCredentials.id, id))
    .limit(1);
  if (!row || row.orgId !== orgId) return null;
  const cfg = getModelProvider(row.providerId);
  if (!cfg) return null;
  const baseUrl =
    row.baseUrlOverride && cfg.baseUrlOverridable ? row.baseUrlOverride : cfg.defaultBaseUrl;
  return { providerId: row.providerId, apiShape: cfg.apiShape, baseUrl };
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
  const cfg = getModelProvider(input.providerId);
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
  /** Epoch ms. `null` / unset = unknown expiry (sidecar treats as "always refresh"). */
  expiresAt?: number | null;
  accountId?: string;
  email?: string;
}

export async function createOAuthCredential(input: CreateOAuthCredentialInput): Promise<string> {
  const cfg = getModelProvider(input.providerId);
  if (!cfg) {
    throw new Error(`Unknown providerId: ${input.providerId}`);
  }
  if (cfg.authMode !== "oauth2") {
    throw new Error(
      `Provider ${input.providerId} is api-key only (authMode=${cfg.authMode}); use createApiKeyCredential instead`,
    );
  }
  const expiresAt = input.expiresAt ?? null;
  const blob: OAuthBlob = {
    kind: "oauth",
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    expiresAt,
    needsReconnection: false,
    ...(input.accountId ? { accountId: input.accountId } : {}),
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
      expiresAt: expiresAt !== null ? new Date(expiresAt) : null,
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
  // Models backed by this credential may have a cached resolution carrying the
  // old key/baseUrl — drop it so the rotation takes effect immediately.
  clearResolvedModelCache();
}

// ─── Label derivation ──────────────────────────────────────────────────────

/**
 * Make `base` unique within an org's credential labels by appending ` (2)`,
 * ` (3)`, … on collision (same suffix scheme as org models). Always run a
 * label through this before persisting — including caller-supplied ones —
 * so two connections to the same provider never share a name. The
 * `connect-helper` CLI sends a default label (`ChatGPT`, `Claude`) on every
 * redeem, so deriving only when the label is absent would never dedupe.
 */
export async function dedupeCredentialLabel(orgId: string, base: string): Promise<string> {
  const rows = await db
    .select({ label: modelProviderCredentials.label })
    .from(modelProviderCredentials)
    .where(scopedWhere(modelProviderCredentials, { orgId }));
  return dedupeLabel(
    base,
    rows.map((r) => r.label),
  );
}

/**
 * Persist refreshed OAuth tokens. Called by the refresh worker / on-demand
 * resolver after a successful upstream refresh. Preserves blob fields the
 * upstream didn't return (e.g. `email`, `accountId` when not rotated).
 */
export interface UpdateOAuthCredentialTokensInput {
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
  /** Optional — set when the provider re-issues an `accountId` on every refresh; pass through. */
  accountId?: string;
}

/**
 * Shared OAuth-blob read-modify-write: select → decrypt → kind-gate → apply
 * `mutate` → re-encrypt → update (org-scoped). `mutate` returns the next blob.
 * A missing row or non-`oauth` kind is a no-op (handled by the pre-guards
 * here, before `mutate` runs). The denormalized `expiresAt` column is mirrored
 * ONLY when the next blob's `expiresAt` differs from the existing one — so
 * callers that don't touch expiry (e.g. {@link markCredentialNeedsReconnection})
 * leave the column untouched. `extraColumns` lets a caller piggyback plain
 * column writes (e.g. the refresh-failure streak reset) onto the same UPDATE.
 */
async function updateOAuthBlob(
  orgId: string,
  id: string,
  mutate: (existing: OAuthBlob) => OAuthBlob,
  extraColumns?: Partial<typeof modelProviderCredentials.$inferInsert>,
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

  const next = mutate(existing);
  const set: Record<string, unknown> = {
    ...extraColumns,
    credentialsEncrypted: encryptCredentials(next as unknown as Record<string, unknown>),
    updatedAt: new Date(),
  };
  // Keep the denormalized cache in lockstep with the blob — the refresh worker
  // scan filters on this column to skip the per-row decrypt. Only write it when
  // the mutation actually changed the expiry.
  if (next.expiresAt !== existing.expiresAt) {
    set.expiresAt = next.expiresAt !== null ? new Date(next.expiresAt) : null;
  }

  await db
    .update(modelProviderCredentials)
    .set(set)
    .where(
      scopedWhere(modelProviderCredentials, {
        orgId,
        extra: [eq(modelProviderCredentials.id, id)],
      }),
    );
  // Chokepoint for every OAuth blob write (token refresh + needsReconnection):
  // bust the resolved-model cache so a rotated token or a freshly-dead credential
  // stops being served immediately, not after the TTL.
  clearResolvedModelCache();
}

export async function updateOAuthCredentialTokens(
  orgId: string,
  id: string,
  fresh: UpdateOAuthCredentialTokensInput,
): Promise<void> {
  await updateOAuthBlob(
    orgId,
    id,
    (existing) => ({
      ...existing,
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken,
      expiresAt: fresh.expiresAt,
      needsReconnection: false,
      ...(fresh.accountId ? { accountId: fresh.accountId } : {}),
    }),
    // Any successful token write clears the transient-refresh streak — a
    // working refresh proves the credential is healthy again, so the
    // escalation counter must not carry over. See
    // `recordModelCredentialRefreshFailure`.
    { refreshFailureCount: 0, lastRefreshFailureAt: null },
  );
}

export async function markCredentialNeedsReconnection(orgId: string, id: string): Promise<void> {
  await updateOAuthBlob(orgId, id, (existing) => ({ ...existing, needsReconnection: true }));
}

/**
 * Record a *transient* token-refresh failure (network / 5xx / parse — NOT
 * `invalid_grant`, which flips `blob.needsReconnection` immediately via
 * {@link markCredentialNeedsReconnection}). Mirrors
 * `recordIntegrationRefreshFailure` for `integration_connections`.
 *
 * The counter increment is atomic (single SQL statement), so concurrent
 * refreshes on the same row cannot lose a count. Unlike the integrations
 * variant, the death flag lives inside the *encrypted blob* — it cannot be
 * OR-flipped in the same statement. The escalation decision is therefore made
 * on the RETURNING values and applied via {@link markCredentialNeedsReconnection},
 * which is monotonic (only ever sets `true`), so the two-step write is
 * race-safe: a concurrent flip is never cleared, and a duplicate flip is a
 * no-op.
 *
 * Escalation gate — `needsReconnection` is set to `true` only when BOTH:
 *   1. this failure brings the streak to `>= maxFailures`, AND
 *   2. the token is genuinely dead: the denormalized `expires_at` column is
 *      set AND already older than `graceSeconds` ago.
 *
 * The expiry gate is what makes this safe: a transient upstream outage while
 * the cached token is still valid (future `expires_at`) increments the counter
 * but never escalates — the credential keeps working and a later refresh
 * recovers (clearing the streak via {@link updateOAuthCredentialTokens}). Only
 * a token that is expired-past-grace AND repeatedly unrefreshable — the
 * silent-death case — gets flipped.
 */
export async function recordModelCredentialRefreshFailure(
  orgId: string,
  id: string,
  maxFailures: number,
  graceSeconds: number,
): Promise<void> {
  const updated = await db
    .update(modelProviderCredentials)
    .set({
      refreshFailureCount: sql`${modelProviderCredentials.refreshFailureCount} + 1`,
      lastRefreshFailureAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      scopedWhere(modelProviderCredentials, {
        orgId,
        extra: [eq(modelProviderCredentials.id, id)],
      }),
    )
    .returning({
      refreshFailureCount: modelProviderCredentials.refreshFailureCount,
      expiresAt: modelProviderCredentials.expiresAt,
    });
  const row = updated[0];
  if (!row) return;
  const expiredPastGrace =
    row.expiresAt !== null && row.expiresAt.getTime() < Date.now() - graceSeconds * 1000;
  if (row.refreshFailureCount >= maxFailures && expiredPastGrace) {
    logger.warn("oauth model provider: escalating to needsReconnection after repeated failures", {
      credentialId: id,
      refreshFailureCount: row.refreshFailureCount,
      expiresAt: row.expiresAt?.toISOString() ?? null,
    });
    await markCredentialNeedsReconnection(orgId, id);
  }
}

// ─── Delete ────────────────────────────────────────────────────────────────

export async function deleteModelProviderCredential(orgId: string, id: string): Promise<void> {
  await db.delete(modelProviderCredentials).where(
    scopedWhere(modelProviderCredentials, {
      orgId,
      extra: [eq(modelProviderCredentials.id, id)],
    }),
  );
  // Any model backed by the deleted credential is now unresolvable — drop cached
  // resolutions so they don't serve a stale (now-deleted) secret.
  clearResolvedModelCache();
}

// ─── Aggregated UI surface (system env-driven + DB) ────────────────────────

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
  const system = getSystemModelProviderCredentials();
  const now = toISORequired(new Date());
  const rows = await db
    .select()
    .from(modelProviderCredentials)
    .where(scopedWhere(modelProviderCredentials, { orgId }));

  // Built-in credentials whose EVERY backing model is an alias (issue #727):
  // hide the binding (apiShape + baseUrl) so the endpoint host doesn't reveal
  // the hidden provider to an org admin who can read credentials but never
  // configured the env key. Mirrors `projectAliasedModel` for the model list.
  // Only built-in: a custom credential's binding was set by the org admin
  // themselves, so there is nothing to hide from them. A built-in key backing
  // any non-aliased model keeps its binding (that model exposes it anyway).
  const aliasOnlySystemCredentials = new Set<string>();
  {
    const byCredential = new Map<string, { total: number; aliased: number }>();
    for (const m of getSystemModels().values()) {
      const acc = byCredential.get(m.credentialId) ?? { total: 0, aliased: 0 };
      acc.total += 1;
      if (m.aliased === true) acc.aliased += 1;
      byCredential.set(m.credentialId, acc);
    }
    for (const [credId, acc] of byCredential) {
      if (acc.total > 0 && acc.total === acc.aliased) aliasOnlySystemCredentials.add(credId);
    }
  }

  return mergeSystemAndDb({
    system,
    rows,
    mapSystem: (id, def): ModelProviderCredentialInfo => {
      const provider = getModelProvider(def.providerId);
      const aliasOnly = aliasOnlySystemCredentials.has(id);
      // Alias-only: the displayName/providerId label fallbacks NAME the hidden
      // backing ("DeepSeek") — as revealing as the nulled apiShape/baseUrl.
      // Without an explicit env label, fall back to a neutral one.
      const label = aliasOnly
        ? (def.label ?? "System models")
        : (def.label ?? provider?.displayName ?? def.providerId);
      return {
        id,
        label,
        apiShape: aliasOnly ? null : def.apiShape,
        baseUrl: aliasOnly ? null : def.baseUrl,
        source: "built-in",
        authMode: "api_key",
        created_by: null,
        createdAt: now,
        updatedAt: now,
      };
    },
    mapRow: (r): ModelProviderCredentialInfo => {
      const cfg = getModelProvider(r.providerId);
      const blob = decryptBlob(r.credentialsEncrypted);
      const isOauth = blob?.kind === "oauth";
      return {
        id: r.id,
        label: r.label,
        apiShape: cfg?.apiShape ?? "openai-completions",
        baseUrl: effectiveBaseUrl(r.providerId, r.baseUrlOverride) ?? "",
        source: "custom",
        authMode: cfg?.authMode ?? "api_key",
        providerId: r.providerId,
        oauth_email: isOauth ? (blob.email ?? null) : null,
        needs_reconnection: isOauth ? !!blob.needsReconnection : false,
        available_model_ids: r.availableModelIds ?? null,
        created_by: r.createdBy,
        createdAt: toISORequired(r.createdAt),
        updatedAt: toISORequired(r.updatedAt),
      };
    },
  });
}

/**
 * Fetch a single model-provider credential by id, projected through the exact
 * same serializer as {@link listOrgModelProviderCredentials} — i.e. the public
 * `ModelProviderCredentialInfo` shape that NEVER carries plaintext (api key /
 * OAuth token). Returns `undefined` when the id is unknown to either source.
 *
 * Used by the create/update handlers to return the full (non-secret) resource
 * instead of an id-only stub (issue #646). Re-runs the list serializer rather
 * than duplicating the system+DB merge — guarantees the returned shape matches
 * `GET`/list and can never leak secret material.
 */
export async function getOrgModelProviderCredential(
  orgId: string,
  id: string,
): Promise<ModelProviderCredentialInfo | undefined> {
  const all = await listOrgModelProviderCredentials(orgId);
  return all.find((c) => c.id === id);
}

/**
 * Resolve a credential id to plaintext credentials usable for inference
 * (model probe, LLM proxy, sidecar config). Combines the two read paths
 * into one — system (env-driven) keys from `SYSTEM_PROVIDER_KEYS` and
 * DB-stored credentials (api-key or OAuth, decrypted on demand) — and
 * gates dead OAuth rows (`needsReconnection`).
 *
 * The returned shape carries the registry overlay (apiShape, baseUrl)
 * inline so downstream consumers (pi.ts, llm-proxy) don't
 * have to re-look-up `getModelProvider(providerId)`.
 *
 * Returns `null` when the id is unknown to either source, or when the
 * OAuth credential is dead and the caller must treat it as missing.
 */
export async function loadInferenceCredentials(
  orgId: string,
  id: string,
): Promise<DecryptedModelProviderCredentials | null> {
  // 1) System (env-driven) keys — providerId is declared on the env
  // entry so downstream code (refresh worker, hooks) resolves the same
  // registered ModelProviderDefinition it would for a DB-stored
  // credential.
  const systemKey = getSystemModelProviderCredentials().get(id);
  if (systemKey) {
    return {
      providerId: systemKey.providerId,
      apiShape: systemKey.apiShape as ModelApiShape,
      baseUrl: systemKey.baseUrl,
      apiKey: systemKey.apiKey,
    };
  }

  // 2) Unified credentials table (api-key + OAuth). Inlined — the previous
  // `loadDbCredential` helper had only this one caller and added no
  // value beyond the registry-overlay projection.
  const loaded = await loadCredentialRow(id, orgId);
  if (!loaded || !loaded.config) return null;
  const baseUrl = effectiveBaseUrl(loaded.providerId, loaded.baseUrlOverride);
  if (!baseUrl) return null;
  if (loaded.blob.kind === "oauth" && loaded.blob.needsReconnection) return null;

  const common = {
    providerId: loaded.providerId,
    apiShape: loaded.config.apiShape,
    baseUrl,
  };
  if (loaded.blob.kind === "api_key") {
    return { ...common, apiKey: loaded.blob.apiKey };
  }
  return {
    ...common,
    apiKey: loaded.blob.accessToken,
    accountId: loaded.blob.accountId,
    needsReconnection: loaded.blob.needsReconnection,
    expiresAt: loaded.blob.expiresAt,
  };
}
