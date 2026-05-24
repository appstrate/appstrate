// SPDX-License-Identifier: Apache-2.0

/**
 * Pluggable runtime backend for integration MCP servers.
 *
 * The sidecar can run integrations under different isolation models —
 * Docker containers today, with Firecracker microVMs / podman / kata
 * planned. Each backend differs in how it spawns processes, how the
 * runner reaches the sidecar's MITM listener, and how it ferries the
 * per-run CA cert into the runner's trust store. This module hides
 * those differences behind a single `IntegrationRuntimeAdapter`
 * interface so `bootIntegrations` stays orchestrator-agnostic.
 *
 * Mirrors the platform-side `RUN_ADAPTER=docker|process` pattern. Adding
 * a new backend is one file + one `registerIntegrationRuntimeAdapter()`
 * call; nothing in `integrations-boot.ts` needs to change.
 */

import { normalize, join, posix } from "node:path";

import type { SubprocessTransport } from "@appstrate/mcp-transport";
import type { IntegrationSpawnSpec } from "./integrations-boot.ts";

/**
 * Per-run network + CA delivery context returned by
 * {@link IntegrationRuntimeAdapter.prepare}. Computed once at boot
 * and consumed by callers to wire the per-integration MITM listener
 * (bind host) + the proxy URL handed to the integration's runner.
 */
export interface RuntimeAdapterRunContext {
  /**
   * Host the MITM listener should bind to. Bridge / VM adapters return
   * "0.0.0.0" (the runner reaches the listener via a routable address);
   * the in-process adapter returns "127.0.0.1" because the runner
   * inherits the parent's network namespace.
   */
  readonly listenerBindHost: string;
  /**
   * Build the URL the integration's runner uses as HTTPS_PROXY. The
   * adapter picks the host (DNS alias, VM gateway, loopback) — the
   * caller supplies the listener's actual ephemeral port.
   */
  proxyUrlFor(listenerPort: number): string;
}

/**
 * Per-integration MITM context the adapter must wire into the runner
 * (env vars + CA file delivery). `null` means env-delivery only (no
 * MITM listener was spawned for this integration's auths).
 */
export interface RuntimeMitmContext {
  /** Full HTTPS_PROXY URL the runner targets (e.g. `http://sidecar:39472`). */
  readonly proxyUrl: string;
  /** Absolute path on the sidecar's fs to the run-CA PEM file. */
  readonly caCertHostPath: string;
}

export interface SpawnIntegrationOptions {
  readonly runId: string;
  readonly spec: IntegrationSpawnSpec;
  /** Absolute path on the sidecar's fs to the extracted bundle root. */
  readonly bundleRoot: string;
  /** MITM context (proxy URL + CA file path). `null` = env-delivery only. */
  readonly mitm: RuntimeMitmContext | null;
  /** Stderr line emitter wired by the caller (typically logger.info). */
  readonly onStderrLine: (line: string) => void;
}

export interface SpawnedIntegration {
  /** MCP JSON-RPC transport the caller wires its `Client` against. */
  readonly transport: SubprocessTransport;
  /**
   * Optional adapter-defined diagnostic id (container id, pid, …).
   * Surfaced in logs to help operators correlate runner-side events.
   */
  readonly diagnosticId: string | null;
}

export interface IntegrationRuntimeAdapter {
  /** Stable identifier used by logs and the `INTEGRATION_RUNTIME_ADAPTER` opt-in. */
  readonly id: string;
  /** Per-run context — called once at boot, before any `spawn()`. */
  prepare(runId: string): Promise<RuntimeAdapterRunContext>;
  /** Spawn one integration MCP server. Returns the JSON-RPC transport. */
  spawn(options: SpawnIntegrationOptions): Promise<SpawnedIntegration>;
  /** Tear down everything spawned through this adapter. Must be idempotent. */
  shutdown(): Promise<void>;
}

/**
 * Factory entry keyed by `id`. Selection is purely by `id` — the platform
 * orchestrator that launches the sidecar sets `INTEGRATION_RUNTIME_ADAPTER`
 * to mirror its own `RUN_ADAPTER`, so the integration runtime always matches
 * the run runtime. There is NO availability probing / auto-detection: the
 * sidecar never guesses its backend.
 */
