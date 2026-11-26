// SPDX-License-Identifier: Apache-2.0

/**
 * Background credential refresh sweep: keeps the refresh tokens of idle OAuth2 credentials alive.
 *
 * A provider that expires unused refresh tokens kills a credential nobody touches. The sweep
 * exercises those tokens; it does not keep access tokens fresh (a credential in use refreshes
 * itself on the read path). A row is due when its token expires within the refresh lead or has
 * expired, and no visit stamped `refresh_checked_at` in the last {@link VISIT_INTERVAL_MS}. The
 * claim stamps that column BEFORE the attempt, success or failure, so a failing row is retried
 * once a day, and every credential write stamps it too, so a credential in use is never claimed.
 * A still-valid token is never exchanged.
 *
 * Two sources share the scan: `integration_connections` and the OAuth `model_provider_credentials`.
 * The claim is one atomic `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`: it dedupes
 * across instances and overlapping scans, and decrypts nothing. Refresh jobs are not retried by
 * the queue: the claim spent the visit.
 */

import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@appstrate/db/client";
import { integrationConnections, modelProviderCredentials } from "@appstrate/db/schema";
import { OAUTH_REFRESH_LEAD_MS } from "@appstrate/core/sidecar-types";
import { getErrorMessage } from "@appstrate/core/errors";
import type { Logger } from "@appstrate/core/logger";
import { createQueue, type JobQueue, type QueueJob } from "../infra/queue/index.ts";
import { logger } from "../lib/logger.ts";
import { ApiError } from "../lib/errors.ts";
import type { AfpsManifestAuth } from "./integration-manifest-helpers.ts";
import { readCredentialRevision } from "./integration-connections.ts";
import { readIntegrationManifestForProxy } from "./integration-service.ts";
import { refreshConnectionCredential } from "./integration-token-refresh.ts";
import { listModelProviders } from "./model-providers/registry.ts";
import { resolveOAuthTokenForSidecar } from "./model-providers/token-resolver.ts";

const SCAN_QUEUE_NAME = "credential-refresh-scan";
const REFRESH_QUEUE_NAME = "credential-refresh";
const SCAN_SCHEDULER_ID = "credential-refresh-scan";
/** Hourly at :43, off the hour and away from the other schedulers' minutes (0, 15-step, 17). */
const SCAN_CRON = "43 * * * *";

/** Rows claimed per source per scan; the rest is claimed by the next scan. */
const CLAIM_LIMIT = 500;
/** A row is visited at most once per interval. */
const VISIT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type CredentialRefreshKind = "integration_connection" | "model_provider_credential";

interface CredentialRefreshJobData {
  kind: CredentialRefreshKind;
  id: string;
}

type ScanJobData = Record<string, never>;

interface RefreshSource {
  /** Stamp and return the ids of up to `limit` due rows. */
  claim(limit: number): Promise<string[]>;
  /** Refresh one claimed row; logs its outcome and never throws on a verdict. */
  refreshOne(id: string, log: Logger): Promise<void>;
}

let scanQueue: JobQueue<ScanJobData> | null = null;
let refreshQueue: JobQueue<CredentialRefreshJobData> | null = null;

async function getScanQueue(): Promise<JobQueue<ScanJobData>> {
  if (!scanQueue) scanQueue = await createQueue<ScanJobData>(SCAN_QUEUE_NAME);
  return scanQueue;
}

async function getRefreshQueue(): Promise<JobQueue<CredentialRefreshJobData>> {
  if (!refreshQueue) refreshQueue = await createQueue<CredentialRefreshJobData>(REFRESH_QUEUE_NAME);
  return refreshQueue;
}

/** Expires within the lead (or already has), and was not visited within the interval. */
function dueByExpiry(expiresAt: AnyPgColumn, refreshCheckedAt: AnyPgColumn) {
  const now = Date.now();
  return and(
    isNotNull(expiresAt),
    lt(expiresAt, new Date(now + OAUTH_REFRESH_LEAD_MS)),
    or(isNull(refreshCheckedAt), lt(refreshCheckedAt, new Date(now - VISIT_INTERVAL_MS))),
  );
}

