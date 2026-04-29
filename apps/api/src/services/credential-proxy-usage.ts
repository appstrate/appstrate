// SPDX-License-Identifier: Apache-2.0

/**
 * Per-call audit log for `/api/credential-proxy/*` + run-cost aggregator.
 *
 * Two distinct concerns share this module:
 *
 *   1. {@link insertCredentialProxyUsage} — append one audit row to
 *      `credential_proxy_usage` per upstream provider call. Today every
 *      row carries `cost_usd = 0` because no provider is metered; the
 *      table is an audit / observability ledger (provider, target host,
 *      HTTP status, duration), not a billing ledger.
 *
 *   2. {@link computeRunCost} — single read path for the canonical
 *      `runs.cost` value. Reads only `llm_usage` (proxy + runner rows).
 *      `credential_proxy_usage.cost_usd` is intentionally NOT summed:
 *      it is always 0, and including a constant-zero SUM in the run
 *      finalize hot path is dead work. When the first metered provider
 *      ships, route its rows through `llm_usage` with a new `source`
 *      enum value (e.g. `credential_proxy`) — that keeps the single
 *      ledger invariant and avoids resurrecting a redundant SUM here.
 */

import { eq, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { llmUsage, credentialProxyUsage } from "@appstrate/db/schema";
// `credentialProxyUsage` is still used by `insertCredentialProxyUsage`
// below; not by `computeRunCost` (see header comment).
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

/**
 * Compute the total attributable spend for a run from the unified
 * `llm_usage` ledger (proxy + runner rows). Called by `finalizeRun` to
 * cache the canonical `runs.cost` value at terminal time. This is the
 * SINGLE read path for aggregate run cost — no caller should SUM the
 * ledger directly.
 *
 * One scalar SUM over the `(run_id)` index — cheap even on long runs.
 */
export async function computeRunCost(runId: string): Promise<number> {
  const [llm] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${llmUsage.costUsd}), 0)`,
    })
    .from(llmUsage)
    .where(eq(llmUsage.runId, runId));

  return Number(llm?.total ?? 0);
}
