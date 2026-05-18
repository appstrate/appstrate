// SPDX-License-Identifier: Apache-2.0

/**
 * Sidecar-side integration bootstrap (Phase 1.4, env-delivery path).
 *
 * Reads the `INTEGRATIONS_TO_SPAWN_JSON` env var produced by the
 * platform launcher (see `apps/api/src/services/run-launcher/pi.ts`),
 * fetches each integration's bundle bytes via the internal credentials
 * surface, materialises them on local fs, spawns the declared MCP
 * subprocess with the resolved env (OAuth access tokens / API keys
 * placed under `delivery.env`), and aggregates their tools on a shared
 * {@link McpHost}.
 *
 * Scope is intentionally narrow — this is the minimum wiring needed to
 * surface real integration tools to the agent. It deliberately skips:
 *
 *   - MITM proxy + CA bundle minting (only needed when an auth declares
 *     `delivery.http` — env delivery hands the credential to the
 *     subprocess at spawn time and the subprocess talks to upstream
 *     directly).
 *   - Credential refresh on SIGHUP (re-spawn-on-401 only — refresh-while-
 *     running is a Phase 1.5 concern).
 *   - Restart supervision (single attempt per integration; if the
 *     subprocess crashes the host emits a tool-error on the next call).
 *
 * Once `delivery.http` integrations land, the same controller swaps to
 * `bootstrapIntegrationRuntime` from `./integration-runtime-controller.ts`
 * (which handles CA, MITM, and per-request credential injection).
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, posix } from "node:path";
import { tmpdir } from "node:os";
import { unzipSync } from "fflate";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  SubprocessTransport,
  wrapClient,
  type AppstrateMcpClient,
  type AppstrateToolDefinition,
} from "@appstrate/mcp-transport";
import { planCaBundle, type CaBundle } from "@appstrate/connect";

import { McpHost } from "./mcp-host.ts";
import { logger } from "./logger.ts";
import { createOpensslCertGenerator } from "./ca-cert-openssl.ts";
import { createCertMinter, type CertMinter } from "./integration-cert-minter.ts";
import {
  createIntegrationMitmListener,
  type MitmListenerHandle,
} from "./integration-mitm-listener.ts";
import {
  createIntegrationCredentialsSource,
  fetchInitialIntegrationCredentials,
} from "./integration-credentials-source.ts";

/**
 * Per-integration spec produced by the platform launcher. The launcher
 * resolves the agent's `dependencies.integrations` → `applicationPackages`
 * → `integration_connections` chain so the sidecar receives a flat,
 * ready-to-spawn payload (manifest + live credentials). Bundle bytes
 * are fetched separately via the internal endpoint (#bundle size limit).
 */
export interface IntegrationSpawnSpec {
  /** Package id (e.g. `@appstrate/gmail-mcp`). */
  packageId: string;
  /** McpHost namespace — typically the package's slug portion. */
  namespace: string;
  /** Validated integration manifest (server, transport, auths). */
  manifest: IntegrationManifestLite;
  /**
   * Resolved env vars to set on the spawned subprocess. Built from
   * `manifest.auths.{key}.delivery.env`, with values taken from the live
   * (already-refreshed) credentials. Sensitive: never logged.
   */
  spawnEnv: Record<string, string>;
  /**
   * Phase 1.5 — per-auth `delivery.http` metadata. Presence (with at
   * least one entry) tells the sidecar to take the MITM path for this
   * integration: start a per-integration HTTPS listener, mint a CA
   * bundle, hand the runner container `HTTPS_PROXY` + `*_CA_*` env vars,
   * and let the listener inject the live header per `delivery.http`
   * spec. Absent / empty = stay on the env-delivery-only path.
   *
   * Structural mirror of `IntegrationSpawnSpec.httpDeliveryAuths` in
   * `@appstrate/core/sidecar-types` — the wire payload is the same shape.
   */
  httpDeliveryAuths?: Record<
    string,
    {
      authType: string;
      headerName: string;
      headerPrefix: string;
      value: string;
      allowServerOverride: boolean;
      authorizedUris: readonly string[];
      expiresAtEpochMs: number | null;
    }
  >;
}