// ─────────────────────────────────────────────
// integration_connections
// ─────────────────────────────────────────────

async function claimIntegrationConnections(limit: number): Promise<string[]> {
  const t = integrationConnections;
  // The index predicate spelled as the index states it, so the scan rides `idx_integration_conn_refresh_due`.
  const due = and(
    isNotNull(t.clientRef),
    sql`NOT ${t.needsReconnection}`,
    dueByExpiry(t.expiresAt, t.refreshCheckedAt),
  );
  const candidates = db
    .select({ id: t.id })
    .from(t)
    .where(due)
    .orderBy(asc(t.expiresAt))
    .limit(limit)
    .for("update", { skipLocked: true });
  const rows = await db
    .update(t)
    .set({ refreshCheckedAt: new Date() })
    .where(inArray(t.id, candidates))
    .returning({ id: t.id });
  return rows.map((r) => r.id);
}

async function refreshIntegrationConnection(id: string, log: Logger): Promise<void> {
  const t = integrationConnections;
  const [row] = await db
    .select({
      id: t.id,
      orgId: t.orgId,
      spaceId: t.spaceId,
      integrationId: t.integrationId,
      authKey: t.authKey,
      credentialsEncrypted: t.credentialsEncrypted,
      clientRef: t.clientRef,
      oauthResource: t.oauthResource,
      expiresAt: t.expiresAt,
      needsReconnection: t.needsReconnection,
    })
    .from(t)
    .where(eq(t.id, id))
    .limit(1);
  if (!row || row.needsReconnection) return;

  const { integrationId, authKey } = row;
  const fields = { connectionId: id, integrationId, authKey };

  // The latest published version, as the proxy reads it outside a run.
  const read = await readIntegrationManifestForProxy(integrationId, row.orgId, null);
  if (!read.ok) {
    log.info("credential_refresh_integration_skipped", { ...fields, reason: read.failure.kind });
    return;
  }
  const authDef = read.manifest.auths?.[authKey] as AfpsManifestAuth | undefined;
  if (!authDef) {
    log.info("credential_refresh_integration_skipped", { ...fields, reason: "auth_not_declared" });
    return;
  }
  const credentialRevision = await readCredentialRevision(id);
  if (credentialRevision === null) return;

  const outcome = await refreshConnectionCredential({
    connection: { ...row, credentialRevision },
    integrationId,
    manifest: read.manifest,
    authDef,
    trigger: { kind: "expiring" },
  });
  const logged = { ...fields, status: outcome.status };
  switch (outcome.status) {
    case "refreshed":
      log.info("credential_refresh_integration_refreshed", logged);
      return;
    case "kept":
      log.debug("credential_refresh_integration_kept", { ...logged, cause: outcome.cause });
      return;
    case "retry":
    case "dead":
      log.warn("credential_refresh_integration_not_refreshed", {
        ...logged,
        cause: outcome.cause,
        detail: outcome.detail,
      });
      return;
  }
}

// ─────────────────────────────────────────────
// model_provider_credentials
// ─────────────────────────────────────────────

async function claimModelCredentials(limit: number): Promise<string[]> {
  const oauthProviderIds = listModelProviders()
    .filter((p) => p.authMode === "oauth2")
    .map((p) => p.providerId);
  if (oauthProviderIds.length === 0) return [];

  const t = modelProviderCredentials;
  const candidates = db
    .select({ id: t.id })
    .from(t)
    .where(
      and(inArray(t.providerId, oauthProviderIds), dueByExpiry(t.expiresAt, t.refreshCheckedAt)),
    )
    .orderBy(asc(t.expiresAt))
    .limit(limit)
    .for("update", { skipLocked: true });
  const rows = await db
    .update(t)
    .set({ refreshCheckedAt: new Date() })
    .where(inArray(t.id, candidates))
    .returning({ id: t.id });
  return rows.map((r) => r.id);
}

