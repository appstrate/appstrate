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
import { z } from "zod";
import { eq, gt, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { modelConfigs, modelProviderCredentials, orgModels, user } from "@appstrate/db/schema";
import { encryptCredentials, decryptCredentials } from "@appstrate/connect";
import { MODEL_CREDENTIAL_OWNERS } from "@appstrate/core/model-payer";
import { inTransaction, mergeSystemAndDb, scopedWhere } from "../../lib/db-helpers.ts";
import { toISORequired } from "../../lib/date-helpers.ts";
import { ApiError, forbidden, invalidRequest, notFound } from "../../lib/errors.ts";
import { resolveConnectionConfig, type ModelConfigRow } from "../model-configs.ts";
import { getModelProvider } from "./registry.ts";
import type {
  CredentialDeathCause,
  ModelApiShape,
  OAuthTokenResponse,
} from "@appstrate/core/sidecar-types";
import { announceCredentialNeedsReconnection } from "../credential-reconnection.ts";
import { recordAudit, trackAudit } from "../audit.ts";
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
import type {
  ModelProviderCredentialAction,
  ModelProviderCredentialInfo,
} from "@appstrate/shared-types";
import { clearResolvedModelCache } from "../resolved-model-cache.ts";
import { lockOrgMember } from "../space-members.ts";
import { orgPermissions } from "../../lib/permissions.ts";
import type { DbOrTx } from "../../lib/db-helpers.ts";
import type { AppEnv } from "../../types/index.ts";
import { permissionDenied } from "../../middleware/require-permission.ts";
import { requestPayerUserId, servesModel } from "./credential-chain.ts";

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
  /** Holds `model-provider-credentials:connect` (own personal credentials). */
  connects: boolean;
  /** Holds `models:write`: the only grant that creates a model configuration, explicitly or implicitly. */
  createsConfigs: boolean;
}

function modelCredentialCaller(
  orgId: string,
  userId: string | null,
  permissions: ReadonlySet<string>,
): ModelCredentialCaller {
  return {
    orgId,
    userId,
    readsOrg: permissions.has("model-provider-credentials:read"),
    writesOrg: permissions.has("model-provider-credentials:write"),
    deletesOrg: permissions.has("model-provider-credentials:delete"),
    connects: permissions.has("model-provider-credentials:connect"),
    createsConfigs: permissions.has("models:write"),
  };
}

/** The model credential caller of a request: its org, its payer and its effective permissions. */
export function requestModelCredentialCaller(c: Context<AppEnv>): ModelCredentialCaller {
  return modelCredentialCaller(
    c.get("orgId"),
    requestPayerUserId(c),
    c.get("permissions") ?? new Set<string>(),
  );
}

/**
 * The member who minted a pairing, as the organization grants them now, under
 * the membership lock every role change and exit takes: the redeem holds no
 * principal, so it judges the minter again. `null` when they are no longer a member.
 */
async function lockMinter(
  tx: DbOrTx,
  orgId: string,
  userId: string,
): Promise<ModelCredentialCaller | null> {
  const member = await lockOrgMember(tx, orgId, userId);
  return member ? modelCredentialCaller(orgId, userId, orgPermissions(member.role)) : null;
}

/** Create, rotate or reconnect: an org manager, or a member for its own (`connect`). */
export const MANAGE_CREDENTIALS = [
  "model-provider-credentials:write",
  "model-provider-credentials:connect",
];

/**
 * `owner_type` of the two creation doors (API key, subscription pairing): `org`
 * (default) is an organization credential, `user` the caller's personal one.
 */
export const credentialOwnerTypeSchema = z.enum(MODEL_CREDENTIAL_OWNERS).default("org");

/**
 * The owner a creation door writes for `ownerType`, once {@link mayCreateCredential}
 * admits the caller. A delegate owns nothing: its personal creation is refused.
 */
export function resolveCredentialOwner(
  c: Context<AppEnv>,
  ownerType: z.infer<typeof credentialOwnerTypeSchema>,
): string | null {
  const caller = requestModelCredentialCaller(c);
  const ownerUserId = ownerType === "org" ? null : caller.userId;
  if (ownerType === "user" && ownerUserId === null) {
    throw forbidden("A personal credential belongs to a user");
  }
  if (!mayCreateCredential(caller, ownerUserId)) {
    throw permissionDenied(
      c,
      `model-provider-credentials:${ownerType === "org" ? "write" : "connect"}`,
    );
  }
  return ownerUserId;
}

