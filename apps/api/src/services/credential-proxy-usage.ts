// SPDX-License-Identifier: Apache-2.0

/**
 * Per-call metering for `/api/credential-proxy/*` + run-cost aggregator.
 *
 * Reporting queries compose against two ledger tables:
 *
 *   SUM(llm_usage.cost_usd) + SUM(credential_proxy_usage.cost_usd)
 *   WHERE run_id = $1
 *
 * yields the full attributable spend for one run — regardless of whether
 * the LLM traffic transited `/api/llm-proxy` (source='proxy') or was
 * reported by an in-run runner via `appstrate.metric` (source='runner').
 *
 * The `requestId` column is the dedup key: the proxy route derives one per
 * upstream request; replays (CLI retries) are no-ops via the UNIQUE
 * constraint on `credential_proxy_usage.request_id`.
 */

import { eq, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { llmUsage, credentialProxyUsage } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";

export interface InsertCredentialProxyUsageInput {
  orgId: string;
  apiKeyId: string | null;
  userId: string | null;
  runId: string | null;
  applicationId: string | null;
  providerId: string;
  targetHost: string | null;
  httpStatus: number | null;
  durationMs: number | null;
  costUsd: number;
  requestId: string;
}

/**
 * Insert one usage row. Safe to replay — the `request_id` UNIQUE constraint
 * makes the second insert a no-op (`ON CONFLICT DO NOTHING`). CLI retries
 * therefore do not double-count.
 */
export async function insertCredentialProxyUsage(
  input: InsertCredentialProxyUsageInput,
): Promise<void> {
  try {
    await db
      .insert(credentialProxyUsage)
      .values({
        orgId: input.orgId,
        apiKeyId: input.apiKeyId,
        userId: input.userId,
        runId: input.runId,
        applicationId: input.applicationId,
        providerId: input.providerId,
        targetHost: input.targetHost,
        httpStatus: input.httpStatus,
        durationMs: input.durationMs,
        costUsd: input.costUsd,
        requestId: input.requestId,
      })
      .onConflictDoNothing({ target: credentialProxyUsage.requestId });
  } catch (err) {
    // Metering failure MUST NOT break the actual proxy request — log and
    // drop. This is explicitly a best-effort telemetry path; correctness
    // for auth / data plane lives elsewhere.
    logger.error("Failed to record credential proxy usage", {
      requestId: input.requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface RunCostBreakdown {
  llmUsd: number;
  credentialUsd: number;
  total: number;
}

/**
 * Compute the total attributable spend for a run across every ledger
 * surface (llm_usage: proxy + runner rows, credential_proxy_usage).
 * Called by `finalizeRun` to cache the canonical `runs.cost` value at
 * terminal time. This is the SINGLE read path for aggregate run cost —
 * no caller should SUM the ledgers directly.
 *
 * Two scalar SUMs over indexed `run_id` columns — cheap even on long runs.
 */
export async function computeRunCost(runId: string): Promise<RunCostBreakdown> {
  const [llm] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${llmUsage.costUsd}), 0)`,
    })
    .from(llmUsage)
    .where(eq(llmUsage.runId, runId));

  const [credential] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${credentialProxyUsage.costUsd}), 0)`,
    })
    .from(credentialProxyUsage)
    .where(eq(credentialProxyUsage.runId, runId));

  const llmUsd = Number(llm?.total ?? 0);
  const credentialUsd = Number(credential?.total ?? 0);
  return {
    llmUsd,
    credentialUsd,
    total: llmUsd + credentialUsd,
  };
}