/** The resolver is non-forced: it honours the lead and throws the 410 on a flagged credential. */
async function refreshModelCredential(id: string, log: Logger): Promise<void> {
  const startedAt = Date.now();
  try {
    await resolveOAuthTokenForSidecar(id);
    log.info("credential_refresh_model_ok", {
      credentialId: id,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    const cause = err instanceof ApiError ? err.extensions?.cause : undefined;
    if (err instanceof ApiError && err.status === 410) {
      log.warn(
        cause === "connection_flagged"
          ? "credential_refresh_model_skipped_already_flagged"
          : "credential_refresh_model_needs_reconnection",
        { credentialId: id, cause, durationMs: Date.now() - startedAt },
      );
      return;
    }
    // Already recorded by the resolver, whose streak escalates to `needsReconnection`.
    throw err;
  }
}

const SOURCES: Record<CredentialRefreshKind, RefreshSource> = {
  integration_connection: {
    claim: claimIntegrationConnections,
    refreshOne: refreshIntegrationConnection,
  },
  model_provider_credential: { claim: claimModelCredentials, refreshOne: refreshModelCredential },
};

const KINDS = Object.keys(SOURCES) as CredentialRefreshKind[];

// ─────────────────────────────────────────────
// Scan + job handlers
// ─────────────────────────────────────────────

/** Claim the due rows of every source and enqueue one refresh job per row. */
export async function scanCredentialRefreshes(): Promise<
  Record<CredentialRefreshKind, { claimed: number; enqueued: number }>
> {
  const queue = await getRefreshQueue();
  const counts = {} as Record<CredentialRefreshKind, { claimed: number; enqueued: number }>;
  for (const kind of KINDS) {
    const ids = await SOURCES[kind].claim(CLAIM_LIMIT);
    let enqueued = 0;
    for (const id of ids) {
      try {
        await queue.add("refresh", { kind, id });
        enqueued++;
      } catch (err) {
        // The visit is spent: the row is retried tomorrow.
        logger.warn("credential_refresh_enqueue_failed", {
          kind,
          id,
          error: getErrorMessage(err),
        });
      }
    }
    counts[kind] = { claimed: ids.length, enqueued };
  }
  return counts;
}

async function handleScanJob(_job: QueueJob<ScanJobData>): Promise<void> {
  const startedAt = Date.now();
  try {
    const counts = await scanCredentialRefreshes();
    logger.info("credential_refresh_scan_done", { ...counts, durationMs: Date.now() - startedAt });
  } catch (err) {
    logger.error("credential_refresh_scan_failed", {
      error: getErrorMessage(err),
      durationMs: Date.now() - startedAt,
    });
  }
}

/** Refresh one claimed row. Never throws: the queue does not retry, the next visit is tomorrow. */
export async function handleCredentialRefreshJob(
  job: Pick<QueueJob<CredentialRefreshJobData>, "data">,
  log: Logger = logger,
): Promise<void> {
  const { kind, id } = job.data;
  try {
    await SOURCES[kind].refreshOne(id, log);
  } catch (err) {
    log.error("credential_refresh_failed", {
      kind,
      id,
      cause: err instanceof ApiError ? err.extensions?.cause : undefined,
      error: getErrorMessage(err),
    });
  }
}

/** Start the sweep workers and its hourly scan. Idempotent. */
export async function initCredentialRefreshSweep(): Promise<void> {
  const scan = await getScanQueue();
  const refresh = await getRefreshQueue();

  scan.process(handleScanJob, { concurrency: 1 });
  refresh.process((job) => handleCredentialRefreshJob(job), { concurrency: 4 });

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
  await refreshQueue?.shutdown();
  scanQueue = null;
  refreshQueue = null;
  logger.info("Credential refresh sweep stopped");
}