export interface IntegrationRuntimeAdapterEntry {
  readonly id: string;
  create(): IntegrationRuntimeAdapter;
}

const REGISTRY: IntegrationRuntimeAdapterEntry[] = [];

export function registerIntegrationRuntimeAdapter(entry: IntegrationRuntimeAdapterEntry): void {
  if (REGISTRY.some((e) => e.id === entry.id)) {
    throw new Error(`integration runtime adapter '${entry.id}' already registered`);
  }
  REGISTRY.push(entry);
}

/**
 * Pick the adapter for this sidecar process by `INTEGRATION_RUNTIME_ADAPTER`.
 * The platform orchestrator that launched the sidecar sets it to mirror its
 * own `RUN_ADAPTER` (docker-orchestrator → `docker`, process-orchestrator →
 * `process`), so the integration runtime deterministically matches the run
 * runtime — no probing, no guessing. The id MUST be registered. Throws when
 * the var is unset or unknown (a fail-fast, since every launch path sets it).
 */
export function selectIntegrationRuntimeAdapter(
  env: NodeJS.ProcessEnv = process.env,
): IntegrationRuntimeAdapter {
  if (REGISTRY.length === 0) {
    throw new Error(
      "no integration runtime adapter registered — import the docker/process adapter modules before calling selectIntegrationRuntimeAdapter",
    );
  }
  const requested = env.INTEGRATION_RUNTIME_ADAPTER;
  const available = REGISTRY.map((e) => e.id).join(", ");
  if (!requested) {
    throw new Error(
      `INTEGRATION_RUNTIME_ADAPTER is not set — the launching orchestrator must pin it to match RUN_ADAPTER. Available: ${available}`,
    );
  }
  const entry = REGISTRY.find((e) => e.id === requested);
  if (!entry) {
    throw new Error(
      `INTEGRATION_RUNTIME_ADAPTER='${requested}' not registered. Available: ${available}`,
    );
  }
  return entry.create();
}

// ─────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────

/**
 * Path-traversal guard shared by every spawning adapter (docker, process,
 * future VM backends). Resolves a manifest-declared `entryPoint` against the
 * extracted `bundleRoot` and asserts the result stays *inside* the bundle —
 * so a malformed/malicious manifest (`../../etc/passwd`, an absolute path, a
 * `a/../../b` escape) can never trick the sidecar into spawning or
 * `docker cp`-ing a file outside the bundle root. Returns the normalized
 * absolute host path on success; throws on containment violation.
 *
 * Containment rule: the resolved path must be `bundleRoot` itself, or live
 * under `bundleRoot + sep`. Using the POSIX separator matches the sidecar's
 * Linux filesystem (the only place bundles are extracted).
 */
export function resolveBundleEntry(bundleRoot: string, entryPoint: string): string {
  const abs = normalize(join(bundleRoot, entryPoint));
  if (!abs.startsWith(bundleRoot + posix.sep) && abs !== bundleRoot) {
    throw new Error("integration entryPoint escapes bundle root");
  }
  return abs;
}

/**
 * Build the standard MITM-proxy env block. Adapters call this with the
 * proxy URL the runner targets and the path the CA cert lands at inside
 * the runner's filesystem (the path differs by adapter — Docker copies
 * the cert into the container's `/tmp/appstrate-ca.pem`; the process
 * adapter passes the host path directly because the subprocess shares
 * the parent's fs).
 *
 * Names are the standardised conventions honoured by Node (via
 * undici-style dispatchers + NODE_TLS_REJECT_UNAUTHORIZED), Python
 * (requests / httpx / urllib via REQUESTS_CA_BUNDLE / SSL_CERT_FILE),
 * and most CLI HTTP clients (curl).
 */
export function buildMitmEnvBlock(
  proxyUrl: string,
  caCertPathInRuntime: string,
): Record<string, string> {
  return {
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    http_proxy: proxyUrl,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    NODE_EXTRA_CA_CERTS: caCertPathInRuntime,
    SSL_CERT_FILE: caCertPathInRuntime,
    REQUESTS_CA_BUNDLE: caCertPathInRuntime,
    CURL_CA_BUNDLE: caCertPathInRuntime,
  };
}
