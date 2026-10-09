// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth2 token refresh for `integration_connections` rows, and the one decision over a connection
 * whose credential is due for refresh ({@link refreshConnectionCredential}). The token exchange is
 * `performRefreshTokenExchange` (`@appstrate/connect`); `dedupedRefresh` (`lib/deduped-refresh.ts`)
 * serializes the refreshes of one connection, in process and across instances.
 *
 * Lives in apps/api rather than packages/connect because `integration_connections` is
 * platform-internal: connect stays free of `@appstrate/db` so the sidecar can consume it.
 */

import { eq } from "drizzle-orm";
import { integrationConnections } from "@appstrate/db/schema";
import { db } from "@appstrate/db/client";
import {
  RefreshError,
  ClientAuthInvariantError,
  performRefreshTokenExchange,
  decryptCredentialsToStringMap,
  resolveOAuthEndpoints,
  UnknownKeyIdError,
} from "@appstrate/connect";
import type {
  RefreshContext as IntegrationRefreshContext,
  RefreshExchangeResult,
} from "@appstrate/connect";
import type { AfpsManifestAuth } from "./integration-manifest-helpers.ts";
import { isVariableTemplate } from "@appstrate/afps-shared/connection-variables";
import { scopesNotCovered, type IntegrationManifest } from "@appstrate/core/integration";
import type { Actor } from "../lib/actor.ts";
import type { SpaceScope } from "../lib/scope.ts";
import { logger } from "../lib/logger.ts";
import { dedupedRefresh } from "../lib/deduped-refresh.ts";
import { encryptionKeyUnavailable } from "../lib/stored-credential.ts";
import { OAUTH_REFRESH_LEAD_MS } from "@appstrate/core/sidecar-types";
import {
  persistCredentialBundle,
  markIntegrationConnectionNeedsReconnection,
  recordIntegrationRefreshFailure,
  recordUnrefreshableRejection,
  resolveIntegrationClientById,
} from "./integration-connections.ts";
import { computeRequiredScopes } from "./integration-scope-resolver.ts";
import { checkEgressUrl } from "../lib/egress-host-guard.ts";
import { getEnv } from "@appstrate/env";
import { getErrorMessage } from "@appstrate/core/errors";

interface IntegrationRefreshResult {
  /** Decrypted credentials — snake_case wire keys only (`projectToStringMap`). */
  fields: Record<string, string>;
  /** Parsed `expires_at` from the token response, or `null` if upstream did not return `expires_in`. */
  expiresAt: Date | null;
  /**
   * Scope set the IdP authoritatively granted on this refresh (its response's `scope`). `null`
   * when the response omitted `scope` — per OAuth 2 §5.1 "same scopes as previously issued", so
   * never "no scopes granted".
   */
  scopesGranted: string[] | null;
  /**
   * `true` when {@link scopesGranted} is non-null AND strictly narrower than the connection's
   * previously stored `scopesGranted`: {@link refreshConnectionCredential} then re-checks the
   * space's required scopes.
   */
  shrinkDetected: boolean;
}

/**
 * The connection's credential can never be used again, and the connection is flagged
 * `needsReconnection`. `flaggedBefore`: the flag was already set when the refresh took the lock.
 * `reason` is surfaced verbatim in the 410.
 */
class DeadCredentialError extends Error {
  readonly flaggedBefore: boolean;
  constructor(
    readonly reason: string,
    options: { flaggedBefore?: boolean; cause?: unknown } = {},
  ) {
    super(reason, { cause: options.cause });
    this.name = "DeadCredentialError";
    this.flaggedBefore = options.flaggedBefore ?? false;
  }
}

/**
 * A connection as its caller read it. The refresh context was built from its upstream (`clientRef`,
 * `oauthResource`; a reconnect cannot move its variables to another instance, AFPS §7.12), so the
 * refresh runs only while the row, re-read under the lock, still names that upstream.
 */
export interface RefreshTarget {
  id: string;
  credentialsEncrypted: string;
  clientRef: string | null;
  oauthResource: string | null;
}

/**
 * Refresh the OAuth2 access token of a connection under `dedupedRefresh`, and write it back.
 * Throws {@link DeadCredentialError} (flagged), `RefreshError` (`revoked`: flagged; `transient`:
 * counted or untouched), or any other error as is.
 *
 * `forced` (an upstream 401): the freshness short-circuit after the lock is skipped.
 */
