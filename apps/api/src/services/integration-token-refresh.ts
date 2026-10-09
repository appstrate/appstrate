// SPDX-License-Identifier: Apache-2.0

/**
 * Credential refresh for `integration_connections` rows ({@link refreshConnectionCredential}): an
 * OAuth2 refresh-token exchange, or a declarative login run again with its kept inputs.
 * Lives in apps/api: connect stays free of `@appstrate/db` so the sidecar can consume it.
 */

import { eq } from "drizzle-orm";
import { integrationConnections } from "@appstrate/db/schema";
import { db } from "@appstrate/db/client";
import {
  RefreshError,
  ClientAuthInvariantError,
  performRefreshTokenExchange,
  decryptCredentialsToStringMap,
  decryptCredentialInputsToStringMap,
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
import { OAUTH_REFRESH_LEAD_MS, type CredentialFailureCause } from "@appstrate/core/sidecar-types";
import {
  persistCredentialBundle,
  markIntegrationConnectionNeedsReconnection,
  recordIntegrationRefreshFailure,
  recordUnrefreshableRejection,
  resolveIntegrationClientById,
} from "./integration-connections.ts";
import { computeRequiredScopes } from "./integration-scope-resolver.ts";
import { persistsLoginSecret, runAuthLogin } from "./connect/login-strategy.ts";
import { validateConnectionCredentials } from "./schema.ts";
import { LoginError } from "@appstrate/connect/connect";
import type { JSONSchemaObject } from "@appstrate/core/form";
import { checkEgressUrl } from "../lib/egress-host-guard.ts";
import { getEnv } from "@appstrate/env";
import { getErrorMessage } from "@appstrate/core/errors";

interface IntegrationRefreshResult {
  /** Decrypted credentials — snake_case wire keys only (`projectToStringMap`). */
  fields: Record<string, string>;
  /** Parsed `expires_at` from the token response, or `null` if upstream did not return `expires_in`. */
  expiresAt: Date | null;
  /** `null`: `scope` omitted, i.e. unchanged (RFC 6749 §5.1), never "none granted". */
  scopesGranted: string[] | null;
  /** {@link scopesGranted} is strictly narrower than the stored grant. */
  shrinkDetected: boolean;
}

/** A refresh's verdict, thrown out of `dedupedRefresh`. `flaggedBefore`: before the lock. */
class RefreshVerdictError extends Error {
  readonly flaggedBefore: boolean;
  constructor(
    readonly status: "retry" | "dead",
    readonly failure: CredentialFailureCause,
    options: { flaggedBefore?: boolean; cause?: unknown } = {},
  ) {
    super(`${status}: ${failure}`, { cause: options.cause });
    this.name = "RefreshVerdictError";
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
 * `perform` with the row's freshest ciphertext, once per connection at a time. `forced` (an
 * upstream 401) skips the freshness short-circuit after the lock.
 */
async function refreshUnderLock(
  connection: RefreshTarget,
  forced: boolean,
  perform: (credentialsEncrypted: string) => Promise<IntegrationRefreshResult>,
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
        throw new RefreshVerdictError("dead", "connection_flagged", { flaggedBefore: true });
      }
      if (
        !row ||
        row.clientRef !== connection.clientRef ||
        row.oauthResource !== connection.oauthResource
      ) {
        throw new RefreshVerdictError("retry", "connection_changed");
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
    doRefresh: () => perform(freshCiphertext),
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
    // Throw rather than serve the stored token: the sidecar would re-inject the credential that
    // 401'd and answer 200. (Google issues none without `access_type=offline`.)
    logger.warn(
      "Integration connection unrefreshable — no refresh_token; flagging needsReconnection",
      {
        packageId,
        authKey,
        connectionId,
      },
    );
    await markIntegrationConnectionNeedsReconnection(connectionId);
    throw new RefreshVerdictError("dead", "refresh_token_missing");
  }

  let parsed: RefreshExchangeResult["parsed"];
  let tokenData: Record<string, unknown>;
  try {
    ({ parsed, raw: tokenData } = await performRefreshTokenExchange(ctx, refreshToken, {
      label: `Integration token refresh for '${packageId}' auth '${authKey}'`,
    }));
  } catch (err) {
    if (err instanceof ClientAuthInvariantError) {
      logger.error("Integration refresh aborted — incoherent client auth", {
        packageId,
        authKey,
        connectionId,
        err: String(err),
      });
    }
    if (!(err instanceof RefreshError)) throw err;
    throw await exchangeFailureVerdict(err, { packageId, authKey, connectionId });
  }

  // `parseTokenResponse` may return `undefined` for refreshToken on flows
  // that don't rotate it — preserve whatever the current ciphertext held in
  // that case so the next refresh still works.
  const finalRefreshToken = parsed.refreshToken ?? refreshToken;
  const expiresAt = parsed.expiresAt ? new Date(parsed.expiresAt) : null;

  const responseScopes = parsed.scopesReturned;

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
    responseScopes !== null && prevScopes.some((s) => !responseScopes.includes(s));

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
  if (!written) throw await rowChangedVerdict(connectionId);

  return { fields: newCreds, expiresAt, scopesGranted: responseScopes, shrinkDetected };
}

async function exchangeFailureVerdict(
  err: RefreshError,
  log: { packageId: string; authKey: string; connectionId: string },
): Promise<RefreshVerdictError> {
  switch (err.kind) {
    case "revoked":
      await markIntegrationConnectionNeedsReconnection(log.connectionId);
      return new RefreshVerdictError("dead", "refresh_token_revoked", { cause: err });
    case "client_rejected":
      logger.error("Integration refresh refused — the token endpoint rejected the OAuth client", {
        ...log,
        error: err.message,
      });
      return new RefreshVerdictError("retry", "oauth_client_rejected", { cause: err });
    case "transient":
      return countedFailureVerdict(log.connectionId, err);
  }
}

/** A failure that may pass: `retry` until the refresh-failure threshold, then `dead`. */
async function countedFailureVerdict(
  connectionId: string,
  cause: unknown,
): Promise<RefreshVerdictError> {
  const env = getEnv();
  const counted = await recordIntegrationRefreshFailure(
    connectionId,
    env.INTEGRATION_REFRESH_MAX_FAILURES,
    { graceSeconds: env.INTEGRATION_REFRESH_GRACE_SECONDS },
  );
  return counted?.needsReconnection
    ? new RefreshVerdictError("dead", "refresh_failures_exhausted", { cause })
    : new RefreshVerdictError("retry", "upstream_transient", { cause });
}

/**
 * The connection's login run again with the inputs it kept: the new outputs replace the session,
 * the inputs stay. Credentials the service now refuses flag the connection; any other failure
 * counts toward the refresh-failure threshold.
 */
async function doRelogin(
  { connectionId, clientRef }: { connectionId: string; clientRef: string | null },
  log: { packageId: string; authKey: string },
  authDef: AfpsManifestAuth,
  variables: Readonly<Record<string, string>> | null,
  credentialsEncrypted: string,
): Promise<IntegrationRefreshResult> {
  const kept = decryptCredentialInputsToStringMap(credentialsEncrypted);
  const typed = validateConnectionCredentials(
    authDef.credentials?.schema as JSONSchemaObject | undefined,
    kept,
  );
  if (Object.keys(kept).length === 0 || !typed.valid) {
    // Inputs the current manifest no longer accepts: only the user can supply new ones.
    await markIntegrationConnectionNeedsReconnection(connectionId);
    throw new RefreshVerdictError("dead", "connection_flagged");
  }
  let login: Awaited<ReturnType<typeof runAuthLogin>>;
  try {
    login = await runAuthLogin(authDef, typed.data ?? kept, variables);
  } catch (err) {
    if (!(err instanceof LoginError)) throw err;
    logger.warn("Integration re-login failed", { ...log, connectionId, reason: err.reason });
    if (err.reason !== "rejected") throw await countedFailureVerdict(connectionId, err);
    await markIntegrationConnectionNeedsReconnection(connectionId);
    throw new RefreshVerdictError("dead", "connection_flagged", { cause: err });
  }
  const expiresAt = login.expiresAt ? new Date(login.expiresAt) : null;
  const written = await persistCredentialBundle(
    { kind: "update-by-id", connectionId, expect: { clientRef, credentialsEncrypted } },
    { credentials: login.outputs, inputs: kept, expiresAt, needsReconnection: false },
  );
  if (!written) throw await rowChangedVerdict(connectionId);
  return { fields: login.outputs, expiresAt, scopesGranted: null, shrinkDetected: false };
}

/** A compare-and-set write that did not land: the row was flagged, or reconnected meanwhile. */
async function rowChangedVerdict(connectionId: string): Promise<RefreshVerdictError> {
  const [row] = await db
    .select({ needsReconnection: integrationConnections.needsReconnection })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId))
    .limit(1);
  return row?.needsReconnection
    ? new RefreshVerdictError("dead", "connection_flagged")
    : new RefreshVerdictError("retry", "connection_changed");
}

