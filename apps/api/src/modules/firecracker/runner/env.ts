// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate-runner` daemon environment — validated here, NOT in
 * @appstrate/env. The daemon is a standalone process on the KVM host
 * (issue #819, phase 1): it owns its own configuration surface the same
 * way the firecracker module owns FIRECRACKER_* (see ../env.ts). Parsed
 * once at daemon boot (fail-fast with Zod messages) and cached for the
 * process lifetime.
 */

import { z } from "zod";
import { getErrorMessage } from "@appstrate/core/errors";
import { parsePlatformApiUrl } from "./platform-url.ts";

const runnerEnvSchema = z.object({
  // Shared bearer secret between the platform's firecracker backend (its
  // HTTP client) and this daemon. REQUIRED — there is deliberately no
  // default and no
  // "auth off" mode: /v1/sidecars carries run tokens and credential
  // bundles, so an unauthenticated daemon is a credential oracle.
  FIRECRACKER_RUNNER_TOKEN: z.string().min(16, "must be at least 16 characters"),
  FIRECRACKER_RUNNER_PORT: z.coerce.number().int().positive().default(3100),
  // Bind address. The default binds all interfaces for the common
  // "platform container → host daemon" topology, but the token is
  // mandatory regardless — still, prefer binding narrowly (a private
  // interface or 127.0.0.1 behind a reverse proxy) and firewalling the
  // port: the bearer token is the only lock on this door.
  FIRECRACKER_RUNNER_HOST: z.string().default("0.0.0.0"),
  // Base URL guest workloads use to reach the platform API, e.g.
  // "http://10.0.0.5:3000". REQUIRED and IPv4-literal-only — the daemon
  // cannot guess where the platform lives when it runs in a container on
  // another host, and guests have no DNS. Validated + normalized by the
  // shared parsePlatformApiUrl — the same parser the orchestrator uses to
  // open the host firewall, so the two can never disagree on what is valid.
  FIRECRACKER_RUNNER_PLATFORM_URL: z.string().transform((raw, ctx) => {
    try {
      return parsePlatformApiUrl(raw).url;
    } catch (err) {
      ctx.addIssue({ code: "custom", message: getErrorMessage(err) });
      return z.NEVER;
    }
  }),
});

export type RunnerEnv = z.infer<typeof runnerEnvSchema>;

let cached: RunnerEnv | undefined;

/** Parse (once) and return the daemon's environment. Throws on invalid values. */
export function getRunnerEnv(): RunnerEnv {
  if (!cached) {
    cached = runnerEnvSchema.parse(process.env);
  }
  return cached;
}

/** Test seam — drop the cache so the next read re-parses process.env. */
export function _resetRunnerEnvCacheForTesting(): void {
  cached = undefined;
}
