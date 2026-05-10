// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth Model Providers — token resolution and refresh.
 *
 * Backs the `/internal/oauth-token/:connectionId(/refresh)?` routes that
 * the sidecar polls during `/llm/*` request lifecycle (cf. SPEC §5.2).
 *
 * Concurrency: a single in-process `Map<connectionId, Promise<...>>`
 * mutex serializes refresh attempts for the same connection — multiple
 * sidecars hitting the API at the same time can each end up calling
 * the provider, so this singleflight is best-effort defense in depth
 * (the sidecar's own cache provides the primary deduplication).
 */

import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  applicationProviderCredentials,
  orgSystemProviderKeys,
  userProviderConnections,
} from "@appstrate/db/schema";
import {
  decryptCredentials,
  encryptCredentials,
  parseTokenResponse,
  parseTokenErrorResponse,
  buildTokenHeaders,
  buildTokenBody,
} from "@appstrate/connect";
import { decodeCodexJwtPayload, type OAuthModelProviderCredentials } from "./credentials.ts";
import {
  CODEX_PACKAGE_ID,
  getOAuthModelProviderConfig,
  OAUTH_MODEL_PROVIDER_TOKEN_URLS,
  type OAuthModelProviderConfig,
} from "./registry.ts";
import { gone, notFound } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";

/** Refresh `expiresAt` lead time. Mirrors the sidecar threshold (SPEC §5.2). */
const REFRESH_LEAD_MS = 5 * 60_000;

/**
 * Per-provider token endpoint. Sourced from the registry so the CLI loopback
 * helper (`apps/cli/src/commands/connect.ts`) and the platform-side refresh
 * worker can never drift — a wrong host returns a non-canonical schema and
 * silently breaks refresh (cf. the `claude.ai` vs `platform.claude.com`
 * regression caught in PR #397).
 */
const PROVIDER_TOKEN_URL = OAUTH_MODEL_PROVIDER_TOKEN_URLS;

const inflightRefreshes = new Map<string, Promise<ResolvedToken>>();

export interface ResolvedToken {
  accessToken: string;
  /** Epoch milliseconds. `null` when the token's expiry is unknown — sidecar treats this as "always refresh". */
  expiresAt: number | null;
  apiShape: "anthropic-messages" | "openai-responses";
  baseUrl: string;
  rewriteUrlPath?: { from: string; to: string };
  forceStream?: boolean;
  forceStore?: boolean;
  /** Codex only — extracted from JWT, used as `chatgpt-account-id` header by the sidecar. */
  accountId?: string;
  providerPackageId: string;
}

/** Connection row + decrypted creds. Internal helper return shape. */
interface ConnectionState {
  connectionId: string;
  providerPackageId: string;
  applicationId: string;
  expiresAt: Date | null;
  needsReconnection: boolean;
  creds: OAuthModelProviderCredentials;
  config: OAuthModelProviderConfig;
}

async function loadConnectionState(connectionId: string): Promise<ConnectionState> {
  const [row] = await db
    .select({
      id: userProviderConnections.id,
      providerId: userProviderConnections.providerId,
      providerCredentialId: userProviderConnections.providerCredentialId,
      credentialsEncrypted: userProviderConnections.credentialsEncrypted,
      expiresAt: userProviderConnections.expiresAt,
      needsReconnection: userProviderConnections.needsReconnection,
    })
    .from(userProviderConnections)
    .where(eq(userProviderConnections.id, connectionId))
    .limit(1);
  if (!row) {
    throw notFound(`OAuth model provider connection not found: ${connectionId}`);
  }

  const config = getOAuthModelProviderConfig(row.providerId);
  if (!config) {
    throw notFound(
      `Connection ${connectionId} references unknown provider package ${row.providerId}`,
    );
  }

  // Resolve applicationId via the seeded credential row — the connection's
  // `providerCredentialId` always points to a row created at init time.
  const [credRow] = await db
    .select({ applicationId: applicationProviderCredentials.applicationId })
    .from(applicationProviderCredentials)
    .where(eq(applicationProviderCredentials.id, row.providerCredentialId))
    .limit(1);
  if (!credRow) {
    throw notFound(`Application provider credential ${row.providerCredentialId} not found`);
  }

  const creds = decryptCredentials<OAuthModelProviderCredentials>(row.credentialsEncrypted);

  return {
    connectionId: row.id,
    providerPackageId: row.providerId,
    applicationId: credRow.applicationId,
    expiresAt: row.expiresAt,
    needsReconnection: row.needsReconnection,
    creds,
    config,
  };
}

