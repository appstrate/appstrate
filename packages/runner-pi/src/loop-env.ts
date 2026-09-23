// SPDX-License-Identifier: Apache-2.0

/**
 * The environment form of the Pi loop knobs, read by every process that builds
 * a {@link PiRunnerOptions} from env: the container entrypoint (written by
 * `buildRuntimePiEnv`) and the CLI's local run (the user's shell). One reader,
 * so both refuse the same malformed values. The platform validates its own
 * copy of these keys with Zod in `@appstrate/env`.
 */

import type { PiRunnerOptions } from "./pi-runner.ts";

export type PiLoopOptions = Required<Pick<PiRunnerOptions, "modelRetry" | "modelCompaction">> &
  Pick<PiRunnerOptions, "toolResultByteLimit">;

function parseBool(name: string, raw: string | undefined, issues: string[]): boolean {
  if (raw === undefined || raw === "true") return true;
  if (raw === "false") return false;
  issues.push(`${name}: must be "true" or "false" (got "${raw}")`);
  return true;
}

/**
 * `MODEL_RETRY_ENABLED` / `MODEL_COMPACTION_ENABLED` accept exactly `"true"` or
 * `"false"` (absent = on); `TOOL_RESULT_BYTE_LIMIT` a positive integer (absent
 * or empty = the runner's default). Every malformed value adds one entry to
 * `issues`.
 */
export function parsePiLoopEnv(env: Record<string, string | undefined>): {
  options: PiLoopOptions;
  issues: string[];
} {
  const issues: string[] = [];
  const modelRetry = parseBool("MODEL_RETRY_ENABLED", env.MODEL_RETRY_ENABLED, issues);
  const modelCompaction = parseBool(
    "MODEL_COMPACTION_ENABLED",
    env.MODEL_COMPACTION_ENABLED,
    issues,
  );
  const rawLimit = env.TOOL_RESULT_BYTE_LIMIT;
  const limit = Number(rawLimit);
  const validLimit = Number.isInteger(limit) && limit > 0;
  if (rawLimit && !validLimit) {
    issues.push(`TOOL_RESULT_BYTE_LIMIT: must be a positive integer (got "${rawLimit}")`);
  }
  return {
    options: {
      modelRetry,
      modelCompaction,
      ...(rawLimit && validLimit ? { toolResultByteLimit: limit } : {}),
    },
    issues,
  };
}
