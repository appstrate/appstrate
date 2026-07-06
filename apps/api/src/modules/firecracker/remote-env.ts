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
  // an on-path capture + replay exposure. Single opt-out:
  //   unset / `0`/`false` → plaintext to a non-loopback host is REFUSED
  //   `1`/`true`          → explicit opt-out: allow plaintext with a loud
  //                         boot warning (same-host Docker-bridge /
  //                         trusted private link ONLY)
  // Loopback http:// and https:// always pass regardless.
  FIRECRACKER_RUNNER_ALLOW_PLAINTEXT: z
    .string()
    .optional()
    // An empty assignment (`FIRECRACKER_RUNNER_ALLOW_PLAINTEXT=` in a .env)
    // reads as unset — anything else must be an explicit yes/no, so a typo
    // can never silently opt out of the transport gate.
    .refine((v) => !v || ["1", "true", "0", "false"].includes(v.toLowerCase()), {
      message:
        "FIRECRACKER_RUNNER_ALLOW_PLAINTEXT must be '1'/'true' (allow non-loopback plaintext — same-host only) or '0'/'false' (refuse, the default)",
    })
    .transform((v) => (!v ? false : v === "1" || v.toLowerCase() === "true")),
});

export type RemoteRunnerEnv = z.infer<typeof remoteEnvSchema>;

/**
 * Loopback detection for the plaintext-transport-gate exemption. WHATWG
 * URL normalizes hostnames before we see them (`127.1` → `127.0.0.1`,
 * octal `0177.0.0.1` → `127.0.0.1`, `[::ffff:127.0.0.1]` →
 * `[::ffff:7f00:1]`), so matching the normalized forms covers every
 * spelling: the whole 127.0.0.0/8 block, `localhost`, IPv6 loopback, and
 * the IPv4-mapped loopback range.
 */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  // IPv4-mapped IPv6 loopback (::ffff:127.0.0.0/104). The URL serializer
  // emits hex groups — 127.a.b.c maps to `[::ffff:7f<a>:<b><c>]` (e.g.
  // `[::ffff:127.0.0.1]` → `[::ffff:7f00:1]`).
  if (/^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(hostname)) return true;
  // 127.0.0.0/8 — URL normalization guarantees the dotted-quad form.
  const quad = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  return quad !== null && quad.slice(1).every((octet) => Number(octet) <= 255);
}

/**
 * Static-configuration refusal from this backend. Boot treats any error
 * carrying `bootFatal: true` thrown out of `orchestrator.initialize()` as a
 * non-transient config error and fails the boot hard (see the duck-typed
 * check in `lib/boot.ts`) — the marker property keeps core boot free of
 * imports from this opt-in module. The message must be fully actionable on
 * its own: it is the last thing the operator sees before the process exits.
 */
export class RunnerConfigError extends Error {
  /** Duck-typed by core boot (`lib/boot.ts`): true = fail boot hard. */
  readonly bootFatal = true;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Refusal from the plaintext-transport gate. A distinct class so the
 * orchestrator's requireEnv() can rethrow it verbatim — its message is
 * already the actionable one, and wrapping it in the generic "set
 * FIRECRACKER_RUNNER_URL / _TOKEN" hint would point at the wrong fix.
 */
export class RunnerTransportSecurityError extends RunnerConfigError {}

/**
 * Enforce the plaintext-transport policy on the runner URL. Pure —
 * exported for unit tests; getRemoteEnv() applies it with the module
 * logger. `https://` and loopback `http://` always pass. Non-loopback
 * `http://` is REFUSED unless `FIRECRACKER_RUNNER_ALLOW_PLAINTEXT=1`
 * opts out explicitly (`allowPlaintext === true`), in which case it
 * warns loudly instead.
 */
export function assertRunnerTransportSecurity(
  runnerUrl: string,
  allowPlaintext: boolean,
  warn: (message: string) => void = (message) => logger.warn(message),
): void {
  const parsed = new URL(runnerUrl);
  if (parsed.protocol !== "http:") return;
  if (isLoopbackHostname(parsed.hostname)) return;
  const risk =
    `the platform↔daemon wire carries the bearer token AND per-run credentials ` +
    `(model API keys, sink secrets, connect logins) — anyone on the network path can ` +
    `capture and replay them`;
  if (allowPlaintext) {
    warn(
      `FIRECRACKER_RUNNER_ALLOW_PLAINTEXT=1: allowing plaintext http:// to a non-loopback ` +
        `host (${parsed.hostname}) — ${risk}. This opt-out is only acceptable when platform ` +
        `and daemon share a host (e.g. the Docker-bridge path of a same-host install) or a ` +
        `genuinely private link; otherwise put TLS in front of the daemon and use https://.`,
    );
    return;
  }
  throw new RunnerTransportSecurityError(
    `FIRECRACKER_RUNNER_URL is plaintext http:// to a non-loopback host (${parsed.hostname}) — ` +
      `refused: ${risk}. Put TLS in front of the daemon (reverse proxy) and use https://, ` +
      `or — ONLY when platform and daemon share a host (Docker bridge) or a trusted ` +
      `private link — set FIRECRACKER_RUNNER_ALLOW_PLAINTEXT=1 to explicitly accept plaintext.`,
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
      parsed.FIRECRACKER_RUNNER_ALLOW_PLAINTEXT,
    );
    cached = parsed;
  }
  return cached;
}

/** Test seam — drop the cache so the next read re-parses process.env. */
export function _resetRemoteEnvCacheForTesting(): void {
  cached = undefined;
}
