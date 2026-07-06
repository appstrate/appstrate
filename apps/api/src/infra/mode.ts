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
 * Execution backend id for agent runs — an open string resolved against the
 * orchestrator registry at boot (core backends + module contributions). The
 * registry is the single source of truth for valid ids: an unknown value is
 * a fatal error at first orchestrator resolution, and the registry's
 * capability accessors degrade fail-closed ("no capability") for ids that
 * are not registered.
 */
export type ExecutionMode = Env["RUN_ADAPTER"];

/** Returns the execution backend for agent runs. */
export function getExecutionMode(): ExecutionMode {
  return getEnv().RUN_ADAPTER;
}
