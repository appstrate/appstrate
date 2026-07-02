// SPDX-License-Identifier: Apache-2.0

import { getEnv, type Env } from "@appstrate/env";

/** Returns true when a Redis URL is configured. */
export function hasRedis(): boolean {
  return !!getEnv().REDIS_URL;
}

/** Returns true when an external PostgreSQL is configured (vs PGlite embedded). */
export function hasExternalDb(): boolean {
  return !!getEnv().DATABASE_URL;
}

/** Returns true when S3 credentials are configured. */
export function hasS3(): boolean {
  return !!getEnv().S3_BUCKET;
}

/**
 * Execution backend for agent runs — derived from the env schema's
 * `RUN_ADAPTER` enum so the list of backends has a single source of truth.
 */
export type ExecutionMode = Env["RUN_ADAPTER"];

/** Returns the execution backend for agent runs. */
export function getExecutionMode(): ExecutionMode {
  return getEnv().RUN_ADAPTER;
}