async function refreshUnderLock(
  connection: RefreshTarget,
  packageIdForLog: string,
  authKeyForLog: string,
  refreshContext: IntegrationRefreshContext,
  forced: boolean,
): Promise<IntegrationRefreshResult> {
  const { id: connectionId, credentialsEncrypted } = connection;

  let freshCiphertext = credentialsEncrypted;
  // Callers that read different upstreams of the row never share a flight's result.
  const upstream = JSON.stringify([connection.clientRef, connection.oauthResource]);
  return dedupedRefresh<IntegrationRefreshResult>(`${connectionId}:${upstream}`, {
    lockKey: `intg-refresh:${connectionId}`,
    lockLabel: "intg-refresh",
    force: forced,
    reReadFreshness: async ({ force }) => {
      const [row] = await db
        .select({
          credentialsEncrypted: integrationConnections.credentialsEncrypted,
          expiresAt: integrationConnections.expiresAt,
          clientRef: integrationConnections.clientRef,
          oauthResource: integrationConnections.oauthResource,
          needsReconnection: integrationConnections.needsReconnection,
        })
        .from(integrationConnections)
        .where(eq(integrationConnections.id, connectionId))
        .limit(1);
      if (row?.needsReconnection) {
        // A flagged row's write-back cannot land: an exchange would only spend its refresh token.
        throw new DeadCredentialError("the connection is flagged needsReconnection", {
          flaggedBefore: true,
        });
      }
      if (
        !row ||
        row.clientRef !== connection.clientRef ||
        row.oauthResource !== connection.oauthResource
      ) {
        throw new RefreshError(
          `Integration connection '${connectionId}' was reconnected or removed while its refresh waited (transient)`,
          "transient",
        );
      }
      // Read even when forced: the exchange must spend the freshest stored refresh_token.
      freshCiphertext = row.credentialsEncrypted;
      if (force) return null;
      if (row.expiresAt && row.expiresAt.getTime() - Date.now() > OAUTH_REFRESH_LEAD_MS) {
        return {
          fields: decryptCredentialsToStringMap(row.credentialsEncrypted),
          expiresAt: row.expiresAt,
          scopesGranted: null,
          shrinkDetected: false,
        };
      }
      return null;
    },
    doRefresh: () =>
      doRefresh(
        { connectionId, clientRef: connection.clientRef },
        packageIdForLog,
        authKeyForLog,
        freshCiphertext,
        refreshContext,
      ),
  });
}