// ─── Blob shapes (encrypted at rest) ───────────────────────────────────────

interface ApiKeyBlob {
  kind: "api_key";
  apiKey: string;
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
 * `refreshToken` and the surface-only
 * `email`. Keeping the relationship explicit (intersection, not parallel
 * declaration) means a field added to the token is automatically required here.
 */
export type OAuthBlob = OAuthToken & {
  kind: "oauth";
  refreshToken: string;
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
  /** OAuth only — epoch ms. The refresh sweep filters on its denormalized column. */
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
 * The endpoint a connection talks to: its configuration's `base_url` for a provider that
 * takes one (a gateway), else the provider's default. Declared once: it decides where a
 * stored key is sent.
 */
export function effectiveBaseUrl(
  cfg: ModelProviderDefinition,
  configBaseUrl: string | null,
): string {
  return configBaseUrl && cfg.baseUrlOverridable ? configBaseUrl : cfg.defaultBaseUrl;
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
  /** The configuration the connection serves. */
  configId: string;
  config: ModelProviderDefinition;
  /** Registry-derived — see {@link DecryptedModelProviderCredentials}. */
  apiShape: ModelApiShape;
  /** Registry default, or the configuration's endpoint when the provider takes one. */
  baseUrl: string;
  /** The row's `needs_reconnection` column: the one authority on whether the credential is dead. */
  needsReconnection: boolean;
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
      configId: modelConfigs.id,
      configBaseUrl: modelConfigs.baseUrl,
      credentialsEncrypted: modelProviderCredentials.credentialsEncrypted,
      needsReconnection: modelProviderCredentials.needsReconnection,
    })
    .from(modelProviderCredentials)
    .innerJoin(modelConfigs, eq(modelConfigs.id, modelProviderCredentials.configId))
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
      configId: row.configId,
      config,
      apiShape: config.apiShape,
      baseUrl: effectiveBaseUrl(config, row.configBaseUrl),
      needsReconnection: row.needsReconnection,
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

export function personalConnectionsDisabled(): ApiError {
  return new ApiError({
    status: 403,
    code: "personal_connections_disabled",
    title: "Forbidden",
    detail: "This model configuration does not allow personal connections",
  });
}

/**
 * The configuration a new connection is written under, settled in its transaction: the
 * named one (the org's, and the provider fits it), else the provider's family
 * configuration, created when missing and `mayCreateConfig`; a personal connection needs
 * it to allow them.
 */
async function admitConfig(
  tx: DbOrTx,
  input: { orgId: string; userId: string; providerId: string },
  named: ModelConfigRow | string | undefined,
  ownerUserId: string | null,
  mayCreateConfig: boolean,
): Promise<string> {
  const config = await resolveConnectionConfig(
    tx,
    input.orgId,
    input.providerId,
    named,
    input.userId,
    mayCreateConfig,
  );
  if (ownerUserId !== null && !config.personalConnectionsAllowed) {
    throw personalConnectionsDisabled();
  }
  return config.id;
}

interface CreateApiKeyCredentialInput {
  orgId: string;
  userId: string;
  label: string;
  providerId: string;
  apiKey: string;
  /** The configuration it serves, by id or as a row the caller read already; neither = its provider's family configuration. */
  configId?: string;
  config?: ModelConfigRow;
  /** The caller holds `models:write`: a missing family configuration is created for it. */
  mayCreateConfig: boolean;
  /** The member who owns a personal credential; `null` = organization credential. */
  ownerUserId: string | null;
}

export async function createApiKeyCredential(
  input: CreateApiKeyCredentialInput,
  executor: DbOrTx = db,
): Promise<string> {
  const cfg = getModelProvider(input.providerId);
  if (!cfg) {
    throw new Error(`Unknown providerId: ${input.providerId}`);
  }
  if (cfg.authMode !== "api_key") {
    throw new Error(
      `Provider ${input.providerId} requires OAuth (authMode=${cfg.authMode}); use createOAuthCredential instead`,
    );
  }
  const { ownerUserId } = input;
  const blob: ApiKeyBlob = { kind: "api_key", apiKey: input.apiKey };
  return insertCredential(
    {
      orgId: input.orgId,
      label: input.label,
      providerId: input.providerId,
      credentialsEncrypted: encryptCredentials(blob as unknown as Record<string, unknown>),
      createdBy: input.userId,
      ownerUserId,
    },
    // A personal key is written under its owner's membership lock, the one the
    // organization exit holds while it deletes their credentials, so a credential
    // created during the exit cannot outlive it.
    async (tx) => {
      const configId = await admitConfig(
        tx,
        input,
        input.config ?? input.configId,
        ownerUserId,
        input.mayCreateConfig,
      );
      if (ownerUserId && !(await lockOrgMember(tx, input.orgId, ownerUserId))) {
        throw forbidden("Not a member of this organization");
      }
      return configId;
    },
    executor,
  );
}

/**
 * Insert a credential row once `admit` let it through, in the same transaction, under the
 * configuration `admit` settled.
 */
async function insertCredential(
  values: Omit<typeof modelProviderCredentials.$inferInsert, "configId">,
  admit: (tx: DbOrTx) => Promise<string>,
  executor: DbOrTx = db,
): Promise<string> {
  const id = await inTransaction(executor, async (tx) => {
    const configId = await admit(tx);
    const [row] = await tx
      .insert(modelProviderCredentials)
      .values({ ...values, configId })
      .returning({ id: modelProviderCredentials.id });
    return row!.id;
  });
  clearResolvedModelCache();
  return id;
}

export interface CreateOAuthCredentialInput {
  orgId: string;
  /** The member who minted the pairing. */
  userId: string;
  /** `null` = organization credential; else a personal one, the minter's own. */
  ownerUserId: string | null;
  label: string;
  providerId: string;
  /** The configuration it serves; absent = its provider's family configuration. */
  configId?: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. `null` / unset = unknown expiry (sidecar treats as "always refresh"). */
  expiresAt?: number | null;
  accountId?: string;
  email?: string;
}

/**
 * The pairing redeem's creation door. The minter is judged as the mint judged
 * them ({@link mayCreateCredential}), on what the organization grants them
 * at this moment: anything less is the 403.
 */
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
  const { ownerUserId } = input;
  const expiresAt = input.expiresAt ?? null;
  const blob: OAuthBlob = {
    kind: "oauth",
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    expiresAt,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.email ? { email: input.email } : {}),
  };
  return insertCredential(
    {
      orgId: input.orgId,
      label: input.label,
      providerId: input.providerId,
      credentialsEncrypted: encryptCredentials(blob as unknown as Record<string, unknown>),
      // Mirror the blob's expiry onto its column so the refresh sweep can
      // filter at SQL level. Blob remains source of truth.
      expiresAt: expiresAt !== null ? new Date(expiresAt) : null,
      refreshCheckedAt: new Date(),
      createdBy: input.userId,
      ownerUserId,
    },
    async (tx) => {
      const minter = await lockMinter(tx, input.orgId, input.userId);
      if (!minter) throw forbidden("Not a member of this organization");
      if (!mayCreateCredential(minter, ownerUserId)) {
        throw forbidden("The member who minted this pairing may not create this credential");
      }
      return admitConfig(tx, input, input.configId, ownerUserId, minter.createsConfigs);
    },
  );
}

