// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 1.5 — live integration credentials resolver for the sidecar's MITM
 * `MitmCredentialSource`. Backs both `GET /internal/integration-credentials/
 * {scope}/{name}` (read-current) and `POST .../refresh` (force-refresh-then-read).
 *
 * For each declared auth on the integration's manifest:
 *
 *   1. Find the connection row for the run's actor.
 *   2. If the auth is OAuth2 AND (forced OR within the lead window),
 *      call {@link forceRefreshIntegrationConnection}. RefreshError
 *      with `kind="revoked"` flips needsReconnection and bubbles a
 *      structured 403; transient failures bubble a 502.
 *   3. Resolve the live HTTP delivery plan via `resolveHttpDelivery`.
 *   4. Build a `ResolvedAuthCredentials` entry + the matching plan.
 *
 * Output is shaped to feed straight into the sidecar's
 * `MitmCredentialSource.current()` and `.deliveryPlans()`.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { integrationConnections, integrationOauthClients } from "@appstrate/db/schema";
import {
  RefreshError,
  decryptCredentials,
  decryptCredentialsToStringMap,
  resolveHttpDelivery,
  type HttpDeliveryPlan,
  type ResolvedAuthCredentials,
} from "@appstrate/connect";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { OAUTH_REFRESH_LEAD_MS } from "@appstrate/core/sidecar-types";

import { logger } from "../lib/logger.ts";
import { notFound, forbidden, internalError, badGateway } from "../lib/errors.ts";
import type { Actor } from "../lib/actor.ts";
import {
  forceRefreshIntegrationConnection,
  type IntegrationRefreshContext,
} from "./integration-token-refresh.ts";
import { assertIntegrationInstalled, loadActorConnection } from "./integration-connections.ts";
import { computeRequiredScopes } from "./integration-scope-resolver.ts";
import { fetchIntegrationManifest } from "./integration-service.ts";

export interface LiveIntegrationCredentialsResult {
  /** Auth payloads in the shape the MITM planner expects. */
  auths: ResolvedAuthCredentials[];
  /** Per-auth HTTP delivery plans. */
  deliveryPlans: Record<string, HttpDeliveryPlan>;
  /** Per-auth `expires_at` mirrored for the sidecar's proactive scheduler. */
  expiresAtEpochMs: Record<string, number | null>;
}

export interface ResolveLiveCredentialsOptions {
  /** When true, refresh OAuth tokens regardless of remaining lifetime. */
  forceRefresh?: boolean;
}

/**
 * Throws ApiError on:
 *   - 404: integration not declared by the agent, not installed, or no
 *     connection for the actor.
 *   - 403: connection's refresh token was revoked upstream (sidecar
 *     should propagate as 401 to the integration so the LLM sees a
 *     clean "please re-connect" surface).
 *   - 502: transient OAuth refresh failure (network, upstream 5xx, etc).
 *     The cached credential may still be valid; the sidecar treats it as
 *     retry-later and the listener's `refreshOnUnauthorized` cooldown
 *     keeps a flapping upstream from hammering this endpoint.
 */