/**
 * What {@link refreshConnectionCredential} concluded; callers only translate it, the row is
 * already written. `refreshed` is served even when a narrowed grant got the connection flagged;
 * `kept`: the stored one stands; `retry`: still usable; `dead`: flagged. `detail` is for logs.
 */
type ConnectionRefreshOutcome =
  | { status: "refreshed"; fields: Record<string, string>; expiresAt: Date | null }
  | { status: "kept"; cause?: CredentialFailureCause; detail?: string }
  | {
      status: "retry";
      cause: CredentialFailureCause;
      detail?: string;
      rejections?: { failures: number; maxFailures: number };
    }
  | { status: "dead"; cause: CredentialFailureCause; detail?: string };

export type RefreshTrigger =
  | { kind: "expiring" }
  /** Upstream rejected the credential of `revision`; `null`: the one the connection holds. */
  | { kind: "rejected"; revision: string | null };

/**
 * The one decision over a connection's credential. A rejection is evidence only against the
 * credential it names: one the connection no longer holds is treated as a read, nothing counted.
 * A narrowed grant is checked against the space's scope floor on every path, since the refresh
 * that narrows `scopes_granted` is the only one that can see the shrink.
 *
 * Throws only what is not a verdict on the connection (missing key id → 503, a database fault).
 */
