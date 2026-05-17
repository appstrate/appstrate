// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 1.2a — integration runtime helpers (pure, DB-free, no spawn).
 *
 * Bridges {@link IntegrationManifest} (validated by `@appstrate/core/integration`)
 * to the concrete shell invocation the orchestrator hands to `Bun.spawn` or
 * Docker. Every function in this module is a pure transformation —
 * `Bun.spawn` itself, Docker socket calls, tmpfs writes, and child-process
 * lifecycle live in `runtime-pi` / `apps/api/services`.
 *
 * Exposes:
 *   - {@link validateIntegrationServer} — enforces post-bundle invariants
 *     (no `npx`/`uvx` sugars, docker requires digest, `entryPoint` must
 *     resolve under the bundle root, `compatibility.mcp` range satisfied).
 *   - {@link resolveIntegrationServer} — converts `server.type` + the
 *     post-bundle ref into a {@link ResolvedSpawnTarget} (`local-file` or
 *     `docker`) the command builder can consume.
 *   - {@link buildSpawnCommand} — final argv + env layered over the
 *     proxy 6-tuple. Per D31, `node`/`bun` both invoke `bun <entryPoint>`
 *     (override the package's `#!/usr/bin/env node` shebang).
 *
 * Why `packages/connect` and not `runtime-pi`: the same logic runs in the
 * publish-time sandbox (registry side) when extracting `tools.lock.json`,
 * the dashboard preview ("what does this integration spawn?"), and the
 * runtime spawn. Keeping it pure + framework-agnostic avoids three copies
 * drifting.
 */

import {
  coerceVersion,
  isValidRange,
  isValidVersion,
  satisfiesRange,
} from "@appstrate/core/semver";
import type { IntegrationManifest } from "@appstrate/core/integration";

// ─────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────

export type IntegrationRuntimeErrorCode =
  | "AUTHORING_SUGAR_UNBUNDLED"
  | "DOCKER_DIGEST_REQUIRED"
  | "DOCKER_IDENTIFIER_REQUIRED"
  | "ENTRYPOINT_REQUIRED"
  | "ENTRYPOINT_TRAVERSAL"
  | "ENTRYPOINT_ABSOLUTE"
  | "HTTP_TRANSPORT_UNSUPPORTED_HERE"
  | "INCOMPATIBLE_MCP_VERSION"
  | "INCOMPATIBLE_AFPS_VERSION"
  | "INVALID_RANGE";

export class IntegrationRuntimeError extends Error {
  override readonly name = "IntegrationRuntimeError";
  readonly code: IntegrationRuntimeErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(
    code: IntegrationRuntimeErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}

// ─────────────────────────────────────────────
// Server resolver
// ─────────────────────────────────────────────

/** Local-file spawn target — `entryPoint` resolved against the bundle root. */
export interface ResolvedLocalSpawnTarget {
  kind: "local-file";
  /** `server.type` after rejecting author sugars (one of node/bun/python/uv/binary). */
  type: "node" | "bun" | "python" | "uv" | "binary";
  /** Absolute path to the entrypoint inside the bundle. */
  absoluteEntryPoint: string;
  /** As-declared (relative) entrypoint, kept for log messages. */
  entryPoint: string;
}

/** Docker spawn target — `package` pulled by OCI digest. */
export interface ResolvedDockerSpawnTarget {
  kind: "docker";
  /** `registry/identifier` portion (no digest). */
  identifier: string;
  /** Full `sha256:<64 hex>` digest. */
  digest: string;
  /** Concatenated as `<identifier>@<digest>` — what `docker run` consumes. */
  imageRef: string;
  /** Optional registry base URL if the publisher pinned one. */
  registryBaseUrl?: string;
}

export type ResolvedSpawnTarget = ResolvedLocalSpawnTarget | ResolvedDockerSpawnTarget;

/**
 * Convert a validated {@link IntegrationManifest}'s `server` block into a
 * resolved spawn target. `http`/`url` is intentionally rejected — that path
 * is handled by the MCP HTTP client, not the spawn orchestrator.
 *
 * `bundleRoot` is the absolute directory the bundle was extracted to.
 * `entryPoint` is resolved against it; absolute paths and `..` traversal
 * are refused (mirroring `parseMcpServerManifest`).
 */
export function resolveIntegrationServer(
  server: IntegrationManifest["server"],
  bundleRoot: string,
): ResolvedSpawnTarget {
  validateIntegrationServer(server);

  if (server.type === "docker") {
    // validateIntegrationServer has already enforced package.registryType
    // === "oci" and the digest format — this narrows for TS.
    const pkg = server.package!;
    if (pkg.registryType !== "oci") {
      throw new IntegrationRuntimeError(
        "DOCKER_DIGEST_REQUIRED",
        `server.package.registryType must be "oci" for docker (got '${pkg.registryType}')`,
      );
    }
    const out: ResolvedDockerSpawnTarget = {
      kind: "docker",
      identifier: pkg.identifier,
      digest: pkg.digest,
      imageRef: `${pkg.identifier}@${pkg.digest}`,
    };
    if (pkg.registryBaseUrl) out.registryBaseUrl = pkg.registryBaseUrl;
    return out;
  }

  // Local-file branch (node/bun/python/uv/binary). `entryPoint` is
  // guaranteed by the validator.
  const entryPoint = server.entryPoint!;
  if (entryPoint.startsWith("/")) {
    throw new IntegrationRuntimeError(
      "ENTRYPOINT_ABSOLUTE",
      `server.entryPoint must be relative to the bundle root (got '${entryPoint}')`,
    );
  }
  if (entryPoint.includes("..")) {
    throw new IntegrationRuntimeError(
      "ENTRYPOINT_TRAVERSAL",
      `server.entryPoint must not contain '..' (got '${entryPoint}')`,
    );
  }
  const absolute = joinPath(bundleRoot, entryPoint);
  return {
    kind: "local-file",
    type: server.type as "node" | "bun" | "python" | "uv" | "binary",
    absoluteEntryPoint: absolute,
    entryPoint,
  };
}

/**
 * Enforce post-bundle invariants on `server`. Throws
 * {@link IntegrationRuntimeError} on the first violation so callers (Phase
 * 1.2a orchestrator, dashboard preview) can surface the structured error
 * code to the operator.
 *
 * What we refuse:
 *   - `server.type === "npx"` or `"uvx"` — authoring sugars; the AFPS
 *     bundler is expected to rewrite them before publish (D31). Reaching
 *     runtime with the sugar still in place means the bundle was uploaded
 *     unbundled.
 *   - `server.type === "docker"` without a `sha256:` digest — operator
 *     would be running an untagged tag (mutable, susceptible to substitution
 *     attacks).
 *   - `server.type === "http"` — the HTTP transport bypasses spawn entirely.
 *     Caller should branch on `server.type === "http"` before invoking us.
 *
 * The Zod schema in `@appstrate/core/integration` does most shape checking
 * already; this layer only adds the runtime-side guards.
 */
export function validateIntegrationServer(server: IntegrationManifest["server"]): void {
  if (server.type === "npx" || server.type === "uvx") {
    throw new IntegrationRuntimeError(
      "AUTHORING_SUGAR_UNBUNDLED",
      `server.type '${server.type}' is an authoring sugar; the bundle must rewrite it to ` +
        `'node' (npx) or 'uv' (uvx) via 'afps bundle' before publish (proposal D31).`,
      { receivedType: server.type },
    );
  }
  if (server.type === "http") {
    throw new IntegrationRuntimeError(
      "HTTP_TRANSPORT_UNSUPPORTED_HERE",
      `server.type 'http' is handled by the MCP HTTP client, not the spawn orchestrator.`,
    );
  }
  if (server.type === "docker") {
    const pkg = server.package;
    if (!pkg) {
      throw new IntegrationRuntimeError(
        "DOCKER_IDENTIFIER_REQUIRED",
        `server.package is required when server.type is 'docker'`,
      );
    }
    if (pkg.registryType !== "oci") {
      throw new IntegrationRuntimeError(
        "DOCKER_DIGEST_REQUIRED",
        `server.package.registryType must be 'oci' when server.type is 'docker'`,
      );
    }
    if (!pkg.digest || !/^sha256:[a-f0-9]{64}$/.test(pkg.digest)) {
      throw new IntegrationRuntimeError(
        "DOCKER_DIGEST_REQUIRED",
        `server.package.digest must be a sha256 digest (sha256:<64 hex>) — got '${pkg.digest ?? ""}'`,
      );
    }
    return;
  }
  // node/bun/python/uv/binary all need entryPoint.
  if (!server.entryPoint) {
    throw new IntegrationRuntimeError(
      "ENTRYPOINT_REQUIRED",
      `server.entryPoint is required for server.type '${server.type}'`,
    );
  }
}

// ─────────────────────────────────────────────
// Compatibility validation
// ─────────────────────────────────────────────

/**
 * Verify the host runtime can execute this integration. Refuses to spawn
 * when `manifest.compatibility.mcp` excludes `runtime.mcpVersion`, or when
 * `compatibility.afps` excludes `runtime.afpsVersion`.
 *
 * `compatibility` values are arbitrary semver ranges. An invalid range
 * raises `INVALID_RANGE` rather than silently passing — registry publish
 * validators should already have rejected such manifests, but defence in
 * depth never hurts.
 */
export function validateRuntimeCompatibility(
  manifest: Pick<IntegrationManifest, "compatibility">,
  runtime: { mcpVersion?: string; afpsVersion?: string },
): void {
  const compat = manifest.compatibility;
  if (!compat) return;

  if (compat.mcp !== undefined) {
    if (!isValidRange(compat.mcp)) {
      throw new IntegrationRuntimeError(
        "INVALID_RANGE",
        `compatibility.mcp '${compat.mcp}' is not a valid semver range`,
      );
    }
    if (runtime.mcpVersion) {
      if (!satisfiesRange(coerceProtocolVersion(runtime.mcpVersion), compat.mcp)) {
        throw new IntegrationRuntimeError(
          "INCOMPATIBLE_MCP_VERSION",
          `runtime MCP version '${runtime.mcpVersion}' does not satisfy compatibility.mcp '${compat.mcp}'`,
          { runtimeVersion: runtime.mcpVersion, requiredRange: compat.mcp },
        );
      }
    }
  }

  if (compat.afps !== undefined) {
    if (!isValidRange(compat.afps)) {
      throw new IntegrationRuntimeError(
        "INVALID_RANGE",
        `compatibility.afps '${compat.afps}' is not a valid semver range`,
      );
    }
    if (runtime.afpsVersion) {
      if (!satisfiesRange(coerceProtocolVersion(runtime.afpsVersion), compat.afps)) {
        throw new IntegrationRuntimeError(
          "INCOMPATIBLE_AFPS_VERSION",
          `runtime AFPS version '${runtime.afpsVersion}' does not satisfy compatibility.afps '${compat.afps}'`,
          { runtimeVersion: runtime.afpsVersion, requiredRange: compat.afps },
        );
      }
    }
  }
}

/**
 * MCP advertises its protocol via `YYYY-MM-DD` date strings (e.g.
 * `"2025-11-25"`); AFPS uses semver. Convert dated protocol versions
 * to a degenerate semver form (`YYYYMMDD.0.0`) so authors can still
 * write `compatibility.mcp: ">=20251125.0.0"`. Authors who want
 * "any MCP 2025-XX-XX" can write `>=20250101.0.0 <20260101.0.0`.
 */
function coerceProtocolVersion(v: string): string {
  if (isValidVersion(v)) return v;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) return `${m[1]}${m[2]}${m[3]}.0.0`;
  // Last-ditch: coerce loose `1.2` → `1.2.0`.
  const coerced = coerceVersion(v);
  if (coerced) return coerced;
  return v; // satisfiesRange will throw → bubble up as INVALID_RANGE on caller.
}

// ─────────────────────────────────────────────
// Spawn command builder
// ─────────────────────────────────────────────

export interface SpawnCommandPlan {
  /** Executable to invoke (e.g. `"bun"`, `"python"`, `"uv"`, `"docker"`, or the binary path). */
  command: string;
  /** argv tail handed to the executable. */
  args: string[];
  /** Env vars layered on top of the orchestrator-supplied passthrough. */
  env: Record<string, string>;
}

/**
 * Build the argv + env to invoke an integration's MCP server. Pure —
 * mutates nothing; the caller pipes the plan into `Bun.spawn` or Docker.
 *
 * For `node` / `bun` types we invoke `bun <entryPoint>` per D31 — the
 * package's `#!/usr/bin/env node` shebang is ignored, because (a) the
 * runtime ships Bun and not Node, and (b) running every third-party MCP
 * server under Bun is a deliberate consistency choice that avoids
 * shipping two interpreters.
 *
 * `extraEnv` is appended last so callers can layer proxy 6-tuple +
 * credential env-delivery on top without re-implementing the spawn.
 */
export function buildSpawnCommand(
  target: ResolvedSpawnTarget,
  options: {
    /** Extra env vars (proxy 6-tuple, credential delivery, etc.). */
    extraEnv?: Record<string, string>;
    /** Extra argv tail (rare — used by author sugars that pre-pend args). */
    extraArgs?: string[];
    /**
     * `docker run` cwd is meaningless; for local-file targets the caller
     * usually wants the bundle root. The plan does not surface cwd — wire
     * it on the spawn options yourself.
     */
  } = {},
): SpawnCommandPlan {
  const extraEnv = options.extraEnv ?? {};
  const extraArgs = options.extraArgs ?? [];

  if (target.kind === "docker") {
    // `docker run --rm -i` keeps stdio attached for the JSON-RPC framing
    // SubprocessTransport expects. We forward proxy + cred env via
    // explicit `--env KEY=VALUE` pairs (Docker does not inherit the
    // parent process env by design).
    const envArgs: string[] = [];
    for (const [k, v] of Object.entries(extraEnv)) {
      envArgs.push("--env", `${k}=${v}`);
    }
    return {
      command: "docker",
      args: ["run", "--rm", "-i", ...envArgs, target.imageRef, ...extraArgs],
      env: {},
    };
  }

  // local-file branch — node/bun/python/uv/binary.
  switch (target.type) {
    case "node":
    case "bun":
      // D31: override shebang, ignore `#!/usr/bin/env node` from the package.
      return {
        command: "bun",
        args: [target.absoluteEntryPoint, ...extraArgs],
        env: { ...extraEnv },
      };
    case "python":
      return {
        command: "python",
        args: [target.absoluteEntryPoint, ...extraArgs],
        env: { ...extraEnv },
      };
    case "uv":
      // `uv run <script>` resolves a Python env from the package's
      // `pyproject.toml` / `requirements.txt` at the entrypoint dir.
      return {
        command: "uv",
        args: ["run", target.absoluteEntryPoint, ...extraArgs],
        env: { ...extraEnv },
      };
    case "binary":
      return {
        command: target.absoluteEntryPoint,
        args: [...extraArgs],
        env: { ...extraEnv },
      };
  }
}

// ─────────────────────────────────────────────
// Proxy env injection (D32 + §5.4.1)
// ─────────────────────────────────────────────

export interface ProxyEnvInjectionInput {
  /** Proxy URL the subprocess should route HTTPS through (typically `http://127.0.0.1:<port>`). */
  proxyUrl: string;
  /** Absolute path to the run's CA cert on tmpfs (typically `/run/afps/ca.pem`). */
  caCertPath: string;
  /** Optional NO_PROXY allowlist (hostnames the subprocess should bypass). */
  noProxy?: readonly string[];
}

/**
 * Build the full 6-tuple proxy env block consumed by every reasonable
 * HTTP client (Node, Python, Go, curl, …). Aligned with
 * `process-orchestrator.ts:265-270` so the integration runtime matches the
 * platform-side container env.
 *
 * Output is the OR of:
 *   - HTTPS_PROXY / HTTP_PROXY / NO_PROXY  (RFC tradition — uppercase)
 *   - https_proxy / http_proxy / no_proxy  (libcurl tradition — lowercase)
 *   - NODE_EXTRA_CA_CERTS                  (Node TLS — extends bundled CA list)
 *   - REQUESTS_CA_BUNDLE                   (Python `requests`)
 *   - SSL_CERT_FILE                        (Python `ssl`, Go `crypto/tls`)
 *
 * For `caTrustEnv: "NONE"` binaries (D32), pass `caCertPath: ""` so the
 * cert-pointing entries are omitted — the env still gets proxy URLs but
 * the binary will reject TLS, which is the intended fail-closed behaviour.
 */
export function buildProxyEnvInjection(input: ProxyEnvInjectionInput): Record<string, string> {
  const noProxyJoined = (input.noProxy ?? []).join(",");
  const env: Record<string, string> = {
    HTTPS_PROXY: input.proxyUrl,
    HTTP_PROXY: input.proxyUrl,
    https_proxy: input.proxyUrl,
    http_proxy: input.proxyUrl,
  };
  if (noProxyJoined) {
    env.NO_PROXY = noProxyJoined;
    env.no_proxy = noProxyJoined;
  }
  if (input.caCertPath) {
    env.NODE_EXTRA_CA_CERTS = input.caCertPath;
    env.REQUESTS_CA_BUNDLE = input.caCertPath;
    env.SSL_CERT_FILE = input.caCertPath;
    env.CURL_CA_BUNDLE = input.caCertPath;
  }
  return env;
}

// ─────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────

function joinPath(root: string, rel: string): string {
  if (root.endsWith("/")) return `${root}${rel}`;
  return `${root}/${rel}`;
}
