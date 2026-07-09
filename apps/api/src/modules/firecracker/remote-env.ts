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
import { getErrorMessage } from "@appstrate/core/errors";
import { logger } from "./runner/logger.ts";

/**
 * How the platform reaches the daemon: over TCP (http/https base URL) or
 * over a Unix domain socket (co-located daemon — the wire never touches
 * the network, so the SEC-2 plaintext gate does not apply).
 */
export type RunnerTransport = { kind: "unix"; socketPath: string } | { kind: "tcp"; url: string };

/**
 * Classify a runner URL into its transport. Pure — throws an actionable
 * Error on malformed input (the schema surfaces it as the Zod issue).
 * `unix:///abs/path.sock` → unix; `http(s)://…` → tcp with trailing
 * slashes stripped (route concatenation must never produce `//v1/...`,
 * which some proxies refuse to route). A unix socket path stays VERBATIM
 * — stripping would change which filesystem node we dial.
 */
export function parseRunnerTransport(rawUrl: string): RunnerTransport {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`not a valid URL: ${rawUrl}`);
  }
  if (parsed.protocol === "unix:") {
    // `unix://var/run/x.sock` parses "var" as a HOSTNAME and silently
    // drops the first path segment — the classic two-slash typo. Refuse
    // loudly instead of dialing the wrong socket.
    if (parsed.hostname !== "") {
      throw new Error(
        `unix:// runner URL has a host component ("${parsed.hostname}") — a socket path ` +
          `needs THREE slashes: unix:///${parsed.hostname}${parsed.pathname} (you wrote ${rawUrl})`,
      );
    }
    if (!parsed.pathname || !parsed.pathname.startsWith("/")) {
      throw new Error(
        `unix:// runner URL must carry an absolute socket path, e.g. ` +
          `unix:///run/appstrate-runner/runner.sock (you wrote ${rawUrl})`,
      );
    }
    // A `?query` or `#fragment` has no meaning for a filesystem node — URL
    // parsing would silently drop it from `pathname` and we would dial a
    // DIFFERENT path than the operator wrote. Refuse, same policy as the
    // two-slash typo above.
    if (parsed.search !== "" || parsed.hash !== "") {
      throw new Error(
        `unix:// runner URL must be a bare socket path — remove the ` +
          `"${parsed.search || parsed.hash}" suffix (you wrote ${rawUrl})`,
      );
    }
    // `pathname` is percent-ENCODED (a space is "%20") — decode so the path
    // we dial is byte-identical to the filesystem node the operator meant.
    return { kind: "unix", socketPath: decodeURIComponent(parsed.pathname) };
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return { kind: "tcp", url: rawUrl.replace(/\/+$/, "") };
  }
  throw new Error(
    `unsupported protocol ${parsed.protocol}// — use http(s):// (TCP daemon) or ` +
      `unix:///path.sock (co-located daemon over a Unix socket)`,
  );
}

const remoteEnvSchema = z.object({
  // Base URL of the appstrate-runner daemon: http(s) (TCP) or
  // unix:///abs/path.sock (co-located daemon over a Unix domain socket).
  // Normalization lives in parseRunnerTransport (trailing-slash strip for
  // http(s) only; a unix path stays verbatim).
  FIRECRACKER_RUNNER_URL: z.string().transform((raw, ctx) => {
    try {
      const transport = parseRunnerTransport(raw);
      return transport.kind === "tcp" ? transport.url : raw;
    } catch (err) {
      ctx.addIssue({ code: "custom", message: getErrorMessage(err) });
      return z.NEVER;
    }
  }),
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

export type RemoteRunnerEnv = z.infer<typeof remoteEnvSchema> & {
  /** Derived from FIRECRACKER_RUNNER_URL — computed once at parse time. */
  transport: RunnerTransport;
};

/** Loopback hosts exempt from the plaintext-transport gate. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Enforce the plaintext-transport policy on the runner URL. Pure —
 * exported for unit tests; getRemoteEnv() applies it with the module
 * logger. `unix://` always passes silently (the RECOMMENDED co-located
 * transport — the wire never crosses the network, so there is nothing to
 * capture on-path). `https://` and loopback `http://` always pass;
 * non-loopback `http://` is REFUSED by default (`tlsRequired`) and only
 * downgraded to a loud warning when the escape
 * (`FIRECRACKER_RUNNER_TLS_REQUIRED=0`) is set — RFC1918 is never
 * auto-trusted, the refusal stays fail-closed.
 */
export function assertRunnerTransportSecurity(
  runnerUrl: string,
  tlsRequired: boolean,
  warn: (message: string) => void = (message) => logger.warn(message),
): void {
  const parsed = new URL(runnerUrl);
  // UDS first, before any TCP reasoning: no network path exists, so no
  // TLS requirement and no warning — regardless of tlsRequired.
  if (parsed.protocol === "unix:") return;
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
    // Derive the transport once — the orchestrator branches on it per
    // call, so re-parsing the URL on every request would be pure waste.
    cached = { ...parsed, transport: parseRunnerTransport(parsed.FIRECRACKER_RUNNER_URL) };
  }
  return cached;
}

/** Test seam — drop the cache so the next read re-parses process.env. */
export function _resetRemoteEnvCacheForTesting(): void {
  cached = undefined;
}
