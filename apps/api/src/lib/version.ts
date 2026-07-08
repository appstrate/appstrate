// SPDX-License-Identifier: Apache-2.0

import { getEnv } from "@appstrate/env";

export interface VersionInfo {
  /** Semver/tag of the deployed build (e.g. "v1.0.0-beta.38"). "dev" for source runs. */
  app: string;
  /** Short git SHA of the build commit. Omitted when unknown. */
  commit?: string;
}

/**
 * Deployed build identity, read from the image's build-time env
 * (`APP_VERSION` / `GIT_SHA`, stamped by the release workflow). Falls back to
 * "dev" with no commit when running from source. Single source of truth for
 * both the /health endpoint and the SPA footer (via `buildAppConfig`).
 */
export function getVersionInfo(): VersionInfo {
  const env = getEnv();
  const commit = env.GIT_SHA ? env.GIT_SHA.slice(0, 7) : undefined;
  return {
    app: env.APP_VERSION ?? "dev",
    ...(commit ? { commit } : {}),
  };
}