async function doRefresh(
  { connectionId, clientRef }: { connectionId: string; clientRef: string | null },
  packageId: string,
  authKey: string,
  credentialsEncrypted: string,
  ctx: IntegrationRefreshContext,
): Promise<IntegrationRefreshResult> {
  const current = decryptCredentialsToStringMap(credentialsEncrypted);
  const refreshToken = current.refresh_token;
  if (!refreshToken) {
    // A refresh is warranted (expiring, or a 401) and nothing can perform it. Throw rather than
    // serve the stored token: the sidecar would re-inject the credential that 401'd and answer
    // 200, contradicting the flag. (Google issues none without `access_type=offline`, see
    // `auths.{key}.authorizationParams`.)
    logger.warn(
      "Integration connection unrefreshable — no refresh_token; flagging needsReconnection",
      {
        packageId,
        authKey,
        connectionId,
      },
    );
    await markIntegrationConnectionNeedsReconnection(connectionId);
    throw new DeadCredentialError("no stored refresh_token");
  }

  let parsed: RefreshExchangeResult["parsed"];
  let tokenData: Record<string, unknown>;
  try {
    ({ parsed, raw: tokenData } = await performRefreshTokenExchange(ctx, refreshToken, {
      label: `Integration token refresh for '${packageId}' auth '${authKey}'`,
    }));
  } catch (err) {
    if (err instanceof ClientAuthInvariantError) {
      // A contradictory (method, secret) pair is a configuration/programming
      // fault, not an upstream blip. Counting it toward the transient-failure
      // streak would spend a healthy connection's budget and eventually flag it
      // `needs_reconnection` — user-visible damage from a code bug, with the
      // real cause buried in the logs. Surface it and leave the row alone.
      logger.error("Integration refresh aborted — incoherent client auth", {
        packageId,
        authKey,
        connectionId,
        err: String(err),
      });
    } else if (err instanceof RefreshError && err.kind === "revoked") {
      await markIntegrationConnectionNeedsReconnection(connectionId);
    } else {
      // A single transient failure is not terminal — the cached token may still be valid. A
      // streak past the threshold on a token expired past the grace window is: the row would
      // otherwise look healthy while every call fails.
      const env = getEnv();
      const counted = await recordIntegrationRefreshFailure(
        connectionId,
        env.INTEGRATION_REFRESH_MAX_FAILURES,
        { graceSeconds: env.INTEGRATION_REFRESH_GRACE_SECONDS },
      );
      if (counted?.needsReconnection) {
        throw new DeadCredentialError(
          `token refresh failed ${counted.failures} consecutive times and the token has expired`,
          { cause: err },
        );
      }
    }
    throw err;
  }

  // `parseTokenResponse` may return `undefined` for refreshToken on flows
  // that don't rotate it — preserve whatever the current ciphertext held in
  // that case so the next refresh still works.
  const finalRefreshToken = parsed.refreshToken ?? refreshToken;
  const expiresAt = parsed.expiresAt ? new Date(parsed.expiresAt) : null;

  // Only an explicitly echoed `scope` is authoritative: `parseTokenResponse` falls back to the
  // requested scopes (here `[]`) when the response omits it, which would falsely signal a total
  // revocation.
  const responseHadScopeField = typeof tokenData.scope === "string" && tokenData.scope.length > 0;
  const responseScopes = responseHadScopeField ? parsed.scopesGranted : null;

  // The stored outputs, with what this response carries: a field the IdP does not
  // send again (`token_type`, `id_token`, `scope`) keeps the value the connect stored.
  const newCreds: Record<string, string> = {
    ...current,
    access_token: parsed.accessToken,
    refresh_token: finalRefreshToken,
    ...(typeof tokenData.token_type === "string" ? { token_type: tokenData.token_type } : {}),
    ...(typeof tokenData.id_token === "string" ? { id_token: tokenData.id_token } : {}),
    ...(responseScopes !== null ? { scope: responseScopes.join(" ") } : {}),
  };

  // Read the existing `scopes_granted` so we can detect shrinkage. One
  // extra SELECT per refresh is acceptable — refresh is the slow path.
  const [prevRow] = await db
    .select({ scopesGranted: integrationConnections.scopesGranted })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId))
    .limit(1);
  const prevScopes = prevRow?.scopesGranted ?? [];
  const shrinkDetected =
    responseScopes !== null && responseScopes.length > 0
      ? prevScopes.some((s) => !responseScopes.includes(s))
      : false;

  // Converged write — the single credential writer. `scopesGranted` is passed
  // only when the IdP authoritatively echoed a `scope` field; otherwise it is
  // omitted so persistCredentialBundle leaves the high-water-mark untouched.
  // accountId/identityClaims are likewise omitted → never clobbered by refresh.
  // Compare-and-set: a row reconnected (or flagged) meanwhile keeps what it holds.
  const written = await persistCredentialBundle(
    { kind: "update-by-id", connectionId, expect: { clientRef, credentialsEncrypted } },
    {
      credentials: newCreds,
      expiresAt,
      needsReconnection: false,
      ...(responseScopes !== null ? { scopesGranted: responseScopes } : {}),
    },
  );
  if (!written) {
    const [row] = await db
      .select({ needsReconnection: integrationConnections.needsReconnection })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connectionId))
      .limit(1);
    if (row?.needsReconnection) {
      throw new DeadCredentialError(
        "the connection was flagged needsReconnection during the refresh",
      );
    }
    throw new RefreshError(
      `Integration connection '${connectionId}' changed while its token was refreshed (transient)`,
      "transient",
    );
  }

  return { fields: newCreds, expiresAt, scopesGranted: responseScopes, shrinkDetected };
}