export async function resolveLiveIntegrationCredentials(
  packageId: string,
  context: {
    runId: string;
    orgId: string;
    applicationId: string;
    agentPackageId: string;
    actor: Actor | null;
    /**
     * Snapshot from `runs.resolved_connections` (#199). When present,
     * the (packageId, authKey) entry's connectionId pins which row the
     * MITM listener decrypts — so admin pins / run overrides survive
     * past kickoff into the live credential surface.
     *
     * Typed as the DB JSONB shape (string `source`) rather than the
     * union-narrowed `ResolvedConnectionMap` because Postgres JSONB
     * widens unions to string on read — the resolver only consumes
     * `connectionId` so the wider type is safe at this boundary.
     */
    resolvedConnections?: Record<
      string,
      Record<string, { connectionId: string; source: string }>
    > | null;
  },
  options: ResolveLiveCredentialsOptions = {},
): Promise<LiveIntegrationCredentialsResult> {
  if (!context.actor) {
    // Scheduled runs without an actor cannot connect to user-scoped
    // integrations; refuse early.
    throw notFound(`Integration '${packageId}' has no actor-scoped connection for this run`);
  }

  const manifest = await loadIntegrationManifest(packageId);
  await assertIntegrationInstalled(packageId, context.applicationId);

  const auths = manifest.auths ?? {};
  if (Object.keys(auths).length === 0) {
    return { auths: [], deliveryPlans: {}, expiresAtEpochMs: {} };
  }

  const out: LiveIntegrationCredentialsResult = {
    auths: [],
    deliveryPlans: {},
    expiresAtEpochMs: {},
  };

  const authSnapshot = context.resolvedConnections?.[packageId] ?? null;

  for (const [authKey, authDef] of Object.entries(auths)) {
    // Look up the connection row for the actor. Skip silently if none —
    // matches the resolveIntegrationCredentials behaviour (the caller
    // gets a partial payload and the MITM planner refuses requests on
    // unauthorised URLs without crashing the integration).
    const pinnedConnectionId = authSnapshot?.[authKey]?.connectionId;
    const connection = await loadActorConnection(packageId, authKey, {
      applicationId: context.applicationId,
      actor: context.actor,
      ...(pinnedConnectionId ? { connectionId: pinnedConnectionId } : {}),
    });
    if (!connection) continue;

    let fields = decryptToStringMap(connection.credentialsEncrypted, packageId, authKey);
    if (!fields) continue;

    let expiresAtEpochMs: number | null = connection.expiresAt
      ? connection.expiresAt.getTime()
      : null;

    // Decide whether to refresh.
    const needsRefresh =
      authDef.type === "oauth2" &&
      (options.forceRefresh === true || isWithinLeadWindow(connection.expiresAt));

    if (needsRefresh) {
      const refreshContext = await buildOAuthRefreshContext(
        packageId,
        authKey,
        authDef,
        context.applicationId,
      );
      if (refreshContext) {
        try {
          const refreshed = await forceRefreshIntegrationConnection(
            connection.id,
            packageId,
            authKey,
            connection.credentialsEncrypted,
            refreshContext,
          );
          fields = refreshed.fields;
          expiresAtEpochMs = refreshed.expiresAt ? refreshed.expiresAt.getTime() : null;

          // Niveau 2 Phase 6 — IdP-side scope shrink awareness. When the
          // refresh response narrowed `scopesGranted` (user revoked some
          // permissions in their account settings between issuance and
          // refresh), cross-check against the union of `requiredScopes`
          // across every installed agent and flip `needsReconnection`
          // if the actor has dropped below that floor. Fast-path: skip
          // the agent scan unless the refresh actually shrank scopes.
          if (refreshed.shrinkDetected && refreshed.scopesGranted !== null) {
            const granted = refreshed.scopesGranted;
            const { required } = await computeRequiredScopes({
              scope: { orgId: context.orgId, applicationId: context.applicationId },
              integrationPackageId: packageId,
              authKey,
            });
            const missing = required.filter((s) => !granted.includes(s));
            if (missing.length > 0) {
              await db
                .update(integrationConnections)
                .set({ needsReconnection: true, updatedAt: new Date() })
                .where(eq(integrationConnections.id, connection.id));
              logger.warn("Integration scope shrink dropped below required floor", {
                runId: context.runId,
                packageId,
                authKey,
                granted,
                required,
                missing,
              });
            } else {
              logger.info("Integration scope shrink absorbed (still covers required)", {
                runId: context.runId,
                packageId,
                authKey,
                granted,
                required,
              });
            }
          }
        } catch (err) {
          if (err instanceof RefreshError && err.kind === "revoked") {
            // 403 here propagates to the sidecar, which translates back
            // to a 401 to the integration's MCP client. The
            // needsReconnection flag has already been set by the helper.
            logger.warn("Integration token refresh revoked", {
              runId: context.runId,
              packageId,
              authKey,
              status: err.status,
            });
            throw forbidden(
              `Integration '${packageId}' auth '${authKey}' needs re-connection (refresh token revoked)`,
            );
          }
          // Transient failure (network, upstream 5xx, parse error). The
          // cached credential may still be usable; surfacing 502 lets the
          // sidecar's `refreshOnUnauthorized` cooldown back off without
          // poisoning the connection row.
          logger.warn("Integration token refresh transient error", {
            runId: context.runId,
            packageId,
            authKey,
            error: err instanceof Error ? err.message : String(err),
          });
          throw badGateway(
            `Integration '${packageId}' auth '${authKey}' token refresh failed upstream (transient)`,
          );
        }
      }
    }

    const http = authDef.delivery?.http;
    if (http) {
      const plan = resolveHttpDelivery(authDef.type, fields, http);
      if (plan) {
        out.deliveryPlans[authKey] = plan;
      }
    }

    out.auths.push({
      authKey,
      authType: authDef.type,
      fields: Object.freeze({ ...fields }),
      authorizedUris: Object.freeze([...authDef.authorizedUris]),
      ...(authDef.audience !== undefined ? { audience: authDef.audience } : {}),
      ...(connection.expiresAt ? { expiresAt: connection.expiresAt.toISOString() } : {}),
      ...(connection.scopesGranted.length > 0
        ? { scopesGranted: Object.freeze([...connection.scopesGranted]) }
        : {}),
    });
    out.expiresAtEpochMs[authKey] = expiresAtEpochMs;
  }

  return out;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

async function loadIntegrationManifest(packageId: string): Promise<IntegrationManifest> {
  const res = await fetchIntegrationManifest(packageId);
  if (res.ok) return res.manifest;
  switch (res.failure.kind) {
    case "not_found":
      throw notFound(`Integration '${packageId}' not found`);
    case "not_integration":
      throw notFound(`Package '${packageId}' is not an integration`);
    case "invalid_manifest":
      logger.warn("integration manifest fails validation in credentials resolver", { packageId });
      throw internalError();
  }
}

function decryptToStringMap(
  ciphertext: string,
  packageId: string,
  authKey: string,
): Record<string, string> | null {
  try {
    return decryptCredentialsToStringMap(ciphertext);
  } catch (err) {
    logger.warn("decrypt failed in live credentials resolver", {
      packageId,
      authKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function isWithinLeadWindow(expiresAt: Date | null): boolean {
  if (!expiresAt) return false;
  return expiresAt.getTime() - Date.now() < OAUTH_REFRESH_LEAD_MS;
}

async function buildOAuthRefreshContext(
  packageId: string,
  authKey: string,
  authDef: NonNullable<IntegrationManifest["auths"]>[string],
  applicationId: string,
): Promise<IntegrationRefreshContext | null> {
  if (authDef.type !== "oauth2") return null;
  if (!authDef.tokenUrl) {
    // Discovery-only flows (`discovery: "auto"` or `discovery: {…}`) need
    // a one-shot RFC 9728 resolution before they can refresh. Not wired
    // in this first cut — the agent will see the stale token until the
    // next spawn-time resolution.
    logger.info("Integration auth refresh skipped — discovery-only flow", {
      packageId,
      authKey,
    });
    return null;
  }
  const [client] = await db
    .select({
      clientId: integrationOauthClients.clientId,
      clientSecretEncrypted: integrationOauthClients.clientSecretEncrypted,
    })
    .from(integrationOauthClients)
    .where(
      and(
        eq(integrationOauthClients.applicationId, applicationId),
        eq(integrationOauthClients.integrationPackageId, packageId),
        eq(integrationOauthClients.authKey, authKey),
      ),
    )
    .limit(1);
  if (!client) {
    // The application admin never registered an OAuth client for this
    // auth — the integration connection must have been provisioned via
    // dynamic client registration (DCR) or a system-wide client. Cannot
    // refresh without those credentials; skip.
    logger.info("Integration auth refresh skipped — no per-app OAuth client", {
      packageId,
      authKey,
    });
    return null;
  }
  let clientSecret: string;
  try {
    const decrypted = decryptCredentials<{ client_secret?: string }>(client.clientSecretEncrypted);
    clientSecret = decrypted.client_secret ?? "";
  } catch (err) {
    logger.warn("Integration auth client_secret decrypt failed", {
      packageId,
      authKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  // `tokenAuthMethod: "none"` (public clients) needs `client_id` in the
  // body with NO `client_secret`. The shared refresh helper doesn't yet
  // model that case — skip the refresh for now (the cached token rides
  // until next spawn) rather than send a malformed request the upstream
  // server would reject.
  if (authDef.tokenAuthMethod === "none") {
    logger.info("Integration auth refresh skipped — public client (tokenAuthMethod=none)", {
      packageId,
      authKey,
    });
    return null;
  }
  return {
    tokenUrl: authDef.tokenUrl,
    clientId: client.clientId,
    clientSecret,
    ...(authDef.tokenAuthMethod ? { tokenAuthMethod: authDef.tokenAuthMethod } : {}),
    ...(authDef.scopeSeparator ? { scopeSeparator: authDef.scopeSeparator } : {}),
  };
}
