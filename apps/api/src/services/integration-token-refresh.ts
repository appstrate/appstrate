// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 1.5 — OAuth refresh for `integration_connections` rows.
 *
 * Reuses the OAuth2 refresh contract from `@appstrate/connect/token-refresh`
 * (in-memory dedup, the `revoked` vs `transient` RefreshError taxonomy,
 * write-on-success + clear-needsReconnection) but writes back to the
 * `integration_connections` table.
 *
 * Lives in apps/api rather than packages/connect because `integration_connections`
 * is platform-internal (the connect package intentionally stays free of
 * `@appstrate/db` to keep its surface light enough for the sidecar to
 * consume).
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
   * Niveau 2 Phase 6 — scope set the IdP authoritatively granted on this
   * refresh (parsed from the response's `scope` field). `null` when the
   * response omitted `scope` entirely — per OAuth 2 §5.1 that means
   * "same scopes as previously issued", so the caller MUST NOT treat
   * `null` as "no scopes granted".
   */
  scopesGranted: string[] | null;
  /**
   * `true` when {@link scopesGranted} is non-null AND strictly narrower
   * than the connection's previously-stored `scopesGranted`. The IdP
   * has shrunk the grant — {@link refreshConnectionCredential} re-checks
   * the space's agents' required scopes and flips `needsReconnection` if
   * the shrink dropped the actor below the minimum required set.
   *
   * `false` when scopes stayed the same, grew (creep), or the response
   * omitted `scope` — the cross-check is skipped.
   */
  shrinkDetected: boolean;
}

/**
 * Thrown when an oauth2 connection can never be refreshed as it stands, no
 * matter how many times the caller retries — currently the single case of a
 * stored credential bundle with no `refresh_token` at all. TERMINAL, and
 * distinct from `RefreshError(kind="revoked")`: the IdP never rejected
 * anything, so an operator reading "revoked" would go hunting upstream for a
 * revocation that never happened. `reason` is surfaced verbatim in the 410.
 */
class UnrefreshableConnectionError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "UnrefreshableConnectionError";
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
 * Refresh the OAuth2 access token for an integration connection. When the
 * stored credentials carry no refresh_token, the token is unrecoverable: flags
 * needsReconnection AND throws {@link UnrefreshableConnectionError} so the
 * caller surfaces the same terminal status it gives any other dead credential.
 *
 * On success: writes the new ciphertext + expiresAt + clears needsReconnection.
 * On `invalid_grant`: throws RefreshError(kind="revoked") AND flips
 * needsReconnection=true on the row (so the dashboard shows the re-connect
 * prompt at the next visit).
 * On any other failure: throws RefreshError(kind="transient") without
 * touching the row — caller fails the current request but the connection
 * stays usable for future calls.
 *
 * `options.force` defaults to TRUE: every caller reaching here has already
 * decided a refresh is warranted, and a merely PROACTIVE one (the stored token
 * nears expiry) says so explicitly through {@link refreshConnectionCredential}.
 * Forced skips the post-lock freshness short-circuit — see {@link dedupedRefresh}.
 */