/**
 * What {@link refreshConnectionCredential} concluded about a connection's credential. Each caller
 * only translates it (the sidecar credentials resolver → 200/502/410, the credential proxy →
 * replay/relay the 401); what was written to the connection row is already written.
 *
 * - `refreshed`: a new credential is stored — or, on a proactive refresh, a peer's fresher one
 *   was read back. If the refresh narrowed the grant below the space's required scopes, the
 *   connection is already flagged `needsReconnection`; the credential is still served.
 * - `kept`: nothing concluded against the stored credential, which stands — a proactive refresh
 *   that was not due or could not run (already flagged, no refresh client, a non-oauth2 auth, a
 *   transient token-endpoint discovery failure), or a rejection of a credential the connection no
 *   longer holds.
 * - `retry`: not refreshed now, the connection stays usable — a transient failure (discovery,
 *   network, upstream 5xx, parse, a row reconnected meanwhile), or an upstream rejection of an
 *   unrefreshable auth counted below `INTEGRATION_REFRESH_MAX_FAILURES`. `reason` completes
 *   "Integration 'x' auth 'y' …".
 * - `dead`: the credential can never be used again and the connection is flagged
 *   `needsReconnection` — already flagged, refresh token revoked upstream (RFC 6749 §5.2
 *   `invalid_grant`), no stored `refresh_token`, transient failures escalated past the threshold,
 *   or an unrefreshable auth rejected up to the threshold. `reason` names the cause, never blaming
 *   a revocation that did not happen.
 *
 * `detail` carries the underlying error, for logs only.
 */
type ConnectionRefreshOutcome =
  | { status: "refreshed"; fields: Record<string, string>; expiresAt: Date | null }
  | { status: "kept"; reason: string; detail?: string }
  | { status: "retry"; reason: string; detail?: string }
  | { status: "dead"; reason: string; detail?: string };

/** Why a caller asks for a connection's credential to be refreshed. */
export type RefreshTrigger =
  /** A read: the stored credential is refreshed only once it nears expiry. */
  | { kind: "expiring" }
  /**
   * Upstream rejected the credential of `revision` (its `credential_revision`); `null` when the
   * caller cannot name it, and the rejection then concerns the credential the connection holds.
   */
  | { kind: "rejected"; revision: string | null };

/**
 * The one decision over a connection's credential: refresh it, keep it, retry later, or declare it
 * dead. A rejection is evidence only against the credential it names: one the connection no longer
 * holds is treated as a read, and nothing is counted.
 *
 * Builds the refresh context from the connection's pinned client, refreshes, classifies the
 * failure, and checks a narrowed grant against the space's scope floor — on every path, since the
 * refresh that narrows `scopes_granted` is the only one that can see the shrink. A rejection
 * nothing can refresh (not oauth2, no client, no token endpoint) is counted by
 * `recordUnrefreshableRejection` while `actor` still reaches the connection and it still holds
 * that credential.
 *
 * Throws the 503 of a key id missing from the keyring, and any error that is not a verdict on the
 * connection (a database fault, an incoherent client auth). A scope-floor check that fails is
 * logged; the refreshed credential is still returned.
 */
