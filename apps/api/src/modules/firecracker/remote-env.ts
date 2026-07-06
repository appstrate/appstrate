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
  // an on-path capture + replay exposure. Tri-state:
  //   unset        → plaintext to a non-loopback host is REFUSED (default)
  //   `1`/`true`   → same refusal, stated explicitly
  //   `0`/`false`  → explicit opt-out: allow plaintext with a loud boot
  //                  warning (same-host Docker-bridge / trusted private link)
  // Loopback http:// and https:// always pass regardless.
  FIRECRACKER_RUNNER_TLS_REQUIRED: z
    .string()
    .optional()
    // An empty assignment (`FIRECRACKER_RUNNER_TLS_REQUIRED=` in a .env)
    // reads as unset — anything else must be an explicit yes/no, so a typo
    // can never silently opt out of the transport gate.
    .refine((v) => !v || ["1", "true", "0", "false"].includes(v.toLowerCase()), {
      message:
        "FIRECRACKER_RUNNER_TLS_REQUIRED must be '1'/'true' (require TLS) or '0'/'false' (explicitly allow plaintext)",
    })
    .transform((v) => (!v ? undefined : v === "1" || v.toLowerCase() === "true")),
});

export type RemoteRunnerEnv = z.infer<typeof remoteEnvSchema>;

/** Loopback hosts exempt from the plaintext-transport gate. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Refusal from the plaintext-transport gate. A distinct class so the
 * orchestrator's requireEnv() can rethrow it verbatim — its message is
 * already the actionable one, and wrapping it in the generic "set
 * FIRECRACKER_RUNNER_URL / _TOKEN" hint would point at the wrong fix.
 */
export class RunnerTransportSecurityError extends Error {}

/**
 * Enforce the plaintext-transport policy on the runner URL. Pure —
 * exported for unit tests; getRemoteEnv() applies it with the module
 * logger. `https://` and loopback `http://` always pass. Non-loopback
 * `http://` is REFUSED unless `FIRECRACKER_RUNNER_TLS_REQUIRED=0` opts
 * out explicitly (`tlsRequired === false`), in which case it warns.
 */
export function assertRunnerTransportSecurity(
  runnerUrl: string,
  tlsRequired: boolean | undefined,
  warn: (message: string) => void = (message) => logger.warn(message),
): void {
  const parsed = new URL(runnerUrl);
  if (parsed.protocol !== "http:") return;
  if (LOOPBACK_HOSTNAMES.has(parsed.hostname)) return;
  const risk =
    `the platform↔daemon wire carries the bearer token AND per-run credentials ` +
    `(model API keys, sink secrets, connect logins) — anyone on the network path can ` +
    `capture and replay them`;
  if (tlsRequired === false) {
    warn(
      `FIRECRACKER_RUNNER_TLS_REQUIRED=0: allowing plaintext http:// to a non-loopback ` +
        `host (${parsed.hostname}) — ${risk}. This opt-out is only acceptable when platform ` +
        `and daemon share a host (e.g. the Docker-bridge path of a same-host install) or a ` +
        `genuinely private link; otherwise put TLS in front of the daemon and use https://.`,
    );
    return;
  }
  const refusedBy = tlsRequired
    ? `refused (FIRECRACKER_RUNNER_TLS_REQUIRED=1):`
    : `refused by default:`;
  throw new RunnerTransportSecurityError(
    `FIRECRACKER_RUNNER_URL is plaintext http:// to a non-loopback host (${parsed.hostname}) — ` +
      `${refusedBy} ${risk}. Put TLS in front of the daemon (reverse proxy) and use https://` +
      (tlsRequired
        ? `.`
        : `, or — ONLY when platform and daemon share a host (Docker bridge) or a trusted ` +
          `private link — set FIRECRACKER_RUNNER_TLS_REQUIRED=0 to explicitly accept plaintext.`),
  );
}

let cached: RemoteRunnerEnv | undefined;

/**
 * Parse (once) and return the remote-runner environment. Throws a Zod
 * error on missing/invalid values — callers (the orchestrator's
 * `initialize()`) wrap it with an actionable message. The transport
 * policy runs on the SAME first read (a plaintext split-host link is
 * refused — or, with the explicit opt-out, warned about — before any
 * credential crosses the wire).
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