/**
 * Where the sidecar fetches integration bundles from. The platform
 * surface is `GET /internal/integration-bundle/:scope/:name` with
 * Bearer-token auth (same run-token as the credentials endpoint).
 */
export interface BundleFetchOptions {
  platformApiUrl: string;
  runToken: string;
  /** Override for tests. Defaults to `globalThis.fetch`. */
  fetchFn?: typeof fetch;
}

/**
 * Minimal subset of the integration manifest that this boot module
 * needs. Mirrors `@appstrate/core/integration`'s `IntegrationManifest`
 * but flattened to the fields we read here — the sidecar avoids importing
 * the full Zod schema bundle.
 */
export interface IntegrationManifestLite {
  name: string;
  version: string;
  server: {
    type: string;
    entryPoint?: string;
  };
  transport?: { type: string };
}

export interface BootIntegrationsResult {
  host: McpHost;
  /** Tools registered on `host`, ready to merge into the sidecar's MCP surface. */
  tools: AppstrateToolDefinition[];
  /** Per-integration spawn outcome — useful for run-event observability. */
  spawned: Array<{ packageId: string; namespace: string; toolCount: number }>;
  /** Per-integration failures — emitted as warnings but do not abort boot. */
  failed: Array<{ packageId: string; error: string }>;
  /** Idempotent teardown — closes every upstream MCP client. */
  shutdown: () => Promise<void>;
}

/**
 * Parse the `INTEGRATIONS_TO_SPAWN_JSON` env var. Returns `null` when the
 * env var is missing or empty — the caller proceeds without integrations.
 */
export function readIntegrationSpecsFromEnv(env = process.env): IntegrationSpawnSpec[] | null {
  const raw = env.INTEGRATIONS_TO_SPAWN_JSON;
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn("INTEGRATIONS_TO_SPAWN_JSON is not valid JSON; skipping integrations", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!Array.isArray(parsed)) {
    logger.warn("INTEGRATIONS_TO_SPAWN_JSON must be an array; skipping integrations");
    return null;
  }
  return parsed.filter((s): s is IntegrationSpawnSpec => {
    return (
      typeof s === "object" &&
      s !== null &&
      typeof (s as IntegrationSpawnSpec).packageId === "string" &&
      typeof (s as IntegrationSpawnSpec).namespace === "string" &&
      typeof (s as IntegrationSpawnSpec).manifest === "object"
    );
  });
}

/**
 * Fetch one integration's bundle from the platform's internal surface.
 * The endpoint authorises with the same Bearer run-token as the
 * credentials surface and verifies that the run's agent actually
 * declares this integration as a dependency.
 */
async function fetchBundleBytes(packageId: string, opts: BundleFetchOptions): Promise<Uint8Array> {
  const url = `${opts.platformApiUrl}/internal/integration-bundle/${packageId}`;
  const f = opts.fetchFn ?? fetch;
  const res = await f(url, { headers: { Authorization: `Bearer ${opts.runToken}` } });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      // ignore
    }
    throw new Error(
      detail || `Failed to fetch integration bundle for ${packageId}: HTTP ${res.status}`,
    );
  }
  const ab = await res.arrayBuffer();
  return new Uint8Array(ab);
}

/**
 * Extract a ZIP bundle (already-bytes) to a fresh directory under
 * `os.tmpdir()`. Path traversal is defended in depth: every entry is
 * normalised + the resolved path must remain under the extraction root.
 */
async function extractBundle(bytes: Uint8Array, namespace: string): Promise<string> {
  // Namespace is the integration package id (e.g. `@scope/name`). Both `@`
  // and `/` are illegal in a mkdtemp template under macOS/Linux — collapse
  // to a path-safe slug. The directory is private to this run anyway.
  const safe = namespace.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  const root = await mkdtemp(join(tmpdir(), `afps-integ-${safe}-`));
  const files = unzipSync(bytes);
  for (const [rel, bytes] of Object.entries(files)) {
    if (rel.endsWith("/")) continue;
    const relPosix = rel.split("\\").join("/");
    const dest = normalize(join(root, relPosix));
    if (!dest.startsWith(root + "/") && dest !== root) {
      throw new Error(`integrations-boot: refusing to write outside root: ${rel}`);
    }
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, bytes as Uint8Array);
  }
  return root;
}