export async function refreshConnectionCredential(input: {
  connection: RefreshTarget & {
    authKey: string;
    expiresAt: Date | null;
    credentialRevision: string;
  };
  integrationId: string;
  /** The manifest the caller reads the connection's auth from, and `authDef` its declaration. */
  manifest: IntegrationManifest;
  authDef: AfpsManifestAuth;
  scope: SpaceScope;
  actor: Actor;
  trigger: RefreshTrigger;
}): Promise<ConnectionRefreshOutcome> {
  const { connection, integrationId, authDef, scope, actor, trigger } = input;
  const { authKey } = connection;
  const forced =
    trigger.kind === "rejected" &&
    (trigger.revision === null || trigger.revision === connection.credentialRevision);
  if (!forced && !expiresWithinLeadWindow(connection.expiresAt)) {
    return { status: "kept", reason: "not due for refresh" };
  }

  // One 401 can be a transient upstream fault, or a permission error the agent provoked, so a
  // forced refresh nothing can perform is counted: `retry` until the threshold, then `dead`.
  const unrefreshable = async (why: string): Promise<ConnectionRefreshOutcome> => {
    if (!forced) return { status: "kept", reason: why };
    const counted = await recordUnrefreshableRejection(
      connection.id,
      integrationId,
      { spaceId: scope.spaceId, actor },
      connection.credentialRevision,
    );
    if (!counted) return { status: "kept", reason: "the rejected credential was replaced" };
    if (counted.needsReconnection) return { status: "dead", reason: why };
    return {
      status: "retry",
      reason:
        `was rejected upstream (${why}); ` +
        `${counted.failures}/${counted.maxFailures} consecutive upstream rejections before it is flagged`,
    };
  };

  if (authDef.type !== "oauth2") {
    return unrefreshable(`auth type '${authDef.type}' is not refreshable`);
  }

  let refreshContext: IntegrationRefreshContext | null;
  try {
    refreshContext = await buildIntegrationOAuthRefreshContext(
      integrationId,
      authKey,
      authDef,
      scope.spaceId,
      connection,
    );
  } catch (err) {
    if (!(err instanceof RefreshError && err.kind === "transient")) throw err;
    // Never terminal: the row stays untouched and the next attempt re-discovers. A proactive
    // refresh has no evidence against the stored token, so it keeps serving it.
    return {
      status: forced ? "retry" : "kept",
      reason: "token endpoint discovery failed (transient)",
      detail: err.message,
    };
  }
  if (!refreshContext) return unrefreshable("no OAuth client or token endpoint");

  let refreshed: IntegrationRefreshResult;
  try {
    refreshed = await refreshUnderLock(connection, integrationId, authKey, refreshContext, forced);
  } catch (err) {
    if (err instanceof DeadCredentialError) {
      // A proactive refresh has no evidence against the token a flag set elsewhere left in place.
      if (err.flaggedBefore && !forced) return { status: "kept", reason: err.reason };
      return {
        status: "dead",
        reason: err.reason,
        ...(err.cause !== undefined ? { detail: getErrorMessage(err.cause) } : {}),
      };
    }
    if (err instanceof RefreshError) {
      if (err.kind === "revoked") {
        return { status: "dead", reason: "refresh token revoked", detail: err.message };
      }
      return {
        status: "retry",
        reason: "token refresh failed upstream (transient)",
        detail: err.message,
      };
    }
    if (err instanceof UnknownKeyIdError) {
      throw encryptionKeyUnavailable(err, {
        connectionId: connection.id,
        packageId: integrationId,
        authKey,
      });
    }
    throw err;
  }

  if (refreshed.shrinkDetected && refreshed.scopesGranted !== null) {
    // The new token is already stored: a failed floor check must not turn it into a failure.
    try {
      await flagScopeShrinkBelowFloor(input, refreshed.scopesGranted);
    } catch (err) {
      logger.error("Integration scope-floor check failed after a refresh", {
        integrationId,
        authKey,
        connectionId: connection.id,
        error: getErrorMessage(err),
      });
    }
  }
  return { status: "refreshed", fields: refreshed.fields, expiresAt: refreshed.expiresAt };
}

function expiresWithinLeadWindow(expiresAt: Date | null): boolean {
  return expiresAt !== null && expiresAt.getTime() - Date.now() < OAUTH_REFRESH_LEAD_MS;
}

/**
 * IdP-side scope shrink (the user revoked some permissions upstream between issuance and
 * refresh): flags `needsReconnection` when what remains no longer covers the union of
 * `requiredScopes` across the space's active agents.
 */
async function flagScopeShrinkBelowFloor(
  input: {
    connection: { id: string; authKey: string };
    integrationId: string;
    manifest: IntegrationManifest;
    scope: SpaceScope;
  },
  granted: string[],
): Promise<void> {
  const { connection, integrationId, manifest, scope } = input;
  const { authKey } = connection;
  const { required } = await computeRequiredScopes({ scope, integrationId, authKey });
  // Diff through the manifest `implies` hierarchy: a parent grant (e.g. GitHub `repo`) covers
  // the children it implies (`public_repo`).
  const missing = scopesNotCovered(required, granted, manifest, authKey);
  if (missing.length > 0) {
    await markIntegrationConnectionNeedsReconnection(connection.id);
    logger.warn("Integration scope shrink dropped below required floor", {
      integrationId,
      authKey,
      connectionId: connection.id,
      granted,
      required,
      missing,
    });
  } else {
    logger.info("Integration scope shrink absorbed (still covers required)", {
      integrationId,
      authKey,
      connectionId: connection.id,
      granted,
      required,
    });
  }
}

/**
 * Build the OAuth2 {@link IntegrationRefreshContext} for an integration
 * auth from the connection's pinned client (system, org or space). Returns
 * `null` (the auth is not refreshable) for: non-oauth2 auths, auths without a
 * `tokenUrl`, a pinned client that no longer resolves, and an unreadable client secret
 * (a missing key throws the 503).
 *
 * Public clients (`token_endpoint_auth_method: "none"`, RFC 7591 §2) ARE
 * supported — the refresh helper sends `client_id` in the body with no
 * `client_secret` (RFC 6749 §6 + §3.2.1). Single source of truth, read by
 * {@link refreshConnectionCredential}.
 */
