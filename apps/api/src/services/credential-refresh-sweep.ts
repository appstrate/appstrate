// SPDX-License-Identifier: Apache-2.0

/**
 * Background refresh of idle OAuth2 credentials (integration connections and OAuth model provider
 * credentials) so a provider cannot expire them unused. Mechanics: docs/architecture/INTEGRATIONS_RUNTIME.md.
 */

import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@appstrate/db/client";
import { integrationConnections, modelProviderCredentials } from "@appstrate/db/schema";
import { OAUTH_REFRESH_LEAD_MS } from "@appstrate/core/sidecar-types";
import { getErrorMessage } from "@appstrate/core/errors";
import { mapWithConcurrency } from "@appstrate/core/map-with-concurrency";
import { createQueue, type JobQueue } from "../infra/queue/index.ts";
import { logger } from "../lib/logger.ts";
import { ApiError } from "../lib/errors.ts";
import type { AfpsManifestAuth } from "./integration-manifest-helpers.ts";
import { credentialRevision } from "./integration-connections.ts";
import { readIntegrationManifestForConnect } from "./integration-service.ts";
import { refreshConnectionCredential } from "./integration-token-refresh.ts";
import { listModelProviders } from "./model-providers/registry.ts";
import { resolveOAuthTokenForSidecar } from "./model-providers/token-resolver.ts";

const SCAN_QUEUE_NAME = "credential-refresh-scan";
const SCAN_SCHEDULER_ID = "credential-refresh-scan";
/** Hourly at :43, off the hour and away from the other schedulers' minutes (0, 15-step, 17). */
const SCAN_CRON = "43 * * * *";

/** Rows claimed per source per scan; the rest is claimed by the next scan. */
const CLAIM_LIMIT = 500;
/** Once a day: one cron period short of 24 h, so scan-start jitter never defers a visit an hour. */
const VISIT_INTERVAL_MS = 23 * 60 * 60 * 1000;
const REFRESH_CONCURRENCY = 4;

type ScanJobData = Record<string, never>;

let scanQueue: JobQueue<ScanJobData> | null = null;

async function getScanQueue(): Promise<JobQueue<ScanJobData>> {
  if (!scanQueue) scanQueue = await createQueue<ScanJobData>(SCAN_QUEUE_NAME);
  return scanQueue;
}

/** Not flagged, expires within the lead (or already has), and was not visited within the interval. */
function due(
  t: { expiresAt: AnyPgColumn; refreshCheckedAt: AnyPgColumn; needsReconnection: AnyPgColumn },
  now: Date,
) {
  return and(
    sql`NOT ${t.needsReconnection}`,
    isNotNull(t.expiresAt),
    lt(t.expiresAt, new Date(now.getTime() + OAUTH_REFRESH_LEAD_MS)),
    or(
      isNull(t.refreshCheckedAt),
      lt(t.refreshCheckedAt, new Date(now.getTime() - VISIT_INTERVAL_MS)),
    ),
  );
}

// ─────────────────────────────────────────────
// integration_connections
// ─────────────────────────────────────────────

async function claimIntegrationConnections(limit: number, now: Date): Promise<string[]> {
  const t = integrationConnections;
  // Spelled as `idx_integration_conn_refresh_due` states it, so the scan rides the index.
  const candidates = db
    .select({ id: t.id })
    .from(t)
    .where(and(isNotNull(t.clientRef), due(t, now)))
    .orderBy(asc(t.expiresAt))
    .limit(limit)
    .for("update", { skipLocked: true });
  const rows = await db
    .update(t)
    .set({ refreshCheckedAt: now })
    .where(inArray(t.id, candidates))
    .returning({ id: t.id });
  return rows.map((r) => r.id);
}

/**
 * One pass names each refused OAuth client once: its connections all fail the same way, and
 * nothing a reconnect does changes that, so a per-connection line only floods the log.
 */
type RefusedClients = Set<string>;

function warnRefusedClientOnce(
  seen: RefusedClients,
  key: string,
  fields: Record<string, unknown>,
): void {
  if (seen.has(key)) return;
  seen.add(key);
  logger.warn("credential_refresh_oauth_client_refused", {
    ...fields,
    advice:
      "the token endpoint refused the OAuth client or request; reconnecting will not fix it, fix the client registration or the integration manifest",
  });
}

async function refreshIntegrationConnection(id: string, refused: RefusedClients): Promise<void> {
  const t = integrationConnections;
  const [row] = await db
    .select({
      id: t.id,
      orgId: t.orgId,
      spaceId: t.spaceId,
      integrationId: t.integrationId,
      authKey: t.authKey,
      credentialsEncrypted: t.credentialsEncrypted,
      credentialRevision,
      clientRef: t.clientRef,
      oauthResource: t.oauthResource,
      expiresAt: t.expiresAt,
    })
    .from(t)
    .where(eq(t.id, id))
    .limit(1);
  if (!row) return;

  const { integrationId, authKey } = row;
  const fields = { connectionId: id, integrationId, authKey };

  // The manifest a connect reads: the latest published version, the draft while none is published.
  const read = await readIntegrationManifestForConnect({ orgId: row.orgId }, integrationId);
  const authDef = read.ok ? (read.manifest.auths?.[authKey] as AfpsManifestAuth | undefined) : null;
  if (!read.ok || !authDef) {
    logger.info("credential_refresh_integration_skipped", {
      ...fields,
      reason: read.ok ? "auth_not_declared" : read.reason,
    });
    return;
  }

  // `kept` covers a row flagged since the claim: the refresh re-reads it under its lock.
  const outcome = await refreshConnectionCredential({
    connection: row,
    integrationId,
    manifest: read.manifest,
    authDef,
    trigger: { kind: "expiring" },
  });
  if (outcome.status === "refreshed") {
    logger.info("credential_refresh_integration_refreshed", fields);
    return;
  }
  if (outcome.status === "retry" && outcome.cause === "oauth_client_rejected") {
    warnRefusedClientOnce(refused, `integration:${integrationId}:${row.clientRef}`, {
      ...fields,
      clientRef: row.clientRef,
      detail: outcome.detail,
    });
    return;
  }
  logger[outcome.status === "kept" ? "debug" : "warn"](
    "credential_refresh_integration_not_refreshed",
    {
      ...fields,
      status: outcome.status,
      cause: outcome.cause,
      detail: outcome.detail,
    },
  );
}

