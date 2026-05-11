// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth model provider refresh worker.
 *
 * Two responsibilities:
 *
 *   1. **Recurring scan** (every {@link SCAN_CRON}): finds rows in
 *      `model_provider_credentials` whose blob is `kind: "oauth"`,
 *      `needsReconnection: false`, and `expiresAt` falls inside the
 *      {@link REFRESH_LEAD_HOURS} window. Enqueues one refresh job per row.
 *
 *   2. **Per-credential refresh**: calls
 *      {@link forceRefreshOAuthModelProviderToken}, which itself flips
 *      `needsReconnection=true` on `invalid_grant` (cf. token-resolver).
 *      Failures are logged structured but do NOT bubble — the worker
 *      treats every refresh as best-effort; the sidecar still has its
 *      reactive 401-retry path.
 *
 * Filter strategy: `expires_at` is denormalized onto its own indexed
 * column (mirrored from `blob.expiresAt` by `createOAuthCredential` /
 * `updateOAuthCredentialTokens`). The scan filters at the SQL level
 * (`provider_id IN <oauth ids> AND (expires_at IS NULL OR expires_at <
 * now + lead)`) and only decrypts the qualifying subset. The
 * `IS NULL` branch handles rows that pre-date the column — they self-cure
 * on the first refresh. A LIMIT bounds memory use on large installations;
 * if the query is saturated, the next sweep picks up the remainder.
 */