interface ReconnectOAuthCredentialInput {
  orgId: string;
  /** The member who minted the pairing. */
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
 * The pairing redeem's reconnect door. The minter is judged as the mint judged
 * them ({@link reconnectVerdict}), on what the organization grants them at this
 * moment and on the row as it is, read under lock: `false` is the route's 404.
 */
export async function reconnectOAuthCredential(
  input: ReconnectOAuthCredentialInput,
): Promise<boolean> {
  const where = scopedWhere(modelProviderCredentials, {
    orgId: input.orgId,
    extra: [
      eq(modelProviderCredentials.id, input.id),
      eq(modelProviderCredentials.providerId, input.providerId),
    ],
  });
  const updated = await db.transaction(async (tx) => {
    const minter = await lockMinter(tx, input.orgId, input.userId);
    if (!minter) return false;
    const [row] = await tx
      .select({
        credentialsEncrypted: modelProviderCredentials.credentialsEncrypted,
        ownerUserId: modelProviderCredentials.ownerUserId,
        personalAllowed: modelConfigs.personalConnectionsAllowed,
      })
      .from(modelProviderCredentials)
      .innerJoin(modelConfigs, eq(modelConfigs.id, modelProviderCredentials.configId))
      .where(where)
      .for("update", { of: modelProviderCredentials });
    if (!row) return false;
    const facts: CredentialFacts = {
      source: "custom",
      ownerUserId: row.ownerUserId,
      authMode: getModelProvider(input.providerId)?.authMode ?? "api_key",
      providerId: input.providerId,
    };
    const verdict = reconnectVerdict(minter, facts, input.providerId, row.personalAllowed);
    if (verdict === "policy_off") throw personalConnectionsDisabled();
    if (verdict === "absent") return false;

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
      ...(accountId ? { accountId } : {}),
      ...(email ? { email } : {}),
    };
    await tx
      .update(modelProviderCredentials)
      .set({
        credentialsEncrypted: encryptCredentials(blob as unknown as Record<string, unknown>),
        expiresAt: expiresAt !== null ? new Date(expiresAt) : null,
        needsReconnection: false,
        needsReconnectionCause: null,
        needsReconnectionAt: null,
        refreshFailureCount: 0,
        refreshCheckedAt: new Date(),
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
      throw invalidRequest(
        "api_key cannot be set on an OAuth credential: reconnect it instead",
        "api_key",
      );
    }
    const next: ApiKeyBlob = { kind: "api_key", apiKey: patch.apiKey };
    updates.credentialsEncrypted = encryptCredentials(next as unknown as Record<string, unknown>);
    updates.refreshFailureCount = 0;
    updates.needsReconnection = false;
    updates.needsReconnectionCause = null;
    updates.needsReconnectionAt = null;
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A connection of the org as the access rules read it: its type, owner and configuration. */
interface CredentialBinding {
  providerId: string;
  /** `null` for an organization connection. */
  ownerUserId: string | null;
  configId: string;
  /** Its configuration's switch. */
  personalConnectionsAllowed: boolean;
}

/** A connection of the org, or `null` (another org's, unknown, or a built-in key's id). */
export async function loadCredentialBinding(
  orgId: string,
  credentialId: string,
  executor: DbOrTx = db,
): Promise<CredentialBinding | null> {
  // A built-in key's id (`anthropic`, …) is not a uuid: no row, never a 22P02.
  if (!UUID_RE.test(credentialId)) return null;
  const [row] = await executor
    .select({
      providerId: modelProviderCredentials.providerId,
      ownerUserId: modelProviderCredentials.ownerUserId,
      configId: modelConfigs.id,
      personalConnectionsAllowed: modelConfigs.personalConnectionsAllowed,
    })
    .from(modelProviderCredentials)
    .innerJoin(modelConfigs, eq(modelConfigs.id, modelProviderCredentials.configId))
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
 * The probe rule, shared by every door that spends a stored credential's key to
 * test it and by the `test` action the list serializes. An organization
 * credential is probed by `readsOrg`; a personal one by its owner alone, holding
 * `readsOrg` or `connects`, and only while its configuration allows personal
 * connections: {@link mayProbeCredential} refuses (403), the list omits `test`.
 */
function mayProbe(caller: ModelCredentialCaller, ownerUserId: string | null): boolean {
  if (ownerUserId === null) return caller.readsOrg;
  return ownerUserId === caller.userId && (caller.readsOrg || caller.connects);
}

/**
 * {@link mayProbe} for a stored credential. `false`: the caller cannot see it,
 * so it reads as absent.
 */
export async function mayProbeCredential(
  caller: ModelCredentialCaller,
  id: string,
): Promise<boolean> {
  const row = await loadCredentialBinding(caller.orgId, id);
  if (!row || !mayProbe(caller, row.ownerUserId)) return false;
  if (row.ownerUserId !== null && !row.personalConnectionsAllowed) {
    throw personalConnectionsDisabled();
  }
  return true;
}

/**
 * The editability rule, shared by every door that edits or deletes a credential.
 * An organization credential needs `writesOrg` (`deletesOrg` to delete it). A
 * personal one is edited by its owner holding `connects` or `writesOrg`, and
 * deleted by its owner holding `connects`, or by any `deletesOrg` holder (break-glass).
 */
function mayManageCredential(
  caller: ModelCredentialCaller,
  ownerUserId: string | null,
  action: "edit" | "delete",
): boolean {
  if (ownerUserId === null) return action === "delete" ? caller.deletesOrg : caller.writesOrg;
  const own = ownerUserId === caller.userId;
  return action === "edit"
    ? own && (caller.writesOrg || caller.connects)
    : caller.deletesOrg || (own && caller.connects);
}

/**
 * The creation rule, shared by the request doors and the pairing redeem: an
 * organization credential (`null`) needs `writesOrg`, a personal one is the
 * caller's own and needs `connects`.
 */
function mayCreateCredential(caller: ModelCredentialCaller, ownerUserId: string | null): boolean {
  return ownerUserId === null ? caller.writesOrg : ownerUserId === caller.userId && caller.connects;
}

/** A credential as the action rules read it. */
interface CredentialFacts {
  source: "built-in" | "custom";
  ownerUserId: string | null;
  authMode: "api_key" | "oauth2";
  providerId?: string | null;
}

/**
 * The reconnect rule, shared by the list's `reconnect` action, the pairing mint
 * and its redeem. `ok`: an OAuth credential of `providerId` the caller may edit.
 * `policy_off`: such a personal one while its configuration has personal
 * connections off (`personalAllowed` false). `absent`: anything else.
 */
export function reconnectVerdict(
  caller: ModelCredentialCaller,
  credential: CredentialFacts,
  providerId: string,
  personalAllowed: boolean,
): "ok" | "absent" | "policy_off" {
  const reconnectable =
    credential.source === "custom" &&
    credential.authMode === "oauth2" &&
    credential.providerId === providerId &&
    mayManageCredential(caller, credential.ownerUserId, "edit");
  if (!reconnectable) return "absent";
  return credential.ownerUserId === null || personalAllowed ? "ok" : "policy_off";
}

/**
 * The actions the caller may take on one credential, as the list serializes them.
 * `personalAllowed` is the switch of the credential's configuration.
 */
export function credentialActions(
  caller: ModelCredentialCaller,
  credential: CredentialFacts,
  personalAllowed: boolean,
): ModelProviderCredentialAction[] {
  if (credential.source === "built-in") return caller.readsOrg ? ["test"] : [];
  const { ownerUserId } = credential;
  const actions: ModelProviderCredentialAction[] = [];
  if (mayManageCredential(caller, ownerUserId, "edit")) actions.push("edit");
  if (mayManageCredential(caller, ownerUserId, "delete")) actions.push("delete");
  if (mayProbe(caller, ownerUserId) && (ownerUserId === null || personalAllowed)) {
    actions.push("test");
  }
  if (
    credential.providerId &&
    reconnectVerdict(caller, credential, credential.providerId, personalAllowed) === "ok"
  ) {
    actions.push("reconnect");
  }
  return actions;
}

/**
 * The editability rule of PATCH and DELETE: a credential the caller may not
 * manage is a 404, since to the caller it does not exist.
 */
export async function assertCredentialEditable(
  caller: ModelCredentialCaller,
  id: string,
  action: "edit" | "delete",
): Promise<void> {
  const row = await loadCredentialBinding(caller.orgId, id);
  if (!row || !mayManageCredential(caller, row.ownerUserId, action)) {
    throw notFound("Model provider credential not found");
  }
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
 * Default label: `<host> · <displayName>` for a connection of a gateway configuration,
 * the display name otherwise. A base label — run it through {@link dedupeCredentialLabel}.
 */
export function deriveCredentialLabel(
  cfg: Pick<ModelProviderDefinition, "displayName" | "baseUrlOverridable">,
  configBaseUrl: string | null,
): string {
  if (!cfg.baseUrlOverridable || !configBaseUrl) return cfg.displayName;
  const host = URL.parse(configBaseUrl)?.host;
  return host ? `${host} · ${cfg.displayName}` : cfg.displayName;
}

/**
 * Persist refreshed OAuth tokens. Called by the refresh sweep / on-demand
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

export async function updateOAuthCredentialTokens(
  orgId: string,
  id: string,
  fresh: UpdateOAuthCredentialTokensInput,
): Promise<void> {
  // Optimistic concurrency (compare-and-swap). The read-modify-write below is
  // NOT atomic on its own: two refreshes (rotating tokens) can interleave so the
  // last writer clobbers the other's rotation. We guard
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
    if (existing?.kind !== "oauth") return;
    const accountId = fresh.accountId ?? existing.accountId;
    const next: OAuthBlob = {
      kind: "oauth",
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken,
      expiresAt: fresh.expiresAt,
      ...(accountId ? { accountId } : {}),
      ...(existing.email ? { email: existing.email } : {}),
    };
    const set: Record<string, unknown> = {
      credentialsEncrypted: encryptCredentials(next as unknown as Record<string, unknown>),
      updatedAt: new Date(),
      // Any successful token write clears the transient-refresh streak — a
      // working refresh proves the credential is healthy again, so the
      // escalation counter must not carry over. See
      // `recordModelCredentialRefreshFailure`.
      refreshFailureCount: 0,
      refreshCheckedAt: new Date(),
    };
    // Keep the denormalized cache in lockstep with the blob — the refresh sweep
    // filters on this column to skip the per-row decrypt. Only write it when
    // the refresh actually changed the expiry.
    if (next.expiresAt !== existing.expiresAt) {
      set.expiresAt = next.expiresAt !== null ? new Date(next.expiresAt) : null;
    }

    // Unlike the integration twin, this write never clears `needs_reconnection`, so it needs no
    // gate on that column: a concurrent death mark survives it.
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
      // Bust the resolved-model cache so a rotated token stops being served
      // immediately, not after the TTL.
      clearResolvedModelCache();
      return;
    }
    // Lost the CAS race (a concurrent writer rotated the ciphertext) — re-read
    // and re-apply against the fresh blob.
  }
  logger.warn("updateOAuthCredentialTokens: exhausted CAS retries under contention", { id });
}

/**
 * Flip point of `needsReconnection` for a dead credential: one UPDATE writes the flag, its cause
 * and its date on a row not yet flagged; only the call that did the flip audits and announces.
 */
export async function markCredentialNeedsReconnection(
  orgId: string,
  id: string,
  cause: CredentialDeathCause,
  extraWhere?: SQL,
): Promise<void> {
  const [flipped] = await db
    .update(modelProviderCredentials)
    .set({
      needsReconnection: true,
      needsReconnectionCause: cause,
      needsReconnectionAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      scopedWhere(modelProviderCredentials, {
        orgId,
        extra: [
          eq(modelProviderCredentials.id, id),
          eq(modelProviderCredentials.needsReconnection, false),
          ...(extraWhere ? [extraWhere] : []),
        ],
      }),
    )
    .returning({ providerId: modelProviderCredentials.providerId });
  if (!flipped) return;
  clearResolvedModelCache();
  announceModelCredentialDeath(orgId, id, flipped.providerId, cause);
}

function announceModelCredentialDeath(
  orgId: string,
  credentialId: string,
  providerId: string,
  cause: CredentialDeathCause,
): void {
  void trackAudit(
    recordAudit({
      orgId,
      actorType: "system",
      action: "model_provider_credential.needs_reconnection",
      resourceType: "model_provider_credential",
      resourceId: credentialId,
      after: { cause },
    }),
  );
  announceCredentialNeedsReconnection({
    kind: "model_provider_credential",
    orgId,
    credentialId,
    providerId,
    cause,
  });
}

/**
 * Record a *transient* token-refresh failure (network / 5xx / parse — NOT
 * `invalid_grant`, which flips `needs_reconnection` immediately via
 * {@link markCredentialNeedsReconnection}). Mirrors
 * `recordIntegrationRefreshFailure` for `integration_connections`.
 *
 * The counter increment is atomic (single SQL statement), so concurrent
 * refreshes on the same row cannot lose a count. The escalation
 * decision is made on the RETURNING values and applied via
 * {@link markCredentialNeedsReconnection}, which is monotonic (only ever sets `true`, on a row
 * not yet flagged), so the two-step write is race-safe: a concurrent flip is never cleared, and a
 * duplicate flip is a no-op.
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
  await markCredentialNeedsReconnection(orgId, id, "refresh_failures_exhausted");
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
  // An api key nothing can refresh, rejected upstream: the same cause as an integration's
  // unrefreshable credential.
  const [current] = await db
    .select({ credentialsEncrypted: modelProviderCredentials.credentialsEncrypted })
    .from(modelProviderCredentials)
    .where(
      scopedWhere(modelProviderCredentials, {
        orgId,
        extra: [eq(modelProviderCredentials.id, id)],
      }),
    )
    .limit(1);
  if (!current) return;
  const blob = decryptBlob(current.credentialsEncrypted, id);
  if (blob?.kind !== "api_key" || blob.apiKey !== rejectedApiKey) return;
  // Still the key that was rejected: a rotation since ends the streak.
  await markCredentialNeedsReconnection(
    orgId,
    id,
    "unrefreshable",
    eq(modelProviderCredentials.credentialsEncrypted, current.credentialsEncrypted),
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
): Promise<{ ownerUserId: string | null; providerId: string; label: string }> {
  await assertCredentialEditable(caller, id, "delete");
  const [deleted] = await db
    .delete(modelProviderCredentials)
    .where(
      scopedWhere(modelProviderCredentials, {
        orgId: caller.orgId,
        extra: [eq(modelProviderCredentials.id, id)],
      }),
    )
    .returning({
      ownerUserId: modelProviderCredentials.ownerUserId,
      providerId: modelProviderCredentials.providerId,
      label: modelProviderCredentials.label,
    });
  if (!deleted) throw notFound("Model provider credential not found");
  // Any model backed by the deleted credential is now unresolvable — drop cached
  // resolutions so they don't serve a stale (now-deleted) secret.
  clearResolvedModelCache();
  return deleted;
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
  // The models of each configuration, for what each connection of it can serve.
  const models = await db
    .select({ id: orgModels.id, configId: orgModels.configId, modelId: orgModels.modelId })
    .from(orgModels)
    .where(eq(orgModels.orgId, caller.orgId));
  const rows = await db
    .select({
      credential: modelProviderCredentials,
      ownerName: user.name,
      configId: modelConfigs.id,
      configProviderId: modelConfigs.providerId,
      configBaseUrl: modelConfigs.baseUrl,
      personalAllowed: modelConfigs.personalConnectionsAllowed,
    })
    .from(modelProviderCredentials)
    .leftJoin(user, eq(user.id, modelProviderCredentials.ownerUserId))
    .innerJoin(modelConfigs, eq(modelConfigs.id, modelProviderCredentials.configId))
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
  const servedBy = (r: { providerId: string; configId: string; configProviderId: string }) =>
    models
      .filter(
        (m) =>
          m.configId === r.configId && servesModel(r.providerId, r.configProviderId, m.modelId),
      )
      .map((m) => m.id);

  // Built-in credentials whose EVERY backing model is an alias:
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
    rows: rows.map(
      ({ credential, ownerName, configId, configProviderId, configBaseUrl, personalAllowed }) => ({
        ...credential,
        ownerName,
        configId,
        configProviderId,
        configBaseUrl,
        personalAllowed,
      }),
    ),
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
        allowed_actions: credentialActions(
          caller,
          { source: "built-in", ownerUserId: null, authMode: "api_key" },
          true,
        ),
        config_id: null,
        serves_model_ids: [],
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
      // Flagged or undecryptable: the model list badges the same cases and points here.
      const undecryptable = blob === null && !r.needsReconnection;
      const needsReconnection = r.needsReconnection || blob === null;
      const authMode = cfg?.authMode ?? "api_key";
      return {
        id: r.id,
        label: r.label,
        apiShape: cfg?.apiShape ?? "openai-completions",
        base_url: cfg ? effectiveBaseUrl(cfg, r.configBaseUrl) : "",
        source: "custom",
        authMode,
        providerId: r.providerId,
        // A member's personal account email is shown to its owner alone.
        oauth_email:
          isOauth && (r.ownerUserId === null || r.ownerUserId === caller.userId)
            ? (blob.email ?? null)
            : null,
        needs_reconnection: needsReconnection,
        // An undecryptable blob is dead without a recorded cause: derived, not stored.
        needs_reconnection_cause: undecryptable
          ? "credentials_undecryptable"
          : r.needsReconnectionCause,
        needs_reconnection_at: r.needsReconnectionAt?.toISOString() ?? null,
        owner_type: r.ownerUserId === null ? "org" : "user",
        owner_id: r.ownerUserId,
        owner_name: r.ownerName ?? null,
        allowed_actions: credentialActions(
          caller,
          {
            source: "custom",
            ownerUserId: r.ownerUserId,
            authMode,
            providerId: r.providerId,
          },
          r.personalAllowed,
        ),
        config_id: r.configId,
        serves_model_ids: servedBy(r),
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
 * instead of an id-only stub. Re-runs the list serializer rather
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
  // entry so downstream code (refresh sweep, hooks) resolves the same
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
  if (loaded.needsReconnection) return null;

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
    expiresAt: loaded.blob.expiresAt,
  };
}