// ─────────────────────────────────────────────
// model_provider_credentials
// ─────────────────────────────────────────────

async function claimModelCredentials(limit: number, now: Date): Promise<string[]> {
  const oauthProviderIds = listModelProviders()
    .filter((p) => p.authMode === "oauth2")
    .map((p) => p.providerId);
  if (oauthProviderIds.length === 0) return [];

  const t = modelProviderCredentials;
  const candidates = db
    .select({ id: t.id })
    .from(t)
    .where(and(inArray(t.providerId, oauthProviderIds), due(t, now)))
    .orderBy(asc(t.expiresAt))
    .limit(limit)
    .for("update", { skipLocked: true });
  const rows = await db
    .update(t)
    .set({ refreshCheckedAt: now })
    .where(inArray(t.id, candidates))
    .returning({ id: t.id });
  return rows.map((r) => r.id);
}

/** The resolver is non-forced: it honours the lead and throws the 410 on a flagged credential. */
async function refreshModelCredential(id: string, refused: RefusedClients): Promise<void> {
  try {
    await resolveOAuthTokenForSidecar(id);
    logger.info("credential_refresh_model_ok", { credentialId: id });
  } catch (err) {
    if (
      err instanceof ApiError &&
      err.status === 502 &&
      err.extensions?.cause === "oauth_client_rejected"
    ) {
      const [row] = await db
        .select({ providerId: modelProviderCredentials.providerId })
        .from(modelProviderCredentials)
        .where(eq(modelProviderCredentials.id, id))
        .limit(1);
      warnRefusedClientOnce(refused, `model:${row?.providerId ?? id}`, {
        credentialId: id,
        providerId: row?.providerId,
        detail: getErrorMessage(err),
      });
      return;
    }
    // 404: deleted since the claim, or a blob nobody can decrypt. 410: flagged. Anything else is
    // already recorded by the resolver, whose streak escalates to `needsReconnection`.
    if (!(err instanceof ApiError) || (err.status !== 404 && err.status !== 410)) throw err;
    const cause = err.extensions?.cause;
    logger[cause === "connection_flagged" ? "debug" : "warn"]("credential_refresh_model_skipped", {
      credentialId: id,
      status: err.status,
      cause,
    });
  }
}

// ─────────────────────────────────────────────
// Scan + job handlers
// ─────────────────────────────────────────────

/** Run one claimed row's refresh; one failure never stops the others, the next visit is tomorrow. */
async function refreshIsolated(kind: string, id: string, refresh: () => Promise<void>) {
  try {
    await refresh();
  } catch (err) {
    logger.error("credential_refresh_failed", {
      kind,
      id,
      cause: err instanceof ApiError ? err.extensions?.cause : undefined,
      error: getErrorMessage(err),
    });
  }
}

/** One `now` for the due predicate and the visit stamp, so the interval does not drift. */
export async function scanCredentialRefreshes(): Promise<{ integrations: number; models: number }> {
  const now = new Date();
  const integrationIds = await claimIntegrationConnections(CLAIM_LIMIT, now);
  const modelIds = await claimModelCredentials(CLAIM_LIMIT, now);
  const refused: RefusedClients = new Set();
  const jobs = [
    ...integrationIds.map(
      (id) => () =>
        refreshIsolated("integration_connection", id, () =>
          refreshIntegrationConnection(id, refused),
        ),
    ),
    ...modelIds.map(
      (id) => () =>
        refreshIsolated("model_provider_credential", id, () => refreshModelCredential(id, refused)),
    ),
  ];
  await mapWithConcurrency(jobs, REFRESH_CONCURRENCY, (job) => job());
  return { integrations: integrationIds.length, models: modelIds.length };
}

async function handleScanJob(): Promise<void> {
  const startedAt = Date.now();
  try {
    const claimed = await scanCredentialRefreshes();
    logger.info("credential_refresh_scan_done", { claimed, durationMs: Date.now() - startedAt });
  } catch (err) {
    logger.error("credential_refresh_scan_failed", {
      error: getErrorMessage(err),
      durationMs: Date.now() - startedAt,
    });
  }
}

/** Start the sweep workers and its hourly scan. Idempotent. */
export async function initCredentialRefreshSweep(): Promise<void> {
  const scan = await getScanQueue();
  scan.process(handleScanJob, { concurrency: 1 });

  await scan.upsertScheduler(
    SCAN_SCHEDULER_ID,
    { pattern: SCAN_CRON, tz: "UTC" },
    { name: "scan", data: {} },
  );
  logger.info("Credential refresh sweep started", { cron: SCAN_CRON });
}

/** Stop the sweep workers. Idempotent. */
export async function shutdownCredentialRefreshSweep(): Promise<void> {
  await scanQueue?.shutdown();
  scanQueue = null;
  logger.info("Credential refresh sweep stopped");
}