import { inArray, and, or, isNull, lte, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { modelProviderCredentials } from "@appstrate/db/schema";
import { decryptCredentials } from "@appstrate/connect";
import { createQueue, type JobQueue, type QueueJob } from "../../infra/queue/index.ts";
import { logger } from "../../lib/logger.ts";
import { ApiError } from "../../lib/errors.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { listModelProviders } from "../model-providers/registry.ts";
import { type OAuthBlob } from "../model-provider-credentials.ts";
import { forceRefreshOAuthModelProviderToken } from "./token-resolver.ts";
import { cleanupExpiredPairings } from "./pairings.ts";

const SCAN_QUEUE_NAME = "oauth-model-refresh-scan";
const REFRESH_QUEUE_NAME = "oauth-model-refresh";
const PAIRING_CLEANUP_QUEUE_NAME = "oauth-model-pairing-cleanup";

/** Cron pattern: every 6 hours (00:00, 06:00, 12:00, 18:00 UTC). */
const SCAN_CRON = "0 */6 * * *";
const SCAN_SCHEDULER_ID = "oauth-model-refresh-scan";

/**
 * Pairing cleanup runs every 15 minutes — pairings have a 5-minute TTL +
 * a 1-hour grace window before deletion, so a 15-minute sweep keeps the
 * table tail bounded without thrashing.
 */
const PAIRING_CLEANUP_CRON = "*/15 * * * *";
const PAIRING_CLEANUP_SCHEDULER_ID = "oauth-model-pairing-cleanup";

/** Refresh lead time — anything expiring sooner gets refreshed proactively. */
const REFRESH_LEAD_HOURS = 24;

/**
 * Hard cap on rows scanned per sweep. Bounds memory use on installations
 * with millions of OAuth credentials; remaining rows are picked up on the
 * next scheduled sweep (or the row's own `expires_at` becomes the SQL
 * filter once it gets backfilled).
 */
const SCAN_BATCH_LIMIT = 500;

interface RefreshJobData {
  credentialId: string;
  providerId: string;
}

/** Empty payload — the scan job carries no data. */
type ScanJobData = Record<string, never>;

let scanQueue: JobQueue<ScanJobData> | null = null;
let refreshQueue: JobQueue<RefreshJobData> | null = null;
let pairingCleanupQueue: JobQueue<ScanJobData> | null = null;

async function getScanQueue(): Promise<JobQueue<ScanJobData>> {
  if (!scanQueue) scanQueue = await createQueue<ScanJobData>(SCAN_QUEUE_NAME);
  return scanQueue;
}

async function getRefreshQueue(): Promise<JobQueue<RefreshJobData>> {
  if (!refreshQueue) refreshQueue = await createQueue<RefreshJobData>(REFRESH_QUEUE_NAME);
  return refreshQueue;
}

async function getPairingCleanupQueue(): Promise<JobQueue<ScanJobData>> {
  if (!pairingCleanupQueue)
    pairingCleanupQueue = await createQueue<ScanJobData>(PAIRING_CLEANUP_QUEUE_NAME);
  return pairingCleanupQueue;
}

/**
 * Scan the DB for OAuth model provider credentials that need a refresh.
 * Exported for tests + manual triggering (e.g. on-demand admin action).
 */
export async function scanAndEnqueueRefreshes(): Promise<{
  scanned: number;
  enqueued: number;
}> {
  // Unfiltered: existing credentials for disabled providers must keep working.
  // The refresh worker rotates tokens for any OAuth credential still on the
  // shelf — even ones whose provider is currently in `MODEL_PROVIDERS_DISABLED`
  // — so an admin temporarily disabling a provider doesn't silently expire
  // user tokens.
  const oauthProviderIds = listModelProviders()
    .filter((p) => p.authMode === "oauth2")
    .map((p) => p.providerId);
  if (oauthProviderIds.length === 0) return { scanned: 0, enqueued: 0 };

  const cutoffDate = new Date(Date.now() + REFRESH_LEAD_HOURS * 60 * 60 * 1000);
  const cutoffMs = cutoffDate.getTime();

  // SQL-level filter: `expires_at IS NULL` covers rows that pre-date the
  // denormalized column (they decrypt once, then `updateOAuthCredentialTokens`
  // populates `expires_at` and they fall out of this branch). The
  // `expires_at <= cutoff` branch is the steady-state hot path and rides
  // on `idx_model_provider_credentials_expires_at_oauth`.
  const candidates = await db
    .select({
      id: modelProviderCredentials.id,
      providerId: modelProviderCredentials.providerId,
      credentialsEncrypted: modelProviderCredentials.credentialsEncrypted,
    })
    .from(modelProviderCredentials)
    .where(
      and(
        inArray(modelProviderCredentials.providerId, oauthProviderIds),
        or(
          isNull(modelProviderCredentials.expiresAt),
          lte(modelProviderCredentials.expiresAt, cutoffDate),
        ),
      ),
    )
    .orderBy(sql`${modelProviderCredentials.expiresAt} ASC NULLS FIRST`)
    .limit(SCAN_BATCH_LIMIT);

  if (candidates.length === 0) return { scanned: 0, enqueued: 0 };

  const dueRows: { id: string; providerId: string }[] = [];
  for (const row of candidates) {
    let blob: OAuthBlob;
    try {
      const decrypted = decryptCredentials<OAuthBlob>(row.credentialsEncrypted);
      if (decrypted.kind !== "oauth") continue;
      blob = decrypted;
    } catch (err) {
      logger.warn("oauth_model_refresh_scan_decrypt_failed", {
        credentialId: row.id,
        error: getErrorMessage(err),
      });
      continue;
    }
    if (blob.needsReconnection) continue;
    if (blob.expiresAt === null) continue;
    if (blob.expiresAt > cutoffMs) continue;
    dueRows.push({ id: row.id, providerId: row.providerId });
  }

  if (dueRows.length === 0) return { scanned: candidates.length, enqueued: 0 };

  const queue = await getRefreshQueue();
  let enqueued = 0;
  for (const row of dueRows) {
    try {
      await queue.add("refresh-token", { credentialId: row.id, providerId: row.providerId });
      enqueued++;
    } catch (err) {
      logger.warn("oauth_model_refresh_enqueue_failed", {
        credentialId: row.id,
        error: getErrorMessage(err),
      });
    }
  }

  return { scanned: candidates.length, enqueued };
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
  const { credentialId, providerId } = job.data;
  const startedAt = Date.now();
  try {
    await forceRefreshOAuthModelProviderToken(credentialId);
    logger.info("oauth_model_refresh_ok", {
      credentialId,
      providerId,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    if (err instanceof ApiError && err.code === "OAUTH_REFRESH_REVOKED") {
      // token-resolver already flipped needsReconnection=true.
      logger.warn("oauth_model_refresh_revoked", {
        credentialId,
        providerId,
        durationMs: Date.now() - startedAt,
      });
      return;
    }
    if (err instanceof ApiError && err.code === "OAUTH_CONNECTION_NEEDS_RECONNECTION") {
      logger.warn("oauth_model_refresh_skipped_already_flagged", {
        credentialId,
        providerId,
      });
      return;
    }
    logger.error("oauth_model_refresh_failed", {
      credentialId,
      providerId,
      error: getErrorMessage(err),
      durationMs: Date.now() - startedAt,
    });
  }
}

async function handlePairingCleanupJob(_job: QueueJob<ScanJobData>): Promise<void> {
  const startedAt = Date.now();
  try {
    const deleted = await cleanupExpiredPairings();
    logger.info("oauth_model_pairing_cleanup_done", {
      deleted,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    logger.error("oauth_model_pairing_cleanup_failed", {
      error: getErrorMessage(err),
      durationMs: Date.now() - startedAt,
    });
  }
}

/** Initialize the OAuth model provider refresh worker. Idempotent. */
export async function initOAuthModelRefreshWorker(): Promise<void> {
  const scan = await getScanQueue();
  const refresh = await getRefreshQueue();
  const pairingCleanup = await getPairingCleanupQueue();

  scan.process(handleScanJob, { concurrency: 1 });
  refresh.process(handleRefreshJob, { concurrency: 4 });
  pairingCleanup.process(handlePairingCleanupJob, { concurrency: 1 });

  // One-shot upsert of the recurring scan scheduler — BullMQ stores it in
  // Redis so this is safe across restarts.
  await scan.upsertScheduler(
    SCAN_SCHEDULER_ID,
    { pattern: SCAN_CRON, tz: "UTC" },
    { name: "scan", data: {} },
  );

  await pairingCleanup.upsertScheduler(
    PAIRING_CLEANUP_SCHEDULER_ID,
    { pattern: PAIRING_CLEANUP_CRON, tz: "UTC" },
    { name: "cleanup", data: {} },
  );

  logger.info("OAuth model refresh worker initialized", {
    scanCron: SCAN_CRON,
    refreshLeadHours: REFRESH_LEAD_HOURS,
    pairingCleanupCron: PAIRING_CLEANUP_CRON,
  });
}

/** Shutdown the worker. Idempotent. */
export async function shutdownOAuthModelRefreshWorker(): Promise<void> {
  await scanQueue?.shutdown();
  await refreshQueue?.shutdown();
  await pairingCleanupQueue?.shutdown();
  scanQueue = null;
  refreshQueue = null;
  pairingCleanupQueue = null;
  logger.info("OAuth model refresh worker stopped");
}
