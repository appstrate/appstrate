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
import type { WorkspaceHandle } from "@appstrate/core/platform-types";
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
 * Per-integration egress context the adapter wires into the runner (proxy
 * env vars + optional CA file delivery). `null` means the runner gets no
 * egress route (mtls / `delivery.files` runners reach upstream directly).
 *
 * Egress is decoupled from credential injection (#543). `caCertHostPath`
 * discriminates the listener kind:
 *   - non-null → a MITM listener (TLS terminate + inject) is in front; the
 *     runner must trust the run CA, so the adapter copies the PEM in and sets
 *     the CA env block.
 *   - null → a plain CONNECT egress listener (tunnel + SSRF floor, no TLS
 *     termination); no CA needed, so the adapter sets only the proxy env block.
 */
export interface RuntimeEgressContext {
  /** Full HTTPS_PROXY URL the runner targets (e.g. `http://sidecar:39472`). */
  readonly proxyUrl: string;
  /**
   * Absolute path on the sidecar's fs to the run-CA PEM file when a
   * TLS-terminating MITM listener is in front; `null` for a plain CONNECT
   * egress listener (no TLS termination → the runner needs no extra CA).
   */
  readonly caCertHostPath: string | null;
}

export interface SpawnIntegrationOptions {
  readonly runId: string;
  readonly spec: IntegrationSpawnSpec;
  /** Absolute path on the sidecar's fs to the extracted bundle root. */
  readonly bundleRoot: string;
  /**
   * Egress context (proxy URL + optional CA file path). `null` = no egress
   * route (mtls / `delivery.files` reach upstream directly). A non-null
   * `caCertHostPath` signals a TLS-terminating MITM listener; `null` signals
   * a plain CONNECT egress listener.
   */
  readonly egress: RuntimeEgressContext | null;
  /**
   * Per-run shared workspace handle decoded from the sidecar's
   * `WORKSPACE_HANDLE_JSON` env var. Adapters mount/expose it under
   * the runner's filesystem ONLY when the spec's referenced mcp-server
   * opted in via `_meta["dev.appstrate/workspace"]` (carried on
   * `spec.workspaceMount`). `null` when the launching orchestrator
   * provided no workspace handle (legacy launch paths, custom
   * orchestrators) — adapters then degrade to no-mount and the
   * opt-in mcp-server runs without workspace access (logged warning).
   */
  readonly workspaceHandle: WorkspaceHandle | null;
  /** Stderr line emitter wired by the caller (typically logger.info). */
  readonly onStderrLine: (line: string) => void;
}

/**
 * Canonical env-var name the spawned runner reads to locate the shared
 * workspace. Exposed by both adapters so mcp-server code stays
 * adapter-agnostic — the path differs between docker (the in-runner
 * mount point declared on `_meta.workspace`) and process (the host
 * tmpdir path), but the env-var contract is uniform.
 */
export const WORKSPACE_ENV_VAR = "APPSTRATE_WORKSPACE";

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
interface IntegrationRuntimeAdapterEntry {
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
 * Canonical spelling of a `delivery.files` mount path — the ONE form both the
 * floor below and the adapters' writers operate on.
 *
 * Every check in {@link isPathSafeForMount} is a string comparison, and the
 * kernel does not compare strings. `/./usr/local/bin/gh`, `//usr/local/bin/gh`
 * and `/a/../usr/local/bin/gh` all name `/usr/local/bin/gh` to `open(2)`, so a
 * floor that knew only the canonical spelling was defeated by one leading
 * `/.`. The platform-side resolver (`isSafeDeliveryFilePath`) does not close
 * that either: it rejects `..` and keeps `.` and `//`.
 *
 * The writers call this too, and write to what it returns. That is the point:
 * a check and a write that canonicalize differently is the same defect one
 * layer down — `docker cp`'s staging `resolve()` already normalized while the
 * check did not, which is exactly how the bypass landed inside the container.
 *
 * Returns "" for an empty / non-string input, which is never safe.
 */
export function normalizeMountPath(path: string): string {
  if (typeof path !== "string" || path.length === 0) return "";
  const normalized = posix.normalize(path);
  // `normalize` preserves a trailing slash; the exact-file comparisons below
  // and the writers both want the slash-free spelling.
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

/**
 * Directories the system searches BY NAME, so a file dropped in one is chosen
 * by a later `execve`/`dlopen` that asked for a name, not for this path:
 * every entry of the runner images' default PATH plus the dynamic loader's own
 * search directories.
 */
const SYSTEM_LOOKUP_PREFIXES = [
  "/bin/",
  "/sbin/",
  "/usr/",
  "/lib/",
  "/lib32/",
  "/lib64/",
  "/libexec/",
];

/**
 * Subtrees whose CONTENTS are executed, sourced or consulted by something that
 * was never told about this file: the loader's config drop-ins, shell login
 * drop-ins, the cron spools, the auth stack, and root's home (whose dotfiles
 * and `authorized_keys` are all of the above at once).
 */
const AUTO_CONSUMED_PREFIXES = [
  "/etc/ld.so.conf.d/",
  "/etc/profile.d/",
  "/etc/cron.d/",
  "/etc/cron.hourly/",
  "/etc/cron.daily/",
  "/etc/cron.weekly/",
  "/etc/cron.monthly/",
  "/etc/periodic/",
  "/var/spool/cron/",
  "/etc/pam.d/",
  "/etc/ssh/",
  "/etc/sudoers.d/",
  "/root/",
  // The system trust store: a cert landing here is honoured by every TLS
  // client that starts afterwards, which is the CA-shaped form of the same
  // hazard. An integration's OWN client cert or private CA belongs under
  // `/etc/<vendor>/`, which is what the manifests are told to use.
  "/etc/ssl/certs/",
  "/etc/ca-certificates/",
  "/etc/pki/",
];

/**
 * Individual files read on the system's own initiative. `/etc/ld.so.preload`
 * is the sharpest of them and strictly worse than a PATH plant: it injects
 * into EVERY process spawned afterwards, whatever its name or path.
 */
const AUTO_CONSUMED_FILES = [
  // Privilege escalation: the passwd/shadow/sudoers/group families.
  "/etc/passwd",
  "/etc/passwd-",
  "/etc/shadow",
  "/etc/shadow-",
  "/etc/sudoers",
  "/etc/gshadow",
  "/etc/group",
  "/etc/group-",
  // Dynamic loader.
  "/etc/ld.so.preload",
  "/etc/ld.so.conf",
  // Shell / login startup.
  "/etc/profile",
  "/etc/bashrc",
  "/etc/bash.bashrc",
  "/etc/zshenv",
  "/etc/zprofile",
  "/etc/zshrc",
  "/etc/zlogin",
  "/etc/environment",
  // Scheduler.
  "/etc/crontab",
  // Name resolution and trust-store bundles.
  "/etc/nsswitch.conf",
  "/etc/ca-certificates.conf",
  "/etc/ssl/cert.pem",
];

/**
 * Path SEGMENTS that carry the hazard wherever they appear, because "the
 * system reads it unbidden" is a property of the name, not of the location:
 * `~/.ssh` is consulted for every login and every outbound `ssh`, in root's
 * home and in an unprivileged runner's alike.
 */
const AUTO_CONSUMED_SEGMENTS = [".ssh"];

/**
 * Basenames sourced or consulted by name, in whatever home directory they
 * land — the per-user half of the shell-startup and authorized-keys classes.
 */
const AUTO_CONSUMED_BASENAMES = [
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_logout",
  ".profile",
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".zlogin",
  ".kshrc",
  ".cshrc",
  ".login",
  "authorized_keys",
  "authorized_keys2",
];

/**
 * R8a — shared safe-path floor for `delivery.files` credential mounts,
 * used by every spawning adapter (process, docker, future VM backends).
 *
 * THE RULE: a credential file may land only where its ONLY reader is the
 * integration that declared it. Refuse anywhere the system reads on its own
 * initiative — where something later opens the file without having been told
 * this path, because writing there is not delivering a credential, it is
 * reconfiguring the machine every later process runs on. In one class that
 * covers what the kernel exposes rather than stores (`/dev`, `/proc`, `/sys`),
 * what a lookup finds by NAME (the PATH and loader search directories), what
 * the loader reads before `main()`, what a shell sources at startup, what cron
 * runs on a timer, what the auth stack consults to decide who may log in or
 * become root, and what every TLS client trusts.
 *
 * It is one rule, not two: `/usr/local/bin/gh` was refused for planting an
 * executable on the PATH, while `/bin/gh` and `/sbin/x` — the rest of that same
 * PATH — were accepted, and `/etc/ld.so.preload` (worse: injected into every
 * later process) and `/etc/profile.d/x.sh` (sourced by every login shell) with
 * them. The rationale had been applied to one of its instances.
 *
 * WHAT STAYS ALLOWED, because nothing reads them unbidden: `/run/`, `/tmp/`,
 * `/var/tmp/`, `/var/lib/<vendor>/`, and vendor subtrees of `/etc/` —
 * `/etc/appstrate/certs/client.pem` and `/etc/<vendor>/service-account.json`
 * are the destinations `delivery.files` exists for, and the docker adapter
 * documents them as supported. `/etc` is therefore refused file-by-file and
 * subtree-by-subtree, never wholesale.
 *
 * The platform-side resolver (`isSafeDeliveryFilePath`) already strips relative
 * paths + `..` traversal + NUL bytes + pure root before any of this runs; this
 * is a second floor enforced at spawn time, and it judges the
 * {@link normalizeMountPath} spelling so an alias of a refused path is refused
 * with it.
 *
 * Adapters extend the floor via `extraForbidden*`. Only the docker adapter
 * uses that now, for `/.docker/` (prefix) and `/.dockerenv` (file), which are
 * Docker-private and meaningless on a host filesystem. `/usr/` and
 * `/workspace/` used to be extras that BOTH adapters passed and are shared
 * floor now: PATH is not one adapter's business, and `/workspace/` is the
 * per-run tree shared with the agent container, where a credential mount
 * collides with run artifacts on every backend.
 *
 * Matching semantics: a prefix matches when the path equals the prefix without
 * its trailing slash OR starts with the prefix; a file matches on exact
 * equality; a segment matches anywhere in the path; a basename matches the
 * final segment.
 */
export function isPathSafeForMount(
  rawPath: string,
  {
    extraForbiddenPrefixes = [],
    extraForbiddenFiles = [],
  }: { extraForbiddenPrefixes?: string[]; extraForbiddenFiles?: string[] } = {},
): boolean {
  if (typeof rawPath !== "string" || rawPath.includes("\0")) return false;
  const path = normalizeMountPath(rawPath);
  if (!path.startsWith("/")) return false;
  // Pure root: normalization collapses `/`, `//`, `/.` and `/..` onto it, and
  // none of them names a file to write.
  if (path === "/") return false;
  // Forbidden subtrees: kernel-managed, name-lookup, auto-consumed, the
  // per-run workspace, and the adapter's own.
  const forbiddenPrefixes = [
    "/dev/",
    "/proc/",
    "/sys/",
    "/workspace/",
    ...SYSTEM_LOOKUP_PREFIXES,
    ...AUTO_CONSUMED_PREFIXES,
    ...extraForbiddenPrefixes,
  ];
  for (const p of forbiddenPrefixes) {
    if (path === p.replace(/\/$/, "") || path.startsWith(p)) {
      return false;
    }
  }
  // Forbidden specific files (privilege escalation, loader, shell, cron, trust
  // store + adapter extras).
  if (AUTO_CONSUMED_FILES.includes(path) || extraForbiddenFiles.includes(path)) return false;
  // Name-carried hazards, at any depth.
  const segments = path.split("/");
  if (segments.some((segment) => AUTO_CONSUMED_SEGMENTS.includes(segment))) return false;
  if (AUTO_CONSUMED_BASENAMES.includes(segments[segments.length - 1] ?? "")) return false;
  return true;
}

/**
 * Proxy-routing half of the egress env block — points every standard
 * `HTTP(S)_PROXY` var at the per-integration listener. Always applied when an
 * egress context is present, for BOTH listener kinds (MITM and plain CONNECT),
 * because routing the runner's traffic out is orthogonal to whether the proxy
 * terminates TLS. The CA half ({@link buildCaEnvBlock}) is layered on top only
 * for the MITM kind.
 */
export function buildProxyEnvBlock(proxyUrl: string): Record<string, string> {
  return {
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    http_proxy: proxyUrl,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
}

/**
 * CA-trust half of the egress env block — only needed when a TLS-terminating
 * MITM listener is in front, so the runner trusts the per-SNI leaf certs it
 * mints. A plain CONNECT egress listener does NOT terminate TLS, so no extra
 * CA is required and this block is skipped (no cert mint, no `docker cp`).
 *
 * Names are the standardised conventions honoured by Node
 * (NODE_EXTRA_CA_CERTS), Python (requests / httpx / urllib via
 * REQUESTS_CA_BUNDLE / SSL_CERT_FILE), curl (CURL_CA_BUNDLE), and git
 * (GIT_SSL_CAINFO — git wraps libcurl but uses its OWN env var, ignoring
 * CURL_CA_BUNDLE/SSL_CERT_FILE). Without GIT_SSL_CAINFO a mcp-server that
 * shells out to `git` (clone/fetch/push over HTTPS) sees `SSL certificate
 * problem: unable to get local issuer certificate` even with the proxy
 * reachable.
 */
export function buildCaEnvBlock(caCertPathInRuntime: string): Record<string, string> {
  return {
    NODE_EXTRA_CA_CERTS: caCertPathInRuntime,
    SSL_CERT_FILE: caCertPathInRuntime,
    REQUESTS_CA_BUNDLE: caCertPathInRuntime,
    CURL_CA_BUNDLE: caCertPathInRuntime,
    GIT_SSL_CAINFO: caCertPathInRuntime,
  };
}