/**
 * Map `server.type` (MCPB-compatible: `node` | `python` | `binary`) to
 * the corresponding Appstrate runner image. The runner image carries
 * the language interpreter; the sidecar's own image carries none.
 *
 * Adding a new runtime is one map entry here + one `runtime-pi/runners/
 * {name}/Dockerfile`. The sidecar stays minimal regardless.
 */
const RUNNER_IMAGE_BY_TYPE: Record<string, string> = {
  node: "appstrate-mcp-runner-node:latest",
  python: "appstrate-mcp-runner-python:latest",
  binary: "appstrate-mcp-runner-binary:latest",
};

interface IntegrationContainerPlan {
  /** Runner image, e.g. `appstrate-mcp-runner-node:latest`. */
  image: string;
  /**
   * Absolute path INSIDE the runner container that the runner's
   * ENTRYPOINT will execute (passed as CMD). For node/python this is
   * the entry script under `/bundle`; for binary it's the binary
   * itself.
   */
  containerEntry: string;
  /**
   * Absolute path ON THE SIDECAR'S FILESYSTEM of the extracted bundle
   * dir — `docker cp <bundleRoot>/. <id>:/bundle/` populates the
   * container before `docker start`.
   */
  bundleRoot: string;
}

function planIntegrationContainer(
  spec: IntegrationSpawnSpec,
  bundleRoot: string,
): IntegrationContainerPlan {
  const t = spec.manifest.server.type;
  const image = RUNNER_IMAGE_BY_TYPE[t];
  if (!image) {
    throw new Error(
      `integrations-boot: server.type "${t}" has no registered runner image. ` +
        `Supported types: ${Object.keys(RUNNER_IMAGE_BY_TYPE).join(", ")}`,
    );
  }
  const entry = spec.manifest.server.entryPoint;
  if (!entry) {
    throw new Error(`integrations-boot: server.entryPoint required for server.type="${t}"`);
  }
  // Path-traversal guard — the validated host-side path. We still
  // re-derive the container-side path independently below; this check
  // exists so a malformed manifest can't trick us into docker-cp'ing
  // outside the bundle root.
  const absHostEntry = normalize(join(bundleRoot, entry));
  if (!absHostEntry.startsWith(bundleRoot + posix.sep) && absHostEntry !== bundleRoot) {
    throw new Error(`integrations-boot: server.entryPoint escapes bundle root`);
  }
  // POSIX-join the container path — the runner image is always Linux,
  // and `path.join` on the sidecar host (also Linux in production but
  // could be macOS in dev) might pick the wrong separator.
  const rel = entry.replace(/^\.?\/+/, "");
  const containerEntry = posix.join("/bundle", rel);
  return { image, containerEntry, bundleRoot };
}

/**
 * Run a docker CLI command synchronously and capture stdout. Throws on
 * non-zero exit with both streams in the error message so a failing
 * `docker create` doesn't disappear into a generic "spawn failed".
 */
async function dockerExec(args: string[]): Promise<string> {
  const bunSpawn = (globalThis as unknown as { Bun?: { spawn: Function } }).Bun?.spawn;
  if (!bunSpawn) throw new Error("integrations-boot: Bun.spawn unavailable");
  const proc = bunSpawn(["docker", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  }) as {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
  };
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`docker ${args[0]} failed (exit ${code}): ${stderr.trim() || stdout.trim()}`);
  }
  return stdout.trim();
}

/**
 * Create a runner container in `Created` state (entrypoint not fired
 * yet), `docker cp` the bundle into `/bundle`, and return the container
 * id so the caller can `docker start -ai` to launch it with stdio
 * piped. `--rm` (HostConfig.AutoRemove) makes the daemon clean up the
 * container once it exits, so the only thing the sidecar needs to do
 * on shutdown is `docker kill <id>` — the rm happens automatically.
 *
 * The integration is placed on the default `bridge` network (gets
 * NAT'd internet for upstream API calls) and is **not** joined to the
 * agent's run network — the agent never talks to the integration
 * directly; it talks to the sidecar, which talks stdio over docker
 * attach. Labels mirror the platform's convention so the orphan reaper
 * (`cleanupOrphanedContainers()`) sweeps any container the sidecar
 * couldn't kill itself (hard crash / SIGKILL).
 */