/**
 * Build a `ResolvedToken` from a connection state + freshly-resolved
 * access token + expiry. Centralizes the registry → wire shape mapping
 * shared by the read path and the refresh path.
 */
function toResolvedToken(
  state: ConnectionState,
  accessToken: string,
  expiresAt: Date | null,
  accountId: string | undefined,
): ResolvedToken {
  return {
    accessToken,
    expiresAt: expiresAt ? expiresAt.getTime() : null,
    apiShape: state.config.api.apiShape,
    baseUrl: state.config.api.baseUrl,
    rewriteUrlPath: state.config.api.rewriteUrlPath,
    forceStream: state.config.api.forceStream,
    forceStore: state.config.api.forceStore,
    accountId,
    providerPackageId: state.providerPackageId,
  };
}

/**
 * Resolve `chatgpt_account_id` for a Codex connection, with JWT fallback.
 *
 * Connections imported before the CLI started forwarding pi-ai's
 * `accountId` may have `chatgpt_account_id = null` in storage — try a
 * JWT decode as defense in depth so existing connections don't need a
 * reconnect to keep working. Returns `undefined` for non-Codex providers.
 */
function resolveCodexAccountId(
  providerPackageId: string,
  accessToken: string,
  stored: string | undefined,
  connectionId: string,
): string | undefined {
  if (providerPackageId !== CODEX_PACKAGE_ID) return stored;
  if (stored) return stored;
  const decoded = decodeCodexJwtPayload(accessToken);
  if (!decoded?.chatgpt_account_id) {
    logger.debug("oauth model provider: chatgpt_account_id missing in stored creds", {
      connectionId,
      providerPackageId,
      jwtParsed: decoded !== null,
    });
  }
  return decoded?.chatgpt_account_id;
}

/**
 * Resolve a fresh access token for the sidecar. Refreshes proactively
 * if the token expires within {@link REFRESH_LEAD_MS}.
 *
 * Throws `gone(needsReconnection: true)` when the connection is flagged
 * as needing reconnection — sidecar surfaces this as 401 to the agent.
 */
export async function resolveOAuthTokenForSidecar(connectionId: string): Promise<ResolvedToken> {
  const state = await loadConnectionState(connectionId);
  if (state.needsReconnection) {
    throw gone(
      "OAUTH_CONNECTION_NEEDS_RECONNECTION",
      `OAuth connection ${connectionId} needs reconnection`,
    );
  }

  const expiresInMs = state.expiresAt ? state.expiresAt.getTime() - Date.now() : 0;
  if (state.expiresAt && expiresInMs > REFRESH_LEAD_MS) {
    const accountId = resolveCodexAccountId(
      state.providerPackageId,
      state.creds.access_token,
      state.creds.chatgpt_account_id,
      state.connectionId,
    );
    return toResolvedToken(state, state.creds.access_token, state.expiresAt, accountId);
  }

  // Trigger refresh
  return forceRefreshOAuthModelProviderToken(connectionId);
}

/**
 * Force a refresh of the access token regardless of expiry. Singleflighted
 * per-connection. On `invalid_grant` (refresh token revoked), flips
 * `needsReconnection=true` and throws `gone()`.
 */
export async function forceRefreshOAuthModelProviderToken(
  connectionId: string,
): Promise<ResolvedToken> {
  const inflight = inflightRefreshes.get(connectionId);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      return await doRefresh(connectionId);
    } finally {
      inflightRefreshes.delete(connectionId);
    }
  })();
  inflightRefreshes.set(connectionId, promise);
  return promise;
}

