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
 * Filter strategy: the row's `expiresAt` lives inside the encrypted blob
 * (no separate column to index), so the scan does a coarse SQL filter on
 * `provider_id IN <oauth registry ids>` and then decrypts each candidate
 * to check expiry. This is fine — typical orgs have ≤2 OAuth credentials
 * (one Codex, one Claude) so the per-row decrypt cost is negligible.
 */

import { inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { modelProviderCredentials } from "@appstrate/db/schema";
import { decryptCredentials } from "@appstrate/connect";
import { createQueue, type JobQueue, type QueueJob } from "../../infra/queue/index.ts";
import { logger } from "../../lib/logger.ts";
import { ApiError } from "../../lib/errors.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { listModelProviders } from "./registry.ts";
import { type OAuthBlob } from "../model-provider-credentials.ts";
import { forceRefreshOAuthModelProviderToken } from "./token-resolver.ts";

const SCAN_QUEUE_NAME = "oauth-model-refresh-scan";
const REFRESH_QUEUE_NAME = "oauth-model-refresh";

/** Cron pattern: every 6 hours (00:00, 06:00, 12:00, 18:00 UTC). */
const SCAN_CRON = "0 */6 * * *";
const SCAN_SCHEDULER_ID = "oauth-model-refresh-scan";

/** Refresh lead time — anything expiring sooner gets refreshed proactively. */
const REFRESH_LEAD_HOURS = 24;

interface RefreshJobData {
  credentialId: string;
  providerId: string;
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

  const candidates = await db
    .select({
      id: modelProviderCredentials.id,
      providerId: modelProviderCredentials.providerId,
      credentialsEncrypted: modelProviderCredentials.credentialsEncrypted,
    })
    .from(modelProviderCredentials)
    .where(inArray(modelProviderCredentials.providerId, oauthProviderIds));

  if (candidates.length === 0) return { scanned: 0, enqueued: 0 };

  const cutoff = Date.now() + REFRESH_LEAD_HOURS * 60 * 60 * 1000;
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
    if (blob.expiresAt > cutoff) continue;
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