export async function forceRefreshIntegrationConnection(
  connection: RefreshTarget,
  packageIdForLog: string,
  authKeyForLog: string,
  refreshContext: IntegrationRefreshContext,
  options: { force?: boolean } = {},
): Promise<IntegrationRefreshResult> {
  const { id: connectionId, credentialsEncrypted } = connection;

  // Two dedup layers (in-process singleflight + cross-process Redis lock +
  // post-acquire re-read), owned by `dedupedRefresh`. The re-read short-circuit
  // returns the stored creds when a peer instance already refreshed; otherwise
  // we refresh against the freshest stored ciphertext (a peer may have rotated
  // the refresh_token even if the access token is near expiry).
  let freshCiphertext = credentialsEncrypted;
  // Callers that read different upstreams of the row never share a flight's result.
  const upstream = JSON.stringify([connection.clientRef, connection.oauthResource]);
  return dedupedRefresh<IntegrationRefreshResult>(`${connectionId}:${upstream}`, {
    lockKey: `intg-refresh:${connectionId}`,
    lockLabel: "intg-refresh",
    force: options.force ?? true,
    reReadFreshness: async ({ force }) => {
      const [row] = await db
        .select({
          credentialsEncrypted: integrationConnections.credentialsEncrypted,
          expiresAt: integrationConnections.expiresAt,
          clientRef: integrationConnections.clientRef,
          oauthResource: integrationConnections.oauthResource,
        })
        .from(integrationConnections)
        .where(eq(integrationConnections.id, connectionId))
        .limit(1);
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
      // The read happens even when forced — `doRefresh` must spend the
      // freshest stored refresh_token, not the one the caller was holding.
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
    // We only reach `doRefresh` when a refresh was actually warranted — the
    // caller is either inside the proactive lead window (token expiring) or
    // recovering from an upstream 401. With no refresh_token there is no way
    // to recover: the access token is or will be dead. Flag the connection so
    // the agent/dashboard surfaces a re-connect prompt instead of silently
    // serving a token that 401s on every call. (Root cause for Google was a
    // missing `access_type=offline` on the authorize URL — see
    // `auths.{key}.authorizationParams` — so the IdP never issued one.)
    //
    // THROW, never return: a success shape carrying the dead token contradicts
    // the flag we just wrote — the sidecar would inject the same credential
    // that 401'd and report 200 to the run, exactly the "stale-200, no flag"
    // no-op the 410 contract exists to forbid. The model-provider twin
    // (`model-providers/token-resolver.ts`) has always thrown here.
    logger.warn(
      "Integration connection unrefreshable — no refresh_token; flagging needsReconnection",
      {
        packageId,
        authKey,
        connectionId,
      },
    );
    await markIntegrationConnectionNeedsReconnection(connectionId);
    throw new UnrefreshableConnectionError("no stored refresh_token");
  }

  let parsed: RefreshExchangeResult["parsed"];
  let tokenData: Record<string, unknown>;
  try {
    ({ parsed, raw: tokenData } = await performRefreshTokenExchange(ctx, refreshToken, {
      label: `Integration token refresh for '${packageId}' auth '${authKey}'`,
    }));
  } catch (err) {
    // Flip needsReconnection on a revoked refresh token so the dashboard
    // prompts re-connect. The wire mechanics + classification live in the
    // shared exchange; only the table write-back is integration-side.
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
      // Transient failure (network / 5xx / parse). A single transient error is
      // NOT terminal — the cached token may still be valid. But a token that is
      // already expired AND keeps failing refresh is silently dead while the
      // row still looks healthy (the original Gmail scheduled-run bug). Record
      // the failure; `recordIntegrationRefreshFailure` escalates to
      // needsReconnection only once the streak crosses the threshold AND the
      // token is expired past the grace window, so a transient upstream blip on
      // a still-valid token never bricks the connection.
      const env = getEnv();
      await recordIntegrationRefreshFailure(connectionId, env.INTEGRATION_REFRESH_MAX_FAILURES, {
        graceSeconds: env.INTEGRATION_REFRESH_GRACE_SECONDS,
      });
    }
    throw err;
  }

  // `parseTokenResponse` may return `undefined` for refreshToken on flows
  // that don't rotate it — preserve whatever the current ciphertext held in
  // that case so the next refresh still works.
  const finalRefreshToken = parsed.refreshToken ?? refreshToken;
  const expiresAt = parsed.expiresAt ? new Date(parsed.expiresAt) : null;

  // Niveau 2 Phase 6 — only treat the response's `scope` as authoritative
  // when the IdP echoed it explicitly. `parseTokenResponse` falls back to
  // the requestedScopes (here `undefined` → `[]`) when the response omits
  // `scope`; an empty array under that path would FALSELY signal a total
  // revocation. Distinguish by checking the raw wire payload directly.
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
 * payload/`null`); what was written to the connection row is already written.
 *
 * - `refreshed`: a new credential is stored — or, on a proactive refresh, a peer's fresher one
 *   was read back. If the refresh narrowed the grant below the space's required scopes, the
 *   connection is already flagged `needsReconnection`; the credential is still served.
 * - `kept`: a proactive refresh that could not run (no refresh client, a non-oauth2 auth, a
 *   transient token-endpoint discovery failure). Nothing concluded, the stored credential stands.
 * - `retry`: not refreshed now, the connection stays usable — a transient failure (discovery,
 *   network, upstream 5xx, parse), or an upstream rejection of an unrefreshable auth counted below
 *   `INTEGRATION_REFRESH_MAX_FAILURES`. `reason` completes "Integration 'x' auth 'y' …".
 * - `dead`: the credential can never be used again and the connection is flagged
 *   `needsReconnection` — refresh token revoked upstream (RFC 6749 §5.2 `invalid_grant`), no
 *   stored `refresh_token` at all, or an unrefreshable auth rejected up to the threshold.
 *   `reason` names the cause, never blaming a revocation that did not happen.
 *
 * `detail` carries the underlying error, for logs only.
 */
type ConnectionRefreshOutcome =
  | { status: "refreshed"; fields: Record<string, string>; expiresAt: Date | null }
  | { status: "kept"; reason: string; detail?: string }
  | { status: "retry"; reason: string; detail?: string }
  | { status: "dead"; reason: string; detail?: string };

/**
 * The one decision over a connection whose credential is due for refresh: proactively (`force:
 * false`, the stored token nears expiry) or after an upstream 401 (`force: true`). Whether a
 * refresh is due — and whether a 401 still concerns the stored credential — is the caller's call.
 *
 * Builds the refresh context from the connection's pinned client, refreshes, classifies the
 * failure, and checks a narrowed grant against the space's scope floor — on every path, since the
 * refresh that narrows `scopes_granted` is the only one that can see the shrink. A forced refresh
 * nothing can perform (not oauth2, no client, no token endpoint) is counted by
 * `recordUnrefreshableRejection` while `actor` still reaches the connection.
 *
 * Throws only the 503 of a key id missing from the keyring — never a verdict on the connection.
 * A scope-floor check that fails is logged; the refreshed credential is still returned.
 */
export async function refreshConnectionCredential(input: {
  connection: RefreshTarget & { authKey: string };
  integrationId: string;
  /** The manifest the caller reads the connection's auth from, and `authDef` its declaration. */
  manifest: IntegrationManifest;
  authDef: AfpsManifestAuth;
  scope: SpaceScope;
  actor: Actor;
  force: boolean;
}): Promise<ConnectionRefreshOutcome> {
  const { connection, integrationId, authDef, scope, actor, force } = input;
  const { authKey } = connection;

  // One 401 can be a transient upstream fault, or a permission error the agent provoked, so a
  // forced refresh nothing can perform is counted: `retry` until the threshold, then `dead`.
  const unrefreshable = async (why: string): Promise<ConnectionRefreshOutcome> => {
    if (!force) return { status: "kept", reason: why };
    const { failures, maxFailures, needsReconnection } = await recordUnrefreshableRejection(
      connection.id,
      integrationId,
      { spaceId: scope.spaceId, actor },
    );
    if (needsReconnection) return { status: "dead", reason: why };
    return {
      status: "retry",
      reason:
        `was rejected upstream (${why}); ` +
        `${failures}/${maxFailures} consecutive upstream rejections before it is flagged`,
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
      status: force ? "retry" : "kept",
      reason: "token endpoint discovery failed (transient)",
      detail: err.message,
    };
  }
  if (!refreshContext) return unrefreshable("no OAuth client or token endpoint");

  let refreshed: IntegrationRefreshResult;
  try {
    refreshed = await forceRefreshIntegrationConnection(
      connection,
      integrationId,
      authKey,
      refreshContext,
      { force },
    );
  } catch (err) {
    if (err instanceof RefreshError && err.kind === "revoked") {
      return { status: "dead", reason: "refresh token revoked", detail: err.message };
    }
    if (err instanceof UnrefreshableConnectionError) return { status: "dead", reason: err.reason };
    if (err instanceof UnknownKeyIdError) {
      throw encryptionKeyUnavailable(err, {
        connectionId: connection.id,
        packageId: integrationId,
        authKey,
      });
    }
    return {
      status: "retry",
      reason: "token refresh failed upstream (transient)",
      detail: getErrorMessage(err),
    };
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