export async function buildIntegrationOAuthRefreshContext(
  packageId: string,
  authKey: string,
  authDef: AfpsManifestAuth,
  spaceId: string,
  /** The minting client (`client_ref`) and RFC 8707 `resource` pinned on the connection. */
  connection: { clientRef: string | null; oauthResource: string | null },
  /** Seam for tests. */
  discover: typeof resolveOAuthEndpoints = resolveOAuthEndpoints,
): Promise<IntegrationRefreshContext | null> {
  if (authDef.type !== "oauth2") return null;
  const { clientRef, oauthResource } = connection;

  // Resolve the SAME client that minted the connection by its pinned id (system
  // env or space/org custom row), with the cross-scope escalation guard.
  // Null → since-removed / remapped / cross-scope id: skip (needs_reconnection).
  const client =
    clientRef === null
      ? null
      : await resolveIntegrationClientById(
          clientRef,
          spaceId,
          packageId,
          authKey,
          authDef.token_endpoint_auth_method,
        );

  // AFPS §7.3: refresh POSTs to the token endpoint of the server the connection was acquired from —
  // the one its client is bound to (metadata only), else the manifest's, discovered from an
  // issuer-only declaration (Drive/OneDrive). A templated issuer names no server by itself.
  const boundIssuer = client?.issuer;
  const issuer = boundIssuer ?? (isVariableTemplate(authDef.issuer) ? undefined : authDef.issuer);
  const { tokenEndpoint } = await discover({
    issuer,
    ...(boundIssuer === undefined && !isVariableTemplate(authDef.issuer)
      ? { tokenEndpoint: authDef.token_endpoint }
      : {}),
  });
  if (!tokenEndpoint) {
    // An `issuer`-only manifest (Drive/OneDrive …) whose discovery yielded no
    // `token_endpoint` is NOT terminal — discovery is best-effort and a routine
    // IdP/network blip would otherwise brick refresh and falsely flag the
    // connection `needsReconnection`. Surface it as TRANSIENT so the caller
    // keeps the cached credential and retries later (resolveOAuthEndpoints no
    // longer negatively-caches, so the next attempt re-discovers). Only a
    // manifest with neither `issuer` NOR `token_endpoint` is genuinely
    // unrefreshable (terminal → null).
    if (issuer) {
      throw new RefreshError(
        `Integration '${packageId}' auth '${authKey}' token_endpoint discovery yielded none (transient)`,
        "transient",
      );
    }
    logger.info("Integration auth refresh skipped — no token_endpoint and no issuer", {
      packageId,
      authKey,
    });
    return null;
  }

  // A server chosen per connection is the user's (AFPS §8.7): its token endpoint is re-checked
  // (its metadata may have changed). An unresolvable host is a blip; any other refusal is terminal.
  if (boundIssuer !== undefined) {
    const egress = await checkEgressUrl(tokenEndpoint, { requireHttpsForUntrustedHost: true });
    if (!egress.ok) {
      if (egress.detail === "resolution-failed") {
        throw new RefreshError(
          `Integration '${packageId}' auth '${authKey}' token endpoint did not resolve (transient)`,
          "transient",
        );
      }
      logger.warn("Integration auth refresh skipped — token endpoint refused by egress controls", {
        packageId,
        authKey,
        tokenEndpoint,
        reason: egress.reason,
      });
      return null;
    }
  }

  // INVARIANT: an oauth2 connection always pins its minting client. A null here
  // means a non-oauth2 row reached this oauth2-only path — a bug, not a state to
  // tolerate. Skip safely (surfaces needs_reconnection at expiry) rather than
  // guessing a client.
  if (clientRef === null) {
    logger.warn("Integration oauth2 connection has no client_ref — skipping refresh", {
      packageId,
      authKey,
    });
    return null;
  }
  if (!client) {
    logger.info("Integration auth refresh skipped — pinned client unresolved", {
      packageId,
      authKey,
      clientRef,
    });
    return null;
  }
  // The resolver returns the method already paired with the secret it hands
  // back — a public client comes back as `"none"` with no secret — so refresh
  // posts what it was given rather than re-deriving from the manifest.
  const { issuer: _boundIssuer, ...credentials } = client;
  return {
    tokenEndpoint,
    ...credentials,
    ...(oauthResource !== null ? { resource: oauthResource } : {}),
  };
}
