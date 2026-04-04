// SPDX-License-Identifier: Apache-2.0

import { getEnv } from "@appstrate/env";

/** Returns true when a Redis URL is configured. */
export function hasRedis(): boolean {
  return !!getEnv().REDIS_URL;
}

/** Returns true when S3 credentials are configured. */
export function hasS3(): boolean {
  return !!getEnv().S3_BUCKET;
}

/** Returns the execution backend for agent runs. */
export function getExecutionMode(): "docker" | "process" {
  return getEnv().RUN_ADAPTER === "process" ? "process" : "docker";
}
