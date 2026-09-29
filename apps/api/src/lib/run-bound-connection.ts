// SPDX-License-Identifier: Apache-2.0

import { ApiError } from "./errors.ts";
import { logger } from "./logger.ts";

/**
 * The member of a run's snapshot (`runs.resolved_connections[packageId]`) that `connectionId`
 * (lowercase, as the snapshot holds it) names, else 400 `connection_not_in_run`: a run reaches
 * only the connections it bound.
 */
export function requireRunBoundMember<T extends { connectionId: string }>(args: {
  runId: string;
  packageId: string;
  connectionId: string;
  bound: readonly T[];
  /** Where the caller supplied the id (`connection_id` query, `X-Connection-Id` header). */
  param: string;
}): T {
  const { runId, packageId, connectionId, bound, param } = args;
  const entry = bound.find((member) => member.connectionId === connectionId);
  if (entry) return entry;
  logger.warn("Connection refused — not bound by this run", {
    runId,
    packageId,
    connectionId,
    boundConnectionIds: bound.map((member) => member.connectionId),
  });
  throw new ApiError({
    status: 400,
    code: "connection_not_in_run",
    title: "Connection Not Bound To This Run",
    detail:
      `Connection '${connectionId}' is not bound to '${packageId}' by this run ` +
      `(bound: ${bound.length === 0 ? "none" : bound.map((e) => e.connectionId).join(", ")}).`,
    param,
  });
}