/**
 * Optional MITM wiring layered on top of {@link setupIntegrationContainer}.
 * Populated when the integration declares `delivery.http` and the sidecar
 * has minted a per-run CA bundle:
 *
 *   - `proxyUrl` — points at the per-integration MITM listener bound on
 *     127.0.0.1 inside the sidecar's network namespace.
 *   - `sidecarContainerId` — the runner container joins the sidecar's
 *     network namespace (`--network container:<id>`) so 127.0.0.1
 *     resolves to the listener without needing a dedicated docker network.
 *   - `caCertHostPath` — path to the run-CA PEM ON the sidecar's fs.
 *     `docker cp`'d into the runner at {@link CA_CONTAINER_PATH} so the
 *     runner's language ecosystem (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`,
 *     `REQUESTS_CA_BUNDLE`) trusts the minted leaf certs.
 */
interface MitmSpawnExtras {
  proxyUrl: string;
  sidecarContainerId: string | null;
  caCertHostPath: string;
}

/**
 * Path inside the runner container where the run-CA cert lands. Matched
 * by the env vars below so every supported language ecosystem
 * (Node / Python / shell-installed binary) trusts it without per-language
 * Dockerfile edits.
 */
const CA_CONTAINER_PATH = "/etc/appstrate/ca.pem";

async function setupIntegrationContainer(
  runId: string,
  spec: IntegrationSpawnSpec,
  plan: IntegrationContainerPlan,
  mitm?: MitmSpawnExtras,
): Promise<string> {
  const safeNs = spec.namespace.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  const containerName = `appstrate-integ-${safeNs}-${runId.slice(0, 8)}-${Date.now()}`;
  const envFlags: string[] = [];
  for (const [k, v] of Object.entries(spec.spawnEnv)) {
    envFlags.push("-e", `${k}=${v}`);
  }
  if (mitm) {
    // Standardised proxy env vars honoured by Node (via undici-style
    // dispatchers + NODE_TLS_REJECT_UNAUTHORIZED), Python (requests /
    // httpx / urllib via REQUESTS_CA_BUNDLE / SSL_CERT_FILE), and most
    // CLI HTTP clients. The cert path inside the runner is fixed
    // (CA_CONTAINER_PATH) — the runner Dockerfiles don't need awareness.
    const proxyEnv: Record<string, string> = {
      HTTPS_PROXY: mitm.proxyUrl,
      HTTP_PROXY: mitm.proxyUrl,
      https_proxy: mitm.proxyUrl,
      http_proxy: mitm.proxyUrl,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
      NODE_EXTRA_CA_CERTS: CA_CONTAINER_PATH,
      SSL_CERT_FILE: CA_CONTAINER_PATH,
      REQUESTS_CA_BUNDLE: CA_CONTAINER_PATH,
      CURL_CA_BUNDLE: CA_CONTAINER_PATH,
    };
    for (const [k, v] of Object.entries(proxyEnv)) {
      envFlags.push("-e", `${k}=${v}`);
    }
  }
  const labelFlags: string[] = [
    "--label",
    `appstrate.run=${runId}`,
    "--label",
    "appstrate.managed=true",
    "--label",
    "appstrate.adapter=integration",
    "--label",
    `appstrate.integration=${spec.packageId}`,
  ];
  // Network mode: when MITM is active AND we know the sidecar's container
  // id, the runner joins the sidecar's network namespace so `127.0.0.1`
  // inside the runner reaches the MITM listener bound on the sidecar's
  // loopback. Without this share, the runner would need its own docker
  // network attached to the sidecar — extra plumbing the MITM model
  // doesn't justify. Falls back to the default bridge network when we
  // can't read the sidecar's id (e.g. sidecar running unconfined in dev).
  const networkFlags: string[] =
    mitm && mitm.sidecarContainerId ? ["--network", `container:${mitm.sidecarContainerId}`] : [];
  const createArgs = [
    "create",
    "--rm",
    "-i",
    "--name",
    containerName,
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--memory",
    "256m",
    "--pids-limit",
    "128",
    ...networkFlags,
    ...labelFlags,
    ...envFlags,
    plan.image,
    plan.containerEntry,
  ];
  const containerId = await dockerExec(createArgs);
  // docker cp <src>/. <id>:/<dst>/  — the trailing `/.` semantics
  // copy the directory's *contents* into /bundle (already exists in
  // the runner image as the WORKDIR), so the runner's entrypoint sees
  // `/bundle/server/index.js` at the path the manifest declared.
  await dockerExec(["cp", `${plan.bundleRoot}/.`, `${containerId}:/bundle/`]);
  if (mitm) {
    // Copy the CA cert into a stable path. The container's root fs is
    // ephemeral (`--rm` cleans up at exit) so this lives only for the
    // run. The runner image WORKDIR is `/bundle` but we want the cert
    // under `/etc/appstrate/` to match the env vars above — `docker cp`
    // creates intermediate dirs as needed.
    await dockerExec(["cp", mitm.caCertHostPath, `${containerId}:${CA_CONTAINER_PATH}`]);
  }
  return containerId;
}

