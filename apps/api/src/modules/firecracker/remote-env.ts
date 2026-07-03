// SPDX-License-Identifier: Apache-2.0

/**
 * Environment for the `firecracker-remote` backend — the platform-side
 * HTTP client of the `appstrate-runner` daemon.
 *
 * Parsed LAZILY, on the first `RemoteFirecrackerOrchestrator.initialize()`
 * — NEVER at module import or module `init()`. The firecracker module
 * also serves the in-process backend (`RUN_ADAPTER=firecracker`), and a
 * deployment using that backend must load this module without any
 * `FIRECRACKER_RUNNER_*` variables set. Only selecting
 * `RUN_ADAPTER=firecracker-remote` (which instantiates and initializes
 * the remote orchestrator) makes these variables required.
 */

import { z } from "zod";

const remoteEnvSchema = z.object({
  // Base URL of the appstrate-runner daemon. http(s) only. Trailing
  // slashes are stripped so route concatenation can never produce
  // `//v1/...` (which some proxies refuse to route).
  FIRECRACKER_RUNNER_URL: z
    .url({ protocol: /^https?$/ })
    .transform((url) => url.replace(/\/+$/, "")),
  // Shared bearer secret between platform and daemon. The daemon fronts
  // run credentials (sidecar launch specs carry the run token), so a
  // trivially guessable token is refused outright.
  FIRECRACKER_RUNNER_TOKEN: z.string().min(16),
});

export type RemoteRunnerEnv = z.infer<typeof remoteEnvSchema>;

let cached: RemoteRunnerEnv | undefined;

/**
 * Parse (once) and return the remote-runner environment. Throws a Zod
 * error on missing/invalid values — callers (the orchestrator's
 * `initialize()`) wrap it with an actionable message.
 */
export function getRemoteEnv(): RemoteRunnerEnv {
  if (!cached) {
    cached = remoteEnvSchema.parse(process.env);
  }
  return cached;
}

/** Test seam — drop the cache so the next read re-parses process.env. */
export function _resetRemoteEnvCacheForTesting(): void {
  cached = undefined;
}
