// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth Model Providers — token resolution and refresh.
 *
 * Backs the `/internal/oauth-token/:credentialId(/refresh)?` routes that the
 * sidecar polls during `/llm/*` request lifecycle (cf. SPEC §5.2). Reads
 * from the unified `model_provider_credentials` table; the row's blob has
 * `kind: "oauth"` and carries the access/refresh tokens.
 *
 * Concurrency: a single in-process `Map<credentialId, Promise<...>>` mutex
 * serializes refresh attempts for the same credential — multiple sidecars
 * hitting the API at the same time can each end up calling the provider,
 * so this singleflight is best-effort defense in depth (the sidecar's own
 * cache provides the primary deduplication).
 */

import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { modelProviderCredentials } from "@appstrate/db/schema";
import {
  decryptCredentials,
  parseTokenResponse,
  parseTokenErrorResponse,
  buildTokenHeaders,
  buildTokenBody,
} from "@appstrate/connect";
import {
  getModelProviderConfig,
  type ModelApiShape,
  type ModelProviderConfig,
} from "./registry.ts";
import { decodeCodexJwtPayload } from "./credentials.ts";
import {
  markCredentialNeedsReconnection,
  updateOAuthCredentialTokens,
  type OAuthBlob,
} from "../model-provider-credentials.ts";
import { gone, notFound } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";

/** Refresh `expiresAt` lead time. Mirrors the sidecar threshold (SPEC §5.2). */
const REFRESH_LEAD_MS = 5 * 60_000;

const inflightRefreshes = new Map<string, Promise<ResolvedToken>>();

export interface ResolvedToken {
  accessToken: string;
  /** Epoch milliseconds. `null` when the token's expiry is unknown — sidecar treats this as "always refresh". */
  expiresAt: number | null;
  apiShape: ModelApiShape;
  baseUrl: string;
  rewriteUrlPath?: { from: string; to: string };
  forceStream?: boolean;
  forceStore?: boolean;
  /** Codex only — extracted from JWT, used as `chatgpt-account-id` header by the sidecar. */
  accountId?: string;
  /** Canonical providerId, e.g. "codex" or "claude-code". */
  providerId: string;
}

/** Credential row + decrypted blob + registry overlay. Internal helper return shape. */
interface CredentialState {
  credentialId: string;
  orgId: string;
  blob: OAuthBlob;
  config: ModelProviderConfig & { authMode: "oauth2" };
}