async function doRefresh(connectionId: string): Promise<ResolvedToken> {
  const state = await loadConnectionState(connectionId);
  if (state.needsReconnection) {
    throw gone(
      "OAUTH_CONNECTION_NEEDS_RECONNECTION",
      `OAuth connection ${connectionId} needs reconnection`,
    );
  }
  if (!state.creds.refresh_token) {
    await markNeedsReconnection(connectionId);
    throw gone(
      "OAUTH_REFRESH_TOKEN_MISSING",
      `OAuth connection ${connectionId} has no refresh_token — cannot refresh`,
    );
  }

  const tokenUrl = PROVIDER_TOKEN_URL[state.providerPackageId];
  if (!tokenUrl) {
    throw notFound(
      `No token URL registered for ${state.providerPackageId}. Update PROVIDER_TOKEN_URL.`,
    );
  }

  const tokenParams: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: state.creds.refresh_token,
    client_id: state.config.clientId,
  };

  let response: Response;
  try {
    response = await fetch(tokenUrl, {
      method: "POST",
      headers: buildTokenHeaders(undefined, state.config.clientId, "", undefined),
      body: buildTokenBody(tokenParams),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(
      `Token refresh network error for '${state.providerPackageId}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!response.ok) {
    const text = await response.text();
    const classification = parseTokenErrorResponse(response.status, text);
    if (classification.kind === "revoked") {
      await markNeedsReconnection(connectionId);
      throw gone(
        "OAUTH_REFRESH_REVOKED",
        `OAuth refresh revoked for ${state.providerPackageId} (${connectionId}): ${
          classification.error ?? "invalid_grant"
        }`,
      );
    }
    throw new Error(
      `Token refresh failed for '${state.providerPackageId}': ${
        classification.error ?? `HTTP ${response.status}`
      }`,
    );
  }

  let data: Record<string, unknown>;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new Error(`Refresh returned non-JSON response for '${state.providerPackageId}'`);
  }

  // Preserve the existing refresh_token if the provider didn't return a new one
  // (Anthropic does, OpenAI rotates them too, but be defensive).
  const parsed = parseTokenResponse(data, undefined, state.creds.refresh_token);

  // Re-extract account_id on Codex in case of token rotation. Prefer the
  // freshly-decoded JWT, fall back to the stored value.
  const accountId = resolveCodexAccountId(
    state.providerPackageId,
    parsed.accessToken,
    state.creds.chatgpt_account_id,
    connectionId,
  );

  const newCreds: OAuthModelProviderCredentials = {
    ...state.creds,
    access_token: parsed.accessToken,
    refresh_token: parsed.refreshToken ?? state.creds.refresh_token,
    ...(accountId ? { chatgpt_account_id: accountId } : {}),
  };
  const expiresAt = parsed.expiresAt ? new Date(parsed.expiresAt) : null;

  await db
    .update(userProviderConnections)
    .set({
      credentialsEncrypted: encryptCredentials(newCreds as unknown as Record<string, unknown>),
      expiresAt,
      needsReconnection: false,
      updatedAt: new Date(),
    })
    .where(eq(userProviderConnections.id, connectionId));

  return toResolvedToken(state, parsed.accessToken, expiresAt, accountId);
}

async function markNeedsReconnection(connectionId: string): Promise<void> {
  await db
    .update(userProviderConnections)
    .set({ needsReconnection: true, updatedAt: new Date() })
    .where(eq(userProviderConnections.id, connectionId));
}

/**
 * Lookup helper: given a connectionId referenced by an `orgSystemProviderKeys`
 * row in `authMode='oauth'`, returns whether such a key exists. Used by the
 * internal endpoint to confirm the sidecar is asking about a token that
 * belongs to a configured model provider (not an arbitrary connection).
 */
export async function isConnectionUsedByModelProviderKey(connectionId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: orgSystemProviderKeys.id })
    .from(orgSystemProviderKeys)
    .where(eq(orgSystemProviderKeys.oauthConnectionId, connectionId))
    .limit(1);
  return Boolean(row);
}
