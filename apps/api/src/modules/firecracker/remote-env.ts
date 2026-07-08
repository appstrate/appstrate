// SPDX-License-Identifier: Apache-2.0

/**
 * Environment for the `firecracker` backend — the platform-side HTTP
 * client of the `appstrate-runner` daemon.
 *
 * Parsed LAZILY, on the first `RemoteFirecrackerOrchestrator.initialize()`
 * — NEVER at module import or module `init()`. Loading the firecracker
 * module (adding it to `MODULES`) registers this backend unconditionally,
 * but a deployment that loads the module without selecting it as its
 * `RUN_ADAPTER` must not be forced to set `FIRECRACKER_RUNNER_*`. Only
 * selecting `RUN_ADAPTER=firecracker` (which instantiates and initializes
 * the orchestrator) makes these variables required.
 */

import { z } from "zod";
import { logger } from "./runner/logger.ts";

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
  // Transport-security gate (SEC-2): the wire carries the bearer token
  // plus per-run credentials (MODEL_API_KEY, APPSTRATE_SINK_SECRET,
  // CONNECT_LOGIN_JSON), so plaintext http:// to a NON-loopback daemon is
  // an on-path capture + replay exposure. SECURE BY DEFAULT: a non-loopback
  // http:// runner URL is REFUSED at boot. The only escape is an explicit
  // `=0`/`false` — set it for a trusted private link (VPN, WireGuard, same
  // rack) where TLS is not yet terminated. Loopback http:// is always
  // allowed; https:// is always allowed.
  FIRECRACKER_RUNNER_TLS_REQUIRED: z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined) return true; // secure by default
      const normalized = v.toLowerCase();
      return !(normalized === "0" || normalized === "false");
    }),
});

export type RemoteRunnerEnv = z.infer<typeof remoteEnvSchema>;

/** Loopback hosts exempt from the plaintext-transport gate. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Enforce the plaintext-transport policy on the runner URL. Pure —
 * exported for unit tests; getRemoteEnv() applies it with the module
 * logger. `https://` and loopback `http://` always pass; non-loopback
 * `http://` is REFUSED by default (`tlsRequired`) and only downgraded to a
 * loud warning when the escape (`FIRECRACKER_RUNNER_TLS_REQUIRED=0`) is set.
 */
export function assertRunnerTransportSecurity(
  runnerUrl: string,
  tlsRequired: boolean,
  warn: (message: string) => void = (message) => logger.warn(message),
): void {
  const parsed = new URL(runnerUrl);
  if (parsed.protocol !== "http:") return;
  if (LOOPBACK_HOSTNAMES.has(parsed.hostname)) return;
  const message =
    `FIRECRACKER_RUNNER_URL is plaintext http:// to a non-loopback host (${parsed.hostname}) — ` +
    `the platform↔daemon wire carries the bearer token AND per-run credentials ` +
    `(model API keys, sink secrets, connect logins). Anyone on the network path can ` +
    `capture and replay them. Put TLS in front of the daemon (reverse proxy) and use ` +
    `https://, or keep platform and daemon on the same host / a trusted private link.`;
  if (tlsRequired) {
    throw new Error(
      `Refusing a plaintext non-loopback Firecracker runner URL: ${message} ` +
        `This is fail-closed by default; set FIRECRACKER_RUNNER_TLS_REQUIRED=0 ONLY for a ` +
        `trusted private link where you accept the plaintext exposure.`,
    );
  }
  warn(
    `${message} FIRECRACKER_RUNNER_TLS_REQUIRED=0 is set, so this is a warning, not a refusal — ` +
      `proceeding over plaintext.`,
  );
}

let cached: RemoteRunnerEnv | undefined;

/**
 * Parse (once) and return the remote-runner environment. Throws a Zod
 * error on missing/invalid values — callers (the orchestrator's
 * `initialize()`) wrap it with an actionable message. The transport
 * policy runs on the SAME first read (a plaintext split-host link either
 * warns loudly or refuses, before any credential crosses the wire).
 */
export function getRemoteEnv(): RemoteRunnerEnv {
  if (!cached) {
    const parsed = remoteEnvSchema.parse(process.env);
    assertRunnerTransportSecurity(
      parsed.FIRECRACKER_RUNNER_URL,
      parsed.FIRECRACKER_RUNNER_TLS_REQUIRED,
    );
    cached = parsed;
  }
  return cached;
}

/** Test seam — drop the cache so the next read re-parses process.env. */
export function _resetRemoteEnvCacheForTesting(): void {
  cached = undefined;
}
