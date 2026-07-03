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

/**
 * `http(s)://<IPv4>[:port]` with an optional trailing slash (stripped).
 * The host MUST be an IPv4 literal: this URL is handed to guest
 * workloads as the platform sink base, and Firecracker guests have no
 * DNS resolver — a hostname would fail inside every microVM.
 */
const IPV4_URL_RE = /^https?:\/\/(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\/?$/;

const runnerEnvSchema = z.object({
  // Shared bearer secret between the platform's firecracker-remote client
  // and this daemon. REQUIRED — there is deliberately no default and no
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
  // "http://10.0.0.5:3000". REQUIRED and IPv4-literal-only (see
  // IPV4_URL_RE) — the daemon cannot guess where the platform lives when
  // the platform runs in a container on another host.
  FIRECRACKER_RUNNER_PLATFORM_URL: z
    .string()
    .regex(IPV4_URL_RE, "must be http(s)://<IPv4>[:port] — guests have no DNS")
    .transform((url) => url.replace(/\/+$/, "")),
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
