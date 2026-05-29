// SPDX-License-Identifier: Apache-2.0

/**
 * Per-call audit log for `/api/credential-proxy/*`.
 *
 * {@link insertCredentialProxyUsage} appends one audit row to
 * `credential_proxy_usage` per upstream integration call. The table is
 * an audit / observability ledger (integration, target host, HTTP
 * status, duration), not a billing ledger — it carries no cost column.
 */

import { db } from "@appstrate/db/client";
import { credentialProxyUsage } from "@appstrate/db/schema";
import { getErrorMessage } from "@appstrate/core/errors";
import { logger } from "../lib/logger.ts";

export interface InsertCredentialProxyUsageInput {
  orgId: string;
  apiKeyId: string | null;
  userId: string | null;
  runId: string | null;
  applicationId: string | null;
  integrationId: string;
  targetHost: string | null;
  httpStatus: number | null;
  durationMs: number | null;
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
        integrationId: input.integrationId,
        targetHost: input.targetHost,
        httpStatus: input.httpStatus,
        durationMs: input.durationMs,
        requestId: input.requestId,
      })
      .onConflictDoNothing({ target: credentialProxyUsage.requestId });
  } catch (err) {
    // Metering failure MUST NOT break the actual proxy request — log and
    // drop. This is explicitly a best-effort telemetry path; correctness
    // for auth / data plane lives elsewhere.
    logger.error("Failed to record credential proxy usage", {
      requestId: input.requestId,
      error: getErrorMessage(err),
    });
  }
}
