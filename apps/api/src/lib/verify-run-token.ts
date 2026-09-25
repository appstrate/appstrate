// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs, type InferenceRoute } from "@appstrate/db/schema";
import { parseBearer } from "@appstrate/core/bearer";
import { parseSignedToken } from "./run-token.ts";
import { forbidden, notFound, unauthorized } from "./errors.ts";
import { runAgentIdentity } from "../services/state/runs.ts";

/**
 * Verify the run token from the Authorization header.
 * Returns the run data or throws an ApiError.
 */
export async function verifyRunToken(c: Context): Promise<{
  runId: string;
  run: {
    packageId: string;
    userId: string | null;
    endUserId: string | null;
    orgId: string;
    spaceId: string;
    status: string;
    modelCredentialId: string | null;
    /** The model the run launched with — see `runs.model_id`. */
    modelId: string | null;
    /** Who serves the run's inference — see `runs.inference_route`. */
    inferenceRoute: InferenceRoute | null;
    runOrigin: "platform" | "remote";
    /**
     * The agent definition the run executes — `"draft"` or a concrete semver
     * stamped at kickoff (#636). The dependency guards read the manifest AT
     * this ref so a post-kickoff draft edit cannot retroactively change a
     * pinned run's authorization set.
     */
    versionRef: string | null;
    /**
     * Snapshot of the connection resolver output frozen at run kickoff
     * (#199). The credentials resolver uses it to honour admin pins and
     * per-run overrides past the kickoff handoff.
     */
    resolvedConnections: Record<string, { connectionId: string; source: string }> | null;
    /**
     * Snapshot of each declared integration's resolved manifest version frozen
     * at run kickoff (#686). The credentials resolver reads the integration
     * manifest AT this version so a mid-run MITM refresh sees the same
     * delivery/auth plan the spawn used.
     */
    resolvedIntegrationVersions: Record<
      string,
      { version: string | null; source: "version" | "draft" | "system" }
    > | null;
  };
}> {
  const rawToken = parseBearer(c.req.header("Authorization"));
  if (!rawToken) {
    throw unauthorized("Missing run token");
  }

  // Verify HMAC signature before DB lookup
  const runId = parseSignedToken(rawToken);
  if (!runId) {
    throw unauthorized("Invalid run token");
  }

  const rows = await db
    .select({
      packageId: runs.packageId,
      // The INSERT-time `@scope/name` snapshot. `runs.package_id` is
      // `ON DELETE SET NULL` (schema/runs.ts), so deleting the agent mid-run
      // nulls the column while the run keeps executing — and this token stays
      // valid until the run leaves `running`. Without the snapshot the guards
      // below would report the agent id as `null`.
      agentScope: runs.agentScope,
      agentName: runs.agentName,
      userId: runs.userId,
      endUserId: runs.endUserId,
      orgId: runs.orgId,
      spaceId: runs.spaceId,
      status: runs.status,
      modelCredentialId: runs.modelCredentialId,
      modelId: runs.modelId,
      inferenceRoute: runs.inferenceRoute,
      runOrigin: runs.runOrigin,
      versionRef: runs.versionRef,
      resolvedConnections: runs.resolvedConnections,
      resolvedIntegrationVersions: runs.resolvedIntegrationVersions,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);

  const run = rows[0];
  if (!run) {
    throw notFound("Run not found");
  }

  if (run.status !== "running") {
    throw forbidden("Run is not running");
  }

  return {
    runId,
    run: {
      // Shared with `getRunSinkContext` (one fallback chain, one sentinel). The
      // previous `run.packageId!` asserted away a null that this endpoint can
      // genuinely see, and it reached `getRunEffectiveAgent` — which now
      // reports `agent_deleted` and needs a printable id for its message.
      packageId: runAgentIdentity(run),
      userId: run.userId,
      endUserId: run.endUserId,
      orgId: run.orgId,
      spaceId: run.spaceId,
      status: run.status,
      modelCredentialId: run.modelCredentialId ?? null,
      modelId: run.modelId,
      inferenceRoute: run.inferenceRoute,
      runOrigin: run.runOrigin,
      versionRef: run.versionRef ?? null,
      resolvedConnections: run.resolvedConnections ?? null,
      resolvedIntegrationVersions: run.resolvedIntegrationVersions ?? null,
    },
  };
}
