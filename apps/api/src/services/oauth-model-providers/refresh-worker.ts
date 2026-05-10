// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth model provider refresh worker (SPEC §6, Phase 6.1).
 *
 * Two responsibilities:
 *
 *   1. **Recurring scan** (every {@link SCAN_CRON}): finds connections
 *      bound to an `org_system_provider_keys` row in `authMode='oauth'`
 *      whose `expiresAt` falls inside the {@link REFRESH_LEAD_HOURS}
 *      window. Enqueues one refresh job per connection.
 *
 *   2. **Per-connection refresh**: calls
 *      {@link forceRefreshOAuthModelProviderToken}, which itself flips
 *      `needsReconnection=true` on `invalid_grant` (cf. token-resolver).
 *      Failures are logged structured but do NOT bubble — the worker
 *      treats every refresh as best-effort; the sidecar still has its
 *      reactive 401-retry path.
 *
 * The worker is queue-backed (BullMQ in production, in-memory in dev/
 * test) and shares the same lifecycle conventions as the schedule
 * worker: started in `boot.ts` (parallel init), stopped in `shutdown.ts`.
 */

import { and, eq, lte, isNotNull, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { orgSystemProviderKeys, userProviderConnections } from "@appstrate/db/schema";
import { createQueue, type JobQueue, type QueueJob } from "../../infra/queue/index.ts";
import { logger } from "../../lib/logger.ts";
import { ApiError } from "../../lib/errors.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { forceRefreshOAuthModelProviderToken } from "./token-resolver.ts";

const SCAN_QUEUE_NAME = "oauth-model-refresh-scan";
const REFRESH_QUEUE_NAME = "oauth-model-refresh";

/** Cron pattern: every 6 hours (00:00, 06:00, 12:00, 18:00 UTC). */
const SCAN_CRON = "0 */6 * * *";
const SCAN_SCHEDULER_ID = "oauth-model-refresh-scan";

/** Refresh lead time — anything expiring sooner gets refreshed proactively. */
const REFRESH_LEAD_HOURS = 24;

interface RefreshJobData {
  connectionId: string;
  providerPackageId: string;
}

/** Empty payload — the scan job carries no data. */
type ScanJobData = Record<string, never>;

let scanQueue: JobQueue<ScanJobData> | null = null;
let refreshQueue: JobQueue<RefreshJobData> | null = null;

async function getScanQueue(): Promise<JobQueue<ScanJobData>> {
  if (!scanQueue) scanQueue = await createQueue<ScanJobData>(SCAN_QUEUE_NAME);
  return scanQueue;
}

async function getRefreshQueue(): Promise<JobQueue<RefreshJobData>> {
  if (!refreshQueue) refreshQueue = await createQueue<RefreshJobData>(REFRESH_QUEUE_NAME);
  return refreshQueue;
}

/**
 * Scan the DB for OAuth model provider connections that need a refresh.
 * Exported for tests + manual triggering (e.g. on-demand admin action).
 */
export async function scanAndEnqueueRefreshes(): Promise<{
  scanned: number;
  enqueued: number;
}> {
  const rows = await db
    .select({
      connectionId: userProviderConnections.id,
      providerPackageId: userProviderConnections.providerId,
    })
    .from(userProviderConnections)
    .innerJoin(
      orgSystemProviderKeys,
      eq(orgSystemProviderKeys.oauthConnectionId, userProviderConnections.id),
    )
    .where(
      and(
        eq(orgSystemProviderKeys.authMode, "oauth"),
        eq(userProviderConnections.needsReconnection, false),
        isNotNull(userProviderConnections.expiresAt),
        lte(
          userProviderConnections.expiresAt,
          sql`now() + (${REFRESH_LEAD_HOURS} * interval '1 hour')`,
        ),
      ),
    );

  if (rows.length === 0) {
    return { scanned: 0, enqueued: 0 };
  }

  const queue = await getRefreshQueue();
  let enqueued = 0;
  for (const row of rows) {
    try {
      await queue.add("refresh-token", {
        connectionId: row.connectionId,
        providerPackageId: row.providerPackageId,
      });
      enqueued++;
    } catch (err) {
      logger.warn("oauth_model_refresh_enqueue_failed", {
        connectionId: row.connectionId,
        error: getErrorMessage(err),
      });
    }
  }

  return { scanned: rows.length, enqueued };
}

async function handleScanJob(_job: QueueJob<ScanJobData>): Promise<void> {
  const startedAt = Date.now();
  try {
    const { scanned, enqueued } = await scanAndEnqueueRefreshes();
    logger.info("oauth_model_refresh_scan_done", {
      scanned,
      enqueued,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    logger.error("oauth_model_refresh_scan_failed", {
      error: getErrorMessage(err),
      durationMs: Date.now() - startedAt,
    });
  }
}

async function handleRefreshJob(job: QueueJob<RefreshJobData>): Promise<void> {
  const { connectionId, providerPackageId } = job.data;
  const startedAt = Date.now();
  try {
    await forceRefreshOAuthModelProviderToken(connectionId);
    logger.info("oauth_model_refresh_ok", {
      connectionId,
      providerPackageId,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    if (err instanceof ApiError && err.code === "OAUTH_REFRESH_REVOKED") {
      // token-resolver already flipped needsReconnection=true.
      logger.warn("oauth_model_refresh_revoked", {
        connectionId,
        providerPackageId,
        durationMs: Date.now() - startedAt,
      });
      return;
    }
    if (err instanceof ApiError && err.code === "OAUTH_CONNECTION_NEEDS_RECONNECTION") {
      logger.warn("oauth_model_refresh_skipped_already_flagged", {
        connectionId,
        providerPackageId,
      });
      return;
    }
    logger.error("oauth_model_refresh_failed", {
      connectionId,
      providerPackageId,
      error: getErrorMessage(err),
      durationMs: Date.now() - startedAt,
    });
  }
}

/** Initialize the OAuth model provider refresh worker. Idempotent. */
export async function initOAuthModelRefreshWorker(): Promise<void> {
  const scan = await getScanQueue();
  const refresh = await getRefreshQueue();

  scan.process(handleScanJob, { concurrency: 1 });
  refresh.process(handleRefreshJob, { concurrency: 4 });

  // One-shot upsert of the recurring scan scheduler — BullMQ stores it in
  // Redis so this is safe across restarts.
  await scan.upsertScheduler(
    SCAN_SCHEDULER_ID,
    { pattern: SCAN_CRON, tz: "UTC" },
    { name: "scan", data: {} },
  );

  logger.info("OAuth model refresh worker initialized", {
    scanCron: SCAN_CRON,
    refreshLeadHours: REFRESH_LEAD_HOURS,
  });
}

/** Shutdown the worker. Idempotent. */
export async function shutdownOAuthModelRefreshWorker(): Promise<void> {
  await scanQueue?.shutdown();
  await refreshQueue?.shutdown();
  scanQueue = null;
  refreshQueue = null;
  logger.info("OAuth model refresh worker stopped");
}
