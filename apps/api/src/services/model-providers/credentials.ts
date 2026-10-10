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

import type { Context } from "hono";
import { eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { modelProviderCredentials, user } from "@appstrate/db/schema";
import { encryptCredentials, decryptCredentials } from "@appstrate/connect";
import { mergeSystemAndDb, scopedWhere } from "../../lib/db-helpers.ts";
import { toISORequired } from "../../lib/date-helpers.ts";
import { ApiError, forbidden, notFound } from "../../lib/errors.ts";
import { getModelProvider } from "./registry.ts";
import type { ModelApiShape, OAuthTokenResponse } from "@appstrate/core/sidecar-types";
import type { ModelProviderDefinition, ModelProviderIdentity } from "@appstrate/core/module";
import { dedupeLabel } from "@appstrate/core/dedupe-label";
import { getEnv } from "@appstrate/env";
import { getSystemModelProviderCredentials, getSystemModels } from "../model-registry.ts";
import { logger } from "../../lib/logger.ts";
import {
  decryptForDisplay,
  decryptStoredCredential,
  KEY_UNAVAILABLE,
} from "../../lib/stored-credential.ts";
import type { ModelProviderCredentialInfo } from "@appstrate/shared-types";
import { clearResolvedModelCache } from "../resolved-model-cache.ts";
import { getOrgSettings } from "../organizations.ts";
import { lockOrgMember } from "../space-members.ts";
import type { AppEnv } from "../../types/index.ts";
import { requestPayerUserId } from "./credential-chain.ts";

/**
 * Who is asking about model provider credentials, and what the org grants them.
 * A personal credential (`owner_user_id` set) is visible and editable to its
 * owner only, as a user principal; `readsOrg` / `writesOrg` / `deletesOrg` widen
 * that to the whole org.
 */
export interface ModelCredentialCaller {
  orgId: string;
  /** The payer (`requestPayerUserId`): `null` for a delegate, which owns nothing. */
  userId: string | null;
  /** Holds `model-provider-credentials:read` (org-wide view). */
  readsOrg: boolean;
  /** Holds `model-provider-credentials:write` (manage org credentials). */
  writesOrg: boolean;
  /** Holds `model-provider-credentials:delete` (remove org credentials, break-glass on personal ones). */
  deletesOrg: boolean;
}

/** The model credential caller of a request: its org, its payer and its effective permissions. */
export function requestModelCredentialCaller(c: Context<AppEnv>): ModelCredentialCaller {
  const permissions = c.get("permissions") ?? new Set<string>();
  return {
    orgId: c.get("orgId"),
    userId: requestPayerUserId(c),
    readsOrg: permissions.has("model-provider-credentials:read"),
    writesOrg: permissions.has("model-provider-credentials:write"),
    deletesOrg: permissions.has("model-provider-credentials:delete"),
  };
}

// ─── Blob shapes (encrypted at rest) ───────────────────────────────────────

interface ApiKeyBlob {
  kind: "api_key";
  apiKey: string;
  /** Rejected upstream too often — {@link recordModelCredentialRejection}. */
  needsReconnection?: boolean;
}

/** Resolved OAuth access token; {@link serializeOAuthTokenResponse} maps it to the wire. */
export interface OAuthToken {
  accessToken: string;
  /** Epoch ms. `null` = unknown expiry. */
  expiresAt: number | null;
  accountId?: string;
}

/**
 * OAuth credential as stored at rest. Structurally a superset of
 * {@link OAuthToken} plus the fields the platform keeps private: the rotating
 * `refreshToken`, the `needsReconnection` death flag, and the surface-only
 * `email`. Keeping the relationship explicit (intersection, not parallel
 * declaration) means a field added to the token is automatically required here.
 */
export type OAuthBlob = OAuthToken & {
  kind: "oauth";
  refreshToken: string;
  needsReconnection: boolean;
  /** Account email — surfaced in the UI; never used in the inference path. */
  email?: string;
};

type CredentialsBlob = ApiKeyBlob | OAuthBlob;

// ─── Decrypted-for-inference shape ─────────────────────────────────────────

/**
 * Single decrypted credential shape exposed by `loadInferenceCredentials`
 * (the only public read path). Carries the registry-derived `apiShape` and
 * `baseUrl` inline so downstream consumers don't have to re-look-up
 * `getModelProvider`.
 */
interface DecryptedModelProviderCredentials {
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
 * Project an OAuth credential source onto {@link OAuthToken}. The conditional
 * `accountId` spread is the actual contract — when the provider didn't surface
 * one, the field is omitted entirely (rather than serialized as `null`).
 */
export function pickOAuthToken(source: OAuthToken): OAuthToken {
  const { accessToken, expiresAt, accountId } = source;
  return accountId !== undefined
    ? { accessToken, expiresAt, accountId }
    : { accessToken, expiresAt };
}

/** JSON boundary of `/internal/oauth-token/:id(/refresh)`. */
export function serializeOAuthTokenResponse(token: OAuthToken): OAuthTokenResponse {
  return token.accountId !== undefined
    ? { access_token: token.accessToken, expiresAt: token.expiresAt, account_id: token.accountId }
    : { access_token: token.accessToken, expiresAt: token.expiresAt };
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

/**
 * Sole owner of the base-URL-override predicate. It decides which endpoint a
 * stored API key is sent to, so it is declared once and called everywhere
 * rather than re-inlined per site. `null` = the stored override does not apply
 * (unset, or the provider forbids overriding) — the caller falls back to the
 * registry default or persists `null`.
 */
function resolveBaseUrlOverride(
  cfg: ModelProviderDefinition,
  override: string | null | undefined,
): string | null {
  return override && cfg.baseUrlOverridable ? override : null;
}

/** The endpoint a credential actually talks to: honoured override, else default. */
function effectiveBaseUrl(cfg: ModelProviderDefinition, override: string | null): string {
  return resolveBaseUrlOverride(cfg, override) ?? cfg.defaultBaseUrl;
}

/** `null` for an unreadable blob; a 503 when its key is missing from the keyring. */
function decryptBlob(ciphertext: string, credentialId: string): CredentialsBlob | null {
  return decryptStoredCredential(() => decryptCredentials<CredentialsBlob>(ciphertext), {
    credentialId,
  });
}

/** A row's identity and registry overlay, from its plaintext `provider_id`. */
interface CredentialMetadata {
  id: string;
  orgId: string;
  providerId: string;
  baseUrlOverride: string | null;
  config: ModelProviderDefinition;
  /** Registry-derived — see {@link DecryptedModelProviderCredentials}. */
  apiShape: ModelApiShape;
  /** Registry default, or the row's override when the provider allows one. */
  baseUrl: string;
}

async function selectCredential(
  id: string,
  expectedOrgId?: string,
): Promise<{ metadata: CredentialMetadata; credentialsEncrypted: string } | null> {
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
  return {
    metadata: {
      id: row.id,
      orgId: row.orgId,
      providerId: row.providerId,
      baseUrlOverride: row.baseUrlOverride,
      config,
      apiShape: config.apiShape,
      baseUrl: effectiveBaseUrl(config, row.baseUrlOverride),
    },
    credentialsEncrypted: row.credentialsEncrypted,
  };
}

/** `null` when the row is missing, another org's, or of an unknown provider. Never decrypts. */
export async function loadCredentialMetadata(
  id: string,
  expectedOrgId?: string,
): Promise<CredentialMetadata | null> {
  return (await selectCredential(id, expectedOrgId))?.metadata ?? null;
}

/** Plus the blob: `null` when unreadable, the 503 when its key is missing. */
export async function loadCredentialRow(
  id: string,
  expectedOrgId?: string,
): Promise<(CredentialMetadata & { blob: CredentialsBlob | null }) | null> {
  const loaded = await selectCredential(id, expectedOrgId);
  if (!loaded) return null;
  return { ...loaded.metadata, blob: decryptBlob(loaded.credentialsEncrypted, id) };
}

// ─── Create ────────────────────────────────────────────────────────────────

/**
 * Whether the org lets its members hold personal model credentials. Absent
 * means allowed; `false` turns every personal creation (API key or pairing) off.
 */
export async function personalModelCredentialsAllowed(orgId: string): Promise<boolean> {
  return (await getOrgSettings(orgId)).personal_model_credentials !== false;
}

export function personalModelCredentialsDisabled(): ApiError {
  return new ApiError({
    status: 403,
    code: "personal_model_credentials_disabled",
    title: "Forbidden",
    detail: "Personal model credentials are disabled for this organization",
  });
}

/** `param` names the field the custom endpoint came through. */
export function personalCredentialCustomEndpoint(
  providerId: string,
  param = "base_url_override",
): ApiError {
  return new ApiError({
    status: 400,
    code: "personal_credential_custom_endpoint",
    title: "Invalid Request",
    detail: `Provider ${providerId} with a custom endpoint is an organization credential only`,
    param,
  });
}

/** {@link personalModelCredentialsAllowed} as a refusal, for the personal-creation doors. */
export async function assertPersonalModelCredentialsAllowed(orgId: string): Promise<void> {
  if (await personalModelCredentialsAllowed(orgId)) return;
  throw personalModelCredentialsDisabled();
}

interface CreateApiKeyCredentialInput {
  orgId: string;
  userId: string;
  label: string;
  providerId: string;
  apiKey: string;
  baseUrlOverride?: string | null;
  /** The member who owns a personal credential; `null` (default) = organization credential. */
  ownerUserId?: string | null;
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
  const ownerUserId = input.ownerUserId ?? null;
  if (ownerUserId !== null) {
    await assertPersonalModelCredentialsAllowed(input.orgId);
    // A personal key cannot pick an endpoint: its traffic would leave the org's
    // own host list, and the org cannot audit a host it does not configure.
    if (cfg.baseUrlOverridable || input.baseUrlOverride) {
      throw personalCredentialCustomEndpoint(cfg.providerId);
    }
  }
  const baseUrlOverride = resolveBaseUrlOverride(cfg, input.baseUrlOverride);
  const blob: ApiKeyBlob = { kind: "api_key", apiKey: input.apiKey };
  return insertCredential({
    orgId: input.orgId,
    label: input.label,
    providerId: input.providerId,
    credentialsEncrypted: encryptCredentials(blob as unknown as Record<string, unknown>),
    baseUrlOverride,
    createdBy: input.userId,
    ownerUserId,
  });
}

/**
 * Insert a credential row. A personal one is written under its owner's membership
 * lock, the one the organization exit holds while it deletes their credentials, so
 * a credential created during the exit cannot outlive it.
 */
async function insertCredential(
  values: typeof modelProviderCredentials.$inferInsert,
): Promise<string> {
  const id = await db.transaction(async (tx) => {
    if (values.ownerUserId && !(await lockOrgMember(tx, values.orgId, values.ownerUserId))) {
      throw forbidden("Not a member of this organization");
    }
    const [row] = await tx
      .insert(modelProviderCredentials)
      .values(values)
      .returning({ id: modelProviderCredentials.id });
    return row!.id;
  });
  clearResolvedModelCache();
  return id;
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
  // The pairing redeem reaches this door without the mint route: the policy is enforced here too.
  await assertPersonalModelCredentialsAllowed(input.orgId);
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
  return insertCredential({
    orgId: input.orgId,
    label: input.label,
    providerId: input.providerId,
    credentialsEncrypted: encryptCredentials(blob as unknown as Record<string, unknown>),
    // Mirror `blob.expiresAt` onto the dedicated column so the refresh
    // worker scan can filter at SQL level. Blob remains source of truth.
    expiresAt: expiresAt !== null ? new Date(expiresAt) : null,
    createdBy: input.userId,
    // A subscription is its holder's: never an organization credential.
    ownerUserId: input.userId,
  });
}

interface ReconnectOAuthCredentialInput {
  orgId: string;
  /** The member redeeming the pairing: only the subscription's holder may reconnect it. */
  userId: string;
  id: string;
  providerId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt?: number | null;
  accountId?: string;
  email?: string;
}

/**
 * Replace an existing OAuth credential's token bundle in place. The row id,
 * label, discovered models, and every `org_models.credential_id` reference
 * stay stable. Fresh identity wins; omitted identity slots are preserved when
 * the old blob is still decryptable. A corrupt OAuth blob is recoverable by
 * design — reconnect is the user-facing repair path for that state too.
 *
 * Judged at write time, not at the pairing's mint: the row must be the redeeming
 * member's own subscription, the member still in the organization (their
 * membership lock, the one the organization exit takes) and personal credentials
 * allowed. `false` (the route's 404) otherwise.
 */
export async function reconnectOAuthCredential(
  input: ReconnectOAuthCredentialInput,
): Promise<boolean> {
  const where = scopedWhere(modelProviderCredentials, {
    orgId: input.orgId,
    extra: [
      eq(modelProviderCredentials.id, input.id),
      eq(modelProviderCredentials.providerId, input.providerId),
      eq(modelProviderCredentials.ownerUserId, input.userId),
    ],
  });
  // Read before the transaction: the settings read is not on `tx` (one connection on PGlite).
  await assertPersonalModelCredentialsAllowed(input.orgId);
  const updated = await db.transaction(async (tx) => {
    if (!(await lockOrgMember(tx, input.orgId, input.userId))) return false;
    const [row] = await tx
      .select({ credentialsEncrypted: modelProviderCredentials.credentialsEncrypted })
      .from(modelProviderCredentials)
      .where(where)
      .for("update");
    if (!row) return false;

    // Only the old identity is read: an unreadable blob, or one under a missing key, is absent.
    const existing = decryptForDisplay(
      () => decryptCredentials<CredentialsBlob>(row.credentialsEncrypted),
      { credentialId: input.id },
    );
    const existingOAuth =
      existing !== KEY_UNAVAILABLE && existing?.kind === "oauth" ? existing : null;
    const expiresAt = input.expiresAt ?? null;
    const accountId = input.accountId ?? existingOAuth?.accountId;
    const email = input.email ?? existingOAuth?.email;
    const blob: OAuthBlob = {
      kind: "oauth",
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      expiresAt,
      needsReconnection: false,
      ...(accountId ? { accountId } : {}),
      ...(email ? { email } : {}),
    };
    await tx
      .update(modelProviderCredentials)
      .set({
        credentialsEncrypted: encryptCredentials(blob as unknown as Record<string, unknown>),
        expiresAt: expiresAt !== null ? new Date(expiresAt) : null,
        refreshFailureCount: 0,
        updatedAt: new Date(),
      })
      .where(where);
    return true;
  });
  if (updated) clearResolvedModelCache();
  return updated;
}

// ─── Update ────────────────────────────────────────────────────────────────

interface UpdateModelProviderCredentialPatch {
  label?: string;
  baseUrlOverride?: string | null;
  /** Rotate an api_key credential. Rejected on OAuth rows — refresh path uses {@link updateOAuthCredentialTokens}. */
  apiKey?: string;
}

export async function updateModelProviderCredential(
  caller: ModelCredentialCaller,
  id: string,
  patch: UpdateModelProviderCredentialPatch,
): Promise<void> {
  await assertCredentialEditable(caller, id, "edit");
  const orgId = caller.orgId;
  const updates: Record<string, unknown> = {};
  if (patch.label !== undefined) updates.label = patch.label;
  if (patch.baseUrlOverride !== undefined) updates.baseUrlOverride = patch.baseUrlOverride;

  if (patch.apiKey !== undefined) {
    // Rotate the api key — load the row to verify it's an api_key credential, then re-encrypt.
    const [row] = await db
      .select({ providerId: modelProviderCredentials.providerId })
      .from(modelProviderCredentials)
      .where(
        scopedWhere(modelProviderCredentials, {
          orgId,
          extra: [eq(modelProviderCredentials.id, id)],
        }),
      )
      .limit(1);
    if (!row) return;
    // Read from the registry, not the blob: rotation must repair a blob that no longer opens.
    const authMode = getModelProvider(row.providerId)?.authMode;
    if (authMode !== "api_key") {
      throw new Error(`Cannot rotate apiKey on credential ${id}: provider auth is ${authMode}`);
    }
    const next: ApiKeyBlob = { kind: "api_key", apiKey: patch.apiKey };
    updates.credentialsEncrypted = encryptCredentials(next as unknown as Record<string, unknown>);
    updates.refreshFailureCount = 0;
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

/** A credential of the org: the provider it serves and its owner (`null` for an org credential). */
export async function loadCredentialBinding(
  orgId: string,
  credentialId: string,
): Promise<{ providerId: string; ownerUserId: string | null } | null> {
  const [row] = await db
    .select({
      providerId: modelProviderCredentials.providerId,
      ownerUserId: modelProviderCredentials.ownerUserId,
    })
    .from(modelProviderCredentials)
    .where(
      scopedWhere(modelProviderCredentials, {
        orgId,
        extra: [eq(modelProviderCredentials.id, credentialId)],
      }),
    )
    .limit(1);
  return row ?? null;
}

/**
 * The visibility rule, shared by the test probes. An organization credential is
 * visible to `readsOrg`; a personal one to its owner alone. Anything else reads as absent.
 */
export async function canSeeCredential(
  caller: ModelCredentialCaller,
  id: string,
): Promise<boolean> {
  const row = await loadCredentialBinding(caller.orgId, id);
  if (!row) return false;
  return row.ownerUserId === null ? caller.readsOrg : row.ownerUserId === caller.userId;
}

/**
 * The probe rule, shared by every door that spends a stored credential's key: a
 * personal credential serves no call while the org has personal credentials off.
 */
export async function assertCredentialProbeAllowed(
  orgId: string,
  credentialId: string,
): Promise<void> {
  const row = await loadCredentialBinding(orgId, credentialId);
  if (row && row.ownerUserId !== null) await assertPersonalModelCredentialsAllowed(orgId);
}

/**
 * The editability rule, shared by PATCH, DELETE and pairing reconnect: an
 * organization credential needs `writesOrg` (`deletesOrg` to delete it); a
 * personal one must be the caller's own, except that a `deletesOrg` holder may
 * delete any personal credential (break-glass). Anything else is a 404: to the caller, it does not exist.
 */
export async function assertCredentialEditable(
  caller: ModelCredentialCaller,
  id: string,
  action: "edit" | "delete",
): Promise<void> {
  const row = await loadCredentialBinding(caller.orgId, id);
  const managesOrg = action === "delete" ? caller.deletesOrg : caller.writesOrg;
  const editable =
    !!row &&
    (row.ownerUserId === null
      ? managesOrg
      : row.ownerUserId === caller.userId || (action === "delete" && caller.deletesOrg));
  if (!editable) throw notFound("Model provider credential not found");
}

// ─── Label derivation ──────────────────────────────────────────────────────

/**
 * Make `base` unique within one owner's credential labels by appending ` (2)`,
 * ` (3)`, … on collision (same suffix scheme as org models). Always run a
 * label through this before persisting — including caller-supplied ones —
 * so two connections to the same provider never share a name. The
 * `connect-helper` CLI sends a default label (`ChatGPT`, `Claude`) on every
 * redeem, so deriving only when the label is absent would never dedupe.
 * Scoped to the owner (`null` = organization) so no member sees another's labels.
 */
export async function dedupeCredentialLabel(
  orgId: string,
  base: string,
  ownerUserId: string | null,
): Promise<string> {
  const rows = await db
    .select({ label: modelProviderCredentials.label })
    .from(modelProviderCredentials)
    .where(
      scopedWhere(modelProviderCredentials, {
        orgId,
        extra: [
          ownerUserId === null
            ? isNull(modelProviderCredentials.ownerUserId)
            : eq(modelProviderCredentials.ownerUserId, ownerUserId),
        ],
      }),
    );
  return dedupeLabel(
    base,
    rows.map((r) => r.label),
  );
}

/**
 * Default label: `<host> · <displayName>` for a credential on its own endpoint,
 * the display name otherwise. A base label — run it through {@link dedupeCredentialLabel}.
 */
export function deriveCredentialLabel(
  cfg: Pick<ModelProviderDefinition, "displayName" | "baseUrlOverridable">,
  baseUrlOverride: string | null | undefined,
): string {
  if (!cfg.baseUrlOverridable || !baseUrlOverride) return cfg.displayName;
  const host = URL.parse(baseUrlOverride)?.host;
  return host ? `${host} · ${cfg.displayName}` : cfg.displayName;
}

/**
 * Persist refreshed OAuth tokens. Called by the refresh worker / on-demand
 * resolver after a successful upstream refresh. Preserves blob fields the
 * upstream didn't return (e.g. `email`, `accountId` when not rotated).
 */
interface UpdateOAuthCredentialTokensInput {
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
  /** Optional — set when the provider re-issues an `accountId` on every refresh; pass through. */
  accountId?: string;
}

/**
 * Shared blob read-modify-write: select → decrypt → apply `mutate` →
 * re-encrypt → update (org-scoped). `mutate` returns the next blob, or `null`
 * to leave a blob of the wrong kind alone; a missing or unreadable row is a
 * no-op. The denormalized `expiresAt` column is mirrored
 * ONLY when the next blob's `expiresAt` differs from the existing one — so
 * callers that don't touch expiry (e.g. {@link markCredentialNeedsReconnection})
 * leave the column untouched. `extraColumns` lets a caller piggyback plain
 * column writes (e.g. the refresh-failure streak reset) onto the same UPDATE.
 */
async function updateBlob(
  orgId: string,
  id: string,
  mutate: (existing: CredentialsBlob) => CredentialsBlob | null,
  extraColumns?: Partial<typeof modelProviderCredentials.$inferInsert>,
): Promise<void> {
  // Optimistic concurrency (compare-and-swap). The read-modify-write below is
  // NOT atomic on its own: a refresh (rotating tokens) and a dead-marking
  // (`markCredentialNeedsReconnection`) can interleave so the last writer
  // clobbers the other's change — e.g. a refresh re-encrypts the stale blob it
  // read and silently un-marks a concurrently-set `needsReconnection`. We guard
  // the UPDATE on the exact ciphertext we based the mutation on: because the
  // envelope uses a random GCM IV, every write produces a DISTINCT ciphertext,
  // so a racing writer's value makes our WHERE match zero rows. On a 0-row
  // outcome we re-read and re-apply the mutation against the fresh blob.
  const MAX_CAS_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
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
    const existing = decryptBlob(row.credentialsEncrypted, id);
    const next = existing && mutate(existing);
    if (!existing || !next) return;
    const set: Record<string, unknown> = {
      ...extraColumns,
      credentialsEncrypted: encryptCredentials(next as unknown as Record<string, unknown>),
      updatedAt: new Date(),
    };
    // Keep the denormalized cache in lockstep with the blob — the refresh worker
    // scan filters on this column to skip the per-row decrypt. Only write it when
    // the mutation actually changed the expiry.
    if (
      next.kind === "oauth" &&
      existing.kind === "oauth" &&
      next.expiresAt !== existing.expiresAt
    ) {
      set.expiresAt = next.expiresAt !== null ? new Date(next.expiresAt) : null;
    }

    const updated = await db
      .update(modelProviderCredentials)
      .set(set)
      .where(
        scopedWhere(modelProviderCredentials, {
          orgId,
          extra: [
            eq(modelProviderCredentials.id, id),
            // CAS token: only write if the blob is still the one we read.
            eq(modelProviderCredentials.credentialsEncrypted, row.credentialsEncrypted),
          ],
        }),
      )
      .returning({ id: modelProviderCredentials.id });

    if (updated.length > 0) {
      // Chokepoint for every blob write (token refresh + needsReconnection):
      // bust the resolved-model cache so a rotated token or a freshly-dead credential
      // stops being served immediately, not after the TTL.
      clearResolvedModelCache();
      return;
    }
    // Lost the CAS race (a concurrent writer rotated the ciphertext) — re-read
    // and re-apply against the fresh blob.
  }
  logger.warn("updateBlob: exhausted CAS retries under contention", { id });
}

export async function updateOAuthCredentialTokens(
  orgId: string,
  id: string,
  fresh: UpdateOAuthCredentialTokensInput,
): Promise<void> {
  await updateBlob(
    orgId,
    id,
    (existing) =>
      existing.kind !== "oauth"
        ? null
        : {
            ...existing,
            accessToken: fresh.accessToken,
            refreshToken: fresh.refreshToken,
            expiresAt: fresh.expiresAt,
            needsReconnection: false,
            ...(fresh.accountId ? { accountId: fresh.accountId } : {}),
          },
    // Any successful token write clears the transient-refresh streak — a
    // working refresh proves the credential is healthy again, so the
    // escalation counter must not carry over. See
    // `recordModelCredentialRefreshFailure`.
    { refreshFailureCount: 0 },
  );
}

export async function markCredentialNeedsReconnection(orgId: string, id: string): Promise<void> {
  await updateBlob(orgId, id, (existing) => ({ ...existing, needsReconnection: true }));
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
 *
 * Returns the streak and whether this failure flagged the credential; `null` when no row matched.
 */
export async function recordModelCredentialRefreshFailure(
  orgId: string,
  id: string,
  maxFailures: number,
  graceSeconds: number,
): Promise<{ failures: number; needsReconnection: boolean } | null> {
  const updated = await db
    .update(modelProviderCredentials)
    .set({
      refreshFailureCount: sql`${modelProviderCredentials.refreshFailureCount} + 1`,
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
  if (!row) return null;
  const failures = row.refreshFailureCount;
  const expiredPastGrace =
    row.expiresAt !== null && row.expiresAt.getTime() < Date.now() - graceSeconds * 1000;
  if (failures < maxFailures || !expiredPastGrace) return { failures, needsReconnection: false };
  logger.warn("oauth model provider: escalating to needsReconnection after repeated failures", {
    credentialId: id,
    refreshFailureCount: failures,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  });
  await markCredentialNeedsReconnection(orgId, id);
  return { failures, needsReconnection: true };
}

/**
 * Count an upstream 401 on an api-key credential. The `INTEGRATION_REFRESH_MAX_FAILURES`-th
 * consecutive one flags it, while the row still holds `rejectedApiKey`; a successful call
 * ({@link clearModelCredentialRejections}) or a key rotation ends the streak.
 */
export async function recordModelCredentialRejection(
  orgId: string,
  id: string,
  rejectedApiKey: string,
): Promise<void> {
  const [updated] = await db
    .update(modelProviderCredentials)
    .set({ refreshFailureCount: sql`${modelProviderCredentials.refreshFailureCount} + 1` })
    .where(
      scopedWhere(modelProviderCredentials, {
        orgId,
        extra: [eq(modelProviderCredentials.id, id)],
      }),
    )
    .returning({ failures: modelProviderCredentials.refreshFailureCount });
  if (!updated || updated.failures < getEnv().INTEGRATION_REFRESH_MAX_FAILURES) return;

  logger.warn("model provider: api key rejected upstream, flagging needsReconnection", {
    credentialId: id,
    failures: updated.failures,
  });
  await updateBlob(orgId, id, (b) =>
    b.kind === "api_key" && b.apiKey === rejectedApiKey ? { ...b, needsReconnection: true } : null,
  );
}

/** A successful upstream call ends the credential's rejection streak. */
export async function clearModelCredentialRejections(orgId: string, id: string): Promise<void> {
  await db
    .update(modelProviderCredentials)
    .set({ refreshFailureCount: 0 })
    .where(
      scopedWhere(modelProviderCredentials, {
        orgId,
        extra: [
          eq(modelProviderCredentials.id, id),
          gt(modelProviderCredentials.refreshFailureCount, 0),
        ],
      }),
    );
}

// ─── Delete ────────────────────────────────────────────────────────────────

export async function deleteModelProviderCredential(
  caller: ModelCredentialCaller,
  id: string,
): Promise<void> {
  await assertCredentialEditable(caller, id, "delete");
  await db.delete(modelProviderCredentials).where(
    scopedWhere(modelProviderCredentials, {
      orgId: caller.orgId,
      extra: [eq(modelProviderCredentials.id, id)],
    }),
  );
  // Any model backed by the deleted credential is now unresolvable — drop cached
  // resolutions so they don't serve a stale (now-deleted) secret.
  clearResolvedModelCache();
}

// ─── Aggregated UI surface (system env-driven + DB) ────────────────────────

/**
 * List the aggregated UI view of the model provider credentials the caller may see.
 *
 * Combines two sources:
 *   1. `SYSTEM_PROVIDER_KEYS` env-driven keys (built-in, immutable, env-controlled)
 *   2. The unified `model_provider_credentials` table (custom, OAuth + api-key)
 *
 * A caller holding `readsOrg` sees every row; anyone else sees their own
 * personal credentials and no built-in ones.
 *
 * Returns the public `ModelProviderCredentialInfo` shape (shared-types) —
 * never carries plaintext. `apiShape` is derived from the registry for DB
 * rows and from the system definition for env-driven keys.
 */
export async function listOrgModelProviderCredentials(
  caller: ModelCredentialCaller,
): Promise<ModelProviderCredentialInfo[]> {
  const system = caller.readsOrg ? getSystemModelProviderCredentials() : new Map<string, never>();
  const now = toISORequired(new Date());
  const rows = await db
    .select({ credential: modelProviderCredentials, ownerName: user.name })
    .from(modelProviderCredentials)
    .leftJoin(user, eq(user.id, modelProviderCredentials.ownerUserId))
    .where(
      scopedWhere(modelProviderCredentials, {
        orgId: caller.orgId,
        extra: [
          caller.readsOrg
            ? undefined
            : eq(modelProviderCredentials.ownerUserId, caller.userId ?? sql`NULL`),
        ],
      }),
    );

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
    rows: rows.map(({ credential, ownerName }) => ({ ...credential, ownerName })),
    mapSystem: (id, def): ModelProviderCredentialInfo => {
      const provider = getModelProvider(def.providerId);
      const aliasOnly = aliasOnlySystemCredentials.has(id);
      return {
        id,
        // An alias-only credential must not fall back to the provider's
        // display name / provider id — that would name the very backing this
        // block hides (apiShape/baseUrl are nulled below for the same reason).
        // Use a neutral fallback instead.
        label:
          def.label ?? (aliasOnly ? "System models" : (provider?.displayName ?? def.providerId)),
        apiShape: aliasOnly ? null : def.apiShape,
        base_url: aliasOnly ? null : def.baseUrl,
        source: "built-in",
        authMode: "api_key",
        owner_type: "org",
        owner_id: null,
        owner_name: null,
        created_by: null,
        createdAt: now,
        updatedAt: now,
      };
    },
    mapRow: (r): ModelProviderCredentialInfo => {
      const cfg = getModelProvider(r.providerId);
      const stored = decryptForDisplay(
        () => decryptCredentials<CredentialsBlob>(r.credentialsEncrypted),
        { credentialId: r.id },
      );
      // Under a missing key the row shows as it is: the 503 is for the actions that need it.
      const blob = stored === KEY_UNAVAILABLE ? undefined : stored;
      const isOauth = blob?.kind === "oauth";
      return {
        id: r.id,
        label: r.label,
        apiShape: cfg?.apiShape ?? "openai-completions",
        base_url: cfg ? effectiveBaseUrl(cfg, r.baseUrlOverride) : "",
        source: "custom",
        authMode: cfg?.authMode ?? "api_key",
        providerId: r.providerId,
        // A member's personal account email is shown to its owner alone.
        oauth_email:
          isOauth && (r.ownerUserId === null || r.ownerUserId === caller.userId)
            ? (blob.email ?? null)
            : null,
        // Flagged or undecryptable: the model list badges the same cases and points here.
        needs_reconnection: blob === null || !!blob?.needsReconnection,
        owner_type: r.ownerUserId === null ? "org" : "user",
        owner_id: r.ownerUserId,
        owner_name: r.ownerName ?? null,
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
  caller: ModelCredentialCaller,
  id: string,
): Promise<ModelProviderCredentialInfo | undefined> {
  const all = await listOrgModelProviderCredentials(caller);
  return all.find((c) => c.id === id);
}

/**
 * Resolve a credential id to plaintext credentials usable for inference
 * (model probe, LLM proxy, sidecar config). Combines the two read paths
 * into one — system (env-driven) keys from `SYSTEM_PROVIDER_KEYS` and
 * DB-stored credentials (api-key or OAuth, decrypted on demand) — and
 * gates dead rows (`needsReconnection`).
 *
 * The returned shape carries the registry overlay (apiShape, baseUrl)
 * inline so downstream consumers (pi.ts, llm-proxy) don't
 * have to re-look-up `getModelProvider(providerId)`.
 *
 * Returns `null` when the id is unknown to either source, or when the
 * credential is dead and the caller must treat it as missing.
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
  // A blob that will not decrypt is as dead as a missing row for inference —
  // the raw load keeps such a credential alive for the metadata callers, this
  // path does not (a key missing from the keyring has already thrown the 503).
  if (!loaded || !loaded.blob) return null;
  if (loaded.blob.needsReconnection) return null;

  const common = {
    providerId: loaded.providerId,
    apiShape: loaded.apiShape,
    baseUrl: loaded.baseUrl,
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