/**
 * Best-effort container kill. We use `docker kill` (SIGKILL) rather
 * than `stop` because the integration MCP server's only contract is to
 * read JSON-RPC from stdin — gracefully terminating it via SIGTERM
 * gives nothing back and the `--rm` flag will clean up either way.
 * Errors are swallowed because cleanup runs in shutdown paths where
 * the orphan reaper is the safety net.
 */
async function killIntegrationContainer(containerId: string): Promise<void> {
  await dockerExec(["kill", containerId]).catch(() => {});
}

/**
 * Detect whether the sidecar can reach a Docker daemon. Used to pick
 * between the container-per-integration path (Docker mode — proper
 * runtime isolation, scales to Python/Ruby/… without bloating the
 * sidecar image) and the legacy subprocess path (Process mode — the
 * sidecar is itself a Bun subprocess on the host, so we just spawn
 * `node` / `python3` directly off the host PATH).
 *
 * Result is cached for the sidecar's lifetime — a single `docker info`
 * roundtrip at boot.
 */
let dockerAvailableCache: boolean | null = null;
async function isDockerAvailable(): Promise<boolean> {
  if (dockerAvailableCache !== null) return dockerAvailableCache;
  try {
    await dockerExec(["info", "--format", "{{.ServerVersion}}"]);
    dockerAvailableCache = true;
  } catch {
    dockerAvailableCache = false;
  }
  return dockerAvailableCache;
}

/**
 * Subprocess-mode fallback for `server.type`. The runner image's
 * ENTRYPOINT is the language interpreter — symmetric mapping here for
 * the direct-spawn path. Adding a new runtime is one entry on this
 * map AND one entry on `RUNNER_IMAGE_BY_TYPE` above.
 */
const HOST_INTERPRETER_BY_TYPE: Record<string, { command: string; argsBefore: string[] }> = {
  node: { command: "node", argsBefore: [] },
  python: { command: "python3", argsBefore: ["-u"] },
  // `binary` is a no-op: exec the bundle entry directly.
  binary: { command: "", argsBefore: [] },
};

interface SubprocessPlan {
  command: string;
  args: string[];
  cwd: string;
}

function planSubprocessSpawn(spec: IntegrationSpawnSpec, bundleRoot: string): SubprocessPlan {
  const t = spec.manifest.server.type;
  const cfg = HOST_INTERPRETER_BY_TYPE[t];
  if (!cfg) {
    throw new Error(`integrations-boot: server.type "${t}" has no host-interpreter mapping`);
  }
  const entry = spec.manifest.server.entryPoint;
  if (!entry) {
    throw new Error(`integrations-boot: server.entryPoint required for server.type="${t}"`);
  }
  const absEntry = normalize(join(bundleRoot, entry));
  if (!absEntry.startsWith(bundleRoot + posix.sep) && absEntry !== bundleRoot) {
    throw new Error(`integrations-boot: server.entryPoint escapes bundle root`);
  }
  if (t === "binary") {
    return { command: absEntry, args: [], cwd: bundleRoot };
  }
  return {
    command: cfg.command,
    args: [...cfg.argsBefore, absEntry],
    cwd: bundleRoot,
  };
}