async function loadCredentialState(credentialId: string): Promise<CredentialState> {
  const [row] = await db
    .select({
      id: modelProviderCredentials.id,
      orgId: modelProviderCredentials.orgId,
      providerId: modelProviderCredentials.providerId,
      credentialsEncrypted: modelProviderCredentials.credentialsEncrypted,
    })
    .from(modelProviderCredentials)
    .where(eq(modelProviderCredentials.id, credentialId))
    .limit(1);
  if (!row) {
    throw notFound(`OAuth model provider credential not found: ${credentialId}`);
  }

  const config = getModelProviderConfig(row.providerId);
  if (!config || config.authMode !== "oauth2") {
    throw notFound(
      `Credential ${credentialId} references provider ${row.providerId} which is not OAuth-enabled`,
    );
  }

  let blob: OAuthBlob;
  try {
    const decrypted = decryptCredentials<OAuthBlob>(row.credentialsEncrypted);
    if (decrypted.kind !== "oauth") {
      throw notFound(`Credential ${credentialId} stores api_key data, not OAuth tokens`);
    }
    blob = decrypted;
  } catch (err) {
    throw notFound(
      `Credential ${credentialId} ciphertext failed to decrypt: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    credentialId: row.id,
    orgId: row.orgId,
    blob,
    config: config as ModelProviderConfig & { authMode: "oauth2" },
  };
}

/**
 * Resolve `chatgpt_account_id` for a Codex credential, decoding the access
 * token as a defense-in-depth fallback when the stored value is missing.
 * Returns `undefined` for non-Codex providers (the field is unused there).
 *
 * Always prefers the freshly-decoded JWT over the stored value — Codex
 * re-issues a JWT on every token rotation, so the wire token is the source
 * of truth. Falls back to stored only when the JWT is unparseable (which
 * shouldn't happen for genuine Codex tokens). Logs once at warn level when
 * both sources fail to surface an id (visibility on broken rows).
 */
function resolveCodexAccountId(
  providerId: string,
  accessToken: string,
  stored: string | undefined,
  credentialId: string,
): string | undefined {
  if (providerId !== "codex") return undefined;
  const decoded = decodeCodexJwtPayload(accessToken);
  const fromJwt = decoded?.chatgpt_account_id;
  if (fromJwt) return fromJwt;
  if (stored) return stored;
  logger.warn("oauth model provider: accountId missing in stored creds", {
    credentialId,
    providerId,
    jwtParsed: decoded !== null,
  });
  return undefined;
}

/** Map registry config + fresh token material to the sidecar's wire shape. */
function toResolvedToken(
  config: ModelProviderConfig,
  accessToken: string,
  expiresAt: number | null,
  accountId: string | undefined,
): ResolvedToken {
  return {
    accessToken,
    expiresAt,
    apiShape: config.apiShape,
    baseUrl: config.defaultBaseUrl,
    rewriteUrlPath: config.rewriteUrlPath,
    forceStream: config.forceStream,
    forceStore: config.forceStore,
    accountId,
    providerId: config.providerId,
  };
}

function buildResolvedToken(state: CredentialState): ResolvedToken {
  const accountId = resolveCodexAccountId(
    state.config.providerId,
    state.blob.accessToken,
    state.blob.accountId,
    state.credentialId,
  );
  return toResolvedToken(state.config, state.blob.accessToken, state.blob.expiresAt, accountId);
}

/**
 * Resolve a fresh access token for the sidecar. Refreshes proactively if
 * the token expires within {@link REFRESH_LEAD_MS}.
 *
 * Throws `gone(needsReconnection: true)` when the credential is flagged as
 * needing reconnection — sidecar surfaces this as 401 to the agent.
 */
export async function resolveOAuthTokenForSidecar(credentialId: string): Promise<ResolvedToken> {
  const state = await loadCredentialState(credentialId);
  if (state.blob.needsReconnection) {
    throw gone(
      "OAUTH_CONNECTION_NEEDS_RECONNECTION",
      `OAuth credential ${credentialId} needs reconnection`,
    );
  }

  const expiresInMs = state.blob.expiresAt ? state.blob.expiresAt - Date.now() : 0;
  if (state.blob.expiresAt && expiresInMs > REFRESH_LEAD_MS) {
    return buildResolvedToken(state);
  }

  return forceRefreshOAuthModelProviderToken(credentialId);
}

/**
 * Force a refresh of the access token regardless of expiry. Singleflighted
 * per-credential. On `invalid_grant` (refresh token revoked), flips
 * `needsReconnection=true` on the row and throws `gone()`.
 */
export async function forceRefreshOAuthModelProviderToken(
  credentialId: string,
): Promise<ResolvedToken> {
  const inflight = inflightRefreshes.get(credentialId);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      return await doRefresh(credentialId);
    } finally {
      inflightRefreshes.delete(credentialId);
    }
  })();
  inflightRefreshes.set(credentialId, promise);
  return promise;
}

async function doRefresh(credentialId: string): Promise<ResolvedToken> {
  const state = await loadCredentialState(credentialId);
  if (state.blob.needsReconnection) {
    throw gone(
      "OAUTH_CONNECTION_NEEDS_RECONNECTION",
      `OAuth credential ${credentialId} needs reconnection`,
    );
  }
  if (!state.blob.refreshToken) {
    await markCredentialNeedsReconnection(state.orgId, credentialId);
    throw gone(
      "OAUTH_REFRESH_TOKEN_MISSING",
      `OAuth credential ${credentialId} has no refresh_token — cannot refresh`,
    );
  }

  const tokenUrl = state.config.oauth!.refreshUrl;
  const clientId = state.config.oauth!.clientId;

  const tokenParams: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: state.blob.refreshToken,
    client_id: clientId,
  };

  let response: Response;
  try {
    response = await fetch(tokenUrl, {
      method: "POST",
      headers: buildTokenHeaders(undefined, clientId, "", undefined),
      body: buildTokenBody(tokenParams),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(
      `Token refresh network error for '${state.config.providerId}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!response.ok) {
    const text = await response.text();
    const classification = parseTokenErrorResponse(response.status, text);
    if (classification.kind === "revoked") {
      await markCredentialNeedsReconnection(state.orgId, credentialId);
      throw gone(
        "OAUTH_REFRESH_REVOKED",
        `OAuth refresh revoked for ${state.config.providerId} (${credentialId}): ${
          classification.error ?? "invalid_grant"
        }`,
      );
    }
    throw new Error(
      `Token refresh failed for '${state.config.providerId}': ${
        classification.error ?? `HTTP ${response.status}`
      }`,
    );
  }

  let data: Record<string, unknown>;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new Error(`Refresh returned non-JSON response for '${state.config.providerId}'`);
  }

  // Preserve the existing refresh_token if the provider didn't return a new
  // one (Anthropic does, OpenAI rotates them too, but be defensive).
  const parsed = parseTokenResponse(data, undefined, state.blob.refreshToken);

  const accountId = resolveCodexAccountId(
    state.config.providerId,
    parsed.accessToken,
    state.blob.accountId,
    credentialId,
  );
  const expiresAtMs = parsed.expiresAt ? new Date(parsed.expiresAt).getTime() : null;
  await updateOAuthCredentialTokens(state.orgId, credentialId, {
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken ?? state.blob.refreshToken,
    expiresAt: expiresAtMs,
    ...(accountId ? { accountId } : {}),
  });

  return toResolvedToken(state.config, parsed.accessToken, expiresAtMs, accountId);
}

/**
 * Lookup helper used by the internal sidecar route to confirm the requested
 * credentialId is one this platform manages (not an arbitrary UUID guess).
 * Returns true iff the row exists in `model_provider_credentials`.
 */
export async function isConnectionUsedByModelProviderKey(credentialId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: modelProviderCredentials.id })
    .from(modelProviderCredentials)
    .where(eq(modelProviderCredentials.id, credentialId))
    .limit(1);
  return Boolean(row);
}