export async function refreshConnectionCredential(input: {
  connection: RefreshTarget & {
    authKey: string;
    expiresAt: Date | null;
    credentialRevision: string;
    variables: Record<string, string> | null;
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
  if (!forced && !expiresWithinLeadWindow(connection.expiresAt)) return { status: "kept" };

  // One 401 can be a transient upstream fault, or a permission error the agent provoked, so a
  // forced refresh nothing can perform is counted: `retry` until the threshold, then `dead`.
  const unrefreshable = async (detail: string): Promise<ConnectionRefreshOutcome> => {
    const cause = "unrefreshable";
    if (!forced) return { status: "kept", cause, detail };
    const counted = await recordUnrefreshableRejection(
      connection.id,
      integrationId,
      { spaceId: scope.spaceId, actor },
      connection.credentialRevision,
    );
    if (!counted) return { status: "kept" };
    if (counted.needsReconnection) return { status: "dead", cause, detail };
    const { failures, maxFailures } = counted;
    return { status: "retry", cause, detail, rejections: { failures, maxFailures } };
  };

  if (authDef.type !== "oauth2") {
    if (!persistsLoginSecret(authDef)) {
      return unrefreshable(`auth type '${authDef.type}' is not refreshable`);
    }
    if (
      Object.keys(decryptCredentialInputsToStringMap(connection.credentialsEncrypted)).length === 0
    ) {
      return unrefreshable("the connection kept no login inputs; reconnect it once");
    }
    return settle(input, forced, (ciphertext) =>
      doRelogin(
        { connectionId: connection.id, clientRef: connection.clientRef },
        { packageId: integrationId, authKey },
        authDef,
        connection.variables,
        ciphertext,
      ),
    );
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
    // Never terminal; a proactive refresh has no evidence against the stored token.
    return { status: forced ? "retry" : "kept", cause: "discovery_transient", detail: err.message };
  }
  if (!refreshContext) return unrefreshable("no OAuth client or token endpoint");

  return settle(input, forced, (ciphertext) =>
    doRefresh(
      { connectionId: connection.id, clientRef: connection.clientRef },
      integrationId,
      authKey,
      ciphertext,
      refreshContext,
    ),
  );
}

/** One refresh under the connection's lock, its verdict translated to an outcome. */
async function settle(
  input: Parameters<typeof refreshConnectionCredential>[0],
  forced: boolean,
  perform: (credentialsEncrypted: string) => Promise<IntegrationRefreshResult>,
): Promise<ConnectionRefreshOutcome> {
  const { connection, integrationId } = input;
  const { authKey } = connection;
  let refreshed: IntegrationRefreshResult;
  try {
    refreshed = await refreshUnderLock(connection, forced, perform);
  } catch (err) {
    if (err instanceof RefreshVerdictError) {
      // A proactive refresh has no evidence against the token a flag set elsewhere left in place.
      if (err.flaggedBefore && !forced) return { status: "kept", cause: err.failure };
      return {
        status: err.status,
        cause: err.failure,
        ...(err.cause !== undefined ? { detail: getErrorMessage(err.cause) } : {}),
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