/**
 * Spawn every integration in parallel, register the surviving ones on a
 * shared {@link McpHost}, and return the materialised tool list. The
 * function never throws — per-integration failures are captured in
 * `result.failed` so a single broken integration doesn't black-hole the
 * entire run.
 */
export async function bootIntegrations(
  specs: IntegrationSpawnSpec[],
  bundleFetchOpts: BundleFetchOptions,
): Promise<BootIntegrationsResult> {
  const host = new McpHost({
    onLog: (event) =>
      logger.info("integration host event", {
        source: event.source,
        level: event.level,
        data: event.data,
      }),
  });
  const spawned: BootIntegrationsResult["spawned"] = [];
  const failed: BootIntegrationsResult["failed"] = [];
  const clients: AppstrateMcpClient[] = [];
  const containerIds: string[] = [];
  const mitmListeners: MitmListenerHandle[] = [];

  // The sidecar receives RUN_TOKEN but not RUN_ID directly — we
  // synthesise a stable identifier from the run-token prefix purely for
  // labelling the integration containers (lets the orphan reaper match
  // containers back to their run if the sidecar dies mid-shutdown).
  // The token itself is sensitive — only the first 12 hex chars land in
  // a label that's visible via `docker inspect`.
  const runId = process.env.RUN_ID ?? (process.env.RUN_TOKEN ?? "unknown").slice(0, 12);

  const useDocker = await isDockerAvailable();
  logger.info("integration runtime path", {
    mode: useDocker ? "container" : "subprocess",
    integrations: specs.length,
  });

  // ─── Phase 1.5 — MITM bring-up (run-CA + cert minter), only when needed ───
  // Mint the CA once per run, regardless of how many integrations need it.
  // Per-integration listeners share the same minter (lazily creates leaf
  // certs per upstream SNI host). The CA cert PEM lands on local fs so
  // `docker cp` can ferry it into each runner container's trust store.
  const mitmIntegrationCount = specs.filter(
    (s) => s.httpDeliveryAuths && Object.keys(s.httpDeliveryAuths).length > 0,
  ).length;
  let runCaBundle: CaBundle | null = null;
  let runCaCertHostPath: string | null = null;
  let sharedMinter: CertMinter | null = null;
  if (mitmIntegrationCount > 0) {
    try {
      runCaBundle = await planCaBundle({
        runId,
        // /run is tmpfs on the sidecar image. The planner ONLY uses
        // tmpfsRoot for derived path strings inside the CaBundle return
        // value — it doesn't write anything itself. We materialise the
        // CA cert below at our own location.
        tmpfsRoot: "/run/afps",
        notAfterSeconds: 3600,
        generator: createOpensslCertGenerator(),
      });
      const caDir = await mkdtemp(join(tmpdir(), "afps-ca-"));
      runCaCertHostPath = join(caDir, "ca.pem");
      await writeFile(runCaCertHostPath, runCaBundle.pems.caCertPem, { mode: 0o444 });
      sharedMinter = createCertMinter({
        caCertPem: runCaBundle.pems.caCertPem,
        caKeyPem: runCaBundle.pems.caKeyPem,
      });
      logger.info("integration MITM CA minted", {
        runId,
        integrations: mitmIntegrationCount,
        caCertPath: runCaCertHostPath,
        notAfter: runCaBundle.notAfter,
      });
    } catch (err) {
      // CA bring-up failed — every MITM integration will fail to register
      // below; non-MITM integrations stay on the env-delivery-only path.
      // We don't abort: the env-only path is still useful in dev / when
      // openssl is missing from the sidecar image.
      logger.warn("integration MITM CA bring-up failed; HTTP-delivery integrations will skip", {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Sidecar's own container id — used to attach runner containers to the
  // sidecar's network namespace (`--network container:<id>`) so the
  // runner's `127.0.0.1` reaches the MITM listener bound on the
  // sidecar's loopback. In container deployments Docker sets HOSTNAME
  // to the short container id; in process mode it's the host's hostname
  // (and `--network container:<host>` would fail). We guard the use of
  // this id below by `useDocker` AND check that we're actually inside a
  // container by sniffing /.dockerenv.
  const sidecarContainerId = await readSidecarContainerIdIfDockerized();

  for (const spec of specs) {
    try {
      const wantsMitm =
        spec.httpDeliveryAuths !== undefined && Object.keys(spec.httpDeliveryAuths).length > 0;

      // Per-integration MITM listener (only when the CA came up + the
      // integration declared `delivery.http`).
      let listener: MitmListenerHandle | null = null;
      let mitmProxyUrl: string | null = null;
      if (wantsMitm && sharedMinter !== null && runCaBundle !== null) {
        const initial = await fetchInitialIntegrationCredentials(spec.packageId, bundleFetchOpts);
        const source = createIntegrationCredentialsSource({
          packageId: spec.packageId,
          platformApiUrl: bundleFetchOpts.platformApiUrl,
          runToken: bundleFetchOpts.runToken,
          initialPayload: initial,
        });
        listener = createIntegrationMitmListener({
          caBundle: runCaBundle,
          minter: sharedMinter,
          credentials: source,
          onEvent: (event) => {
            // Filter sensitive bits (URLs may carry signed query params).
            const safe =
              event.kind === "request-forwarded"
                ? {
                    kind: event.kind,
                    status: event.status,
                    authKey: event.authKey,
                    retried: event.retried,
                  }
                : event;
            logger.info("integration mitm event", {
              packageId: spec.packageId,
              ...safe,
            });
          },
        });
        await listener.ready;
        mitmListeners.push(listener);
        mitmProxyUrl = listener.proxyUrl();
        logger.info("integration MITM listener ready", {
          packageId: spec.packageId,
          proxyUrl: mitmProxyUrl,
        });
      }

      const bytes = await fetchBundleBytes(spec.packageId, bundleFetchOpts);
      const root = await extractBundle(bytes, spec.namespace);

      let transport: SubprocessTransport;
      let containerId: string | null = null;
      let plannedImage: string | null = null;
      if (useDocker) {
        const plan = planIntegrationContainer(spec, root);
        plannedImage = plan.image;
        const mitmExtras: MitmSpawnExtras | undefined =
          mitmProxyUrl !== null && runCaCertHostPath !== null
            ? {
                proxyUrl: mitmProxyUrl,
                sidecarContainerId,
                caCertHostPath: runCaCertHostPath,
              }
            : undefined;
        containerId = await setupIntegrationContainer(runId, spec, plan, mitmExtras);
        containerIds.push(containerId);
        // `docker start -ai <id>` starts the container's entrypoint (e.g.
        // `node /bundle/server/index.js`) AND attaches stdio. SubprocessTransport
        // spawns this as a child process, pipes the JSON-RPC line stream
        // through, and tears the whole thing down when `.close()` is
        // called. Auto-rm on the container side handles cleanup if we
        // crash without a graceful close.
        transport = new SubprocessTransport({
          command: "docker",
          args: ["start", "-ai", containerId],
          // Note: `env` is NOT passed to the subprocess (docker CLI)
          // because credentials are already baked into the container at
          // create-time via `-e KEY=VAL`. The CLI itself only needs the
          // ambient PATH/HOME/DOCKER_HOST to find the daemon socket.
          envPassthrough: ["PATH", "HOME", "DOCKER_HOST"],
          onStderrLine: (line) => {
            logger.info("integration stderr", { packageId: spec.packageId, line });
          },
        });
      } else {
        const plan = planSubprocessSpawn(spec, root);
        // Process-mode MITM: subprocess inherits the parent's network NS,
        // so 127.0.0.1:<port> reaches our listener directly. CA env vars
        // point at the on-disk PEM the planner already materialised. Both
        // are unset when this integration isn't on the MITM path.
        const procEnv: Record<string, string> = { ...spec.spawnEnv };
        if (mitmProxyUrl !== null && runCaCertHostPath !== null) {
          procEnv.HTTPS_PROXY = mitmProxyUrl;
          procEnv.HTTP_PROXY = mitmProxyUrl;
          procEnv.https_proxy = mitmProxyUrl;
          procEnv.http_proxy = mitmProxyUrl;
          procEnv.NO_PROXY = "127.0.0.1,localhost";
          procEnv.no_proxy = "127.0.0.1,localhost";
          procEnv.NODE_EXTRA_CA_CERTS = runCaCertHostPath;
          procEnv.SSL_CERT_FILE = runCaCertHostPath;
          procEnv.REQUESTS_CA_BUNDLE = runCaCertHostPath;
          procEnv.CURL_CA_BUNDLE = runCaCertHostPath;
        }
        transport = new SubprocessTransport({
          command: plan.command,
          args: plan.args,
          cwd: plan.cwd,
          env: procEnv,
          envPassthrough: ["PATH", "HOME", "NODE_OPTIONS"],
          onStderrLine: (line) => {
            logger.info("integration stderr", { packageId: spec.packageId, line });
          },
        });
      }

      const client = new Client({ name: "appstrate-sidecar-integration-host", version: "0.1.0" });
      const connectPromise = client.connect(transport);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("MCP connect timeout (30s)")), 30_000).unref?.(),
      );
      await Promise.race([connectPromise, timeoutPromise]);
      const wrapped = wrapClient(client, transport);
      const sizeBefore = host.size();
      await host.register({ namespace: spec.namespace, client: wrapped });
      const added = host.size() - sizeBefore;
      clients.push(wrapped);
      spawned.push({
        packageId: spec.packageId,
        namespace: spec.namespace,
        toolCount: added,
      });
      logger.info("integration registered", {
        packageId: spec.packageId,
        namespace: spec.namespace,
        mode: useDocker ? "container" : "subprocess",
        ...(containerId ? { containerId: containerId.slice(0, 12) } : {}),
        ...(plannedImage ? { image: plannedImage } : {}),
        toolCount: added,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ packageId: spec.packageId, error: msg });
      logger.warn("integration spawn failed", {
        packageId: spec.packageId,
        error: msg,
      });
    }
  }

  const tools = host.buildTools();
  return {
    host,
    tools,
    spawned,
    failed,
    shutdown: async () => {
      await host.dispose().catch(() => {});
      for (const c of clients) {
        await c.close().catch(() => {});
      }
      // Kill containers AFTER closing MCP clients — closing the client
      // ends the `docker start -ai` subprocess (stdin EOF reaches the
      // server which exits → container exits → --rm cleans up). The
      // explicit `docker kill` is the belt-and-suspenders path for
      // misbehaving servers that ignore stdin EOF.
      for (const id of containerIds) {
        await killIntegrationContainer(id);
      }
      // Close MITM listeners after containers are torn down — listeners
      // hold open the per-SNI Bun.serve sockets + cached leaf certs.
      // Order matters only weakly; either way the CA cert file unlinks
      // last so any straggler dump-on-shutdown still has the bytes.
      for (const listener of mitmListeners) {
        try {
          await listener.close();
        } catch {
          // ignore — listener already torn down via SIGTERM
        }
      }
      if (runCaCertHostPath) {
        try {
          await rm(runCaCertHostPath, { force: true });
        } catch {
          // ignore — best-effort
        }
      }
    },
  };
}

/**
 * Read the sidecar's own container id when running inside Docker. Used
 * for `--network container:<id>` to share the network namespace with
 * spawned integration runner containers. Returns `null` in process mode
 * (no `/.dockerenv` sentinel — the network-share trick doesn't apply).
 *
 * Docker sets `HOSTNAME` to the short container id by default; we sniff
 * `/.dockerenv` to confirm we're actually inside a container before
 * trusting that value. Custom hostnames (rare in sidecar deployments)
 * would break this — fall back to the long id via `/proc/self/cgroup`
 * (cgroup v1 only). For cgroup v2 the long id lives in `/proc/self/mountinfo`,
 * which we don't parse; the short HOSTNAME is the load-bearing path.
 */
async function readSidecarContainerIdIfDockerized(): Promise<string | null> {
  try {
    // Stat /.dockerenv — its mere existence signals "inside Docker".
    // We don't read it; just probe.
    await readFile("/.dockerenv");
  } catch {
    return null;
  }
  const hostname = process.env.HOSTNAME;
  if (hostname && /^[0-9a-f]{12,}$/.test(hostname)) {
    return hostname;
  }
  // Fall back to cgroup v1's container id (longer than HOSTNAME, full id).
  try {
    const cgroup = await readFile("/proc/self/cgroup", "utf-8");
    const match = cgroup.match(/[0-9a-f]{64}/);
    if (match) return match[0];
  } catch {
    // ignore
  }
  return null;
}
