// SPDX-License-Identifier: Apache-2.0

/**
 * Docker-backed integration runtime adapter.
 *
 * One runner container per integration, on the per-run user-defined
 * bridge network (`appstrate-exec-<runId>`, created by the platform
 * launcher with the sidecar joined under the `sidecar` DNS alias).
 * MITM listeners bind 0.0.0.0 so the runner reaches them via
 * `http://sidecar:<port>`. CA cert is `docker cp`'d into the runner
 * at {@link CA_CONTAINER_PATH}.
 */

import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { posix, join } from "node:path";

import { SubprocessTransport } from "@appstrate/mcp-transport";

import { logger } from "./logger.ts";
import type { IntegrationSpawnSpec } from "./integrations-boot.ts";
import { createIntegrationDnsResponder } from "./integration-dns-responder.ts";
import { createTransparentEgressListener } from "./integration-transparent-listener.ts";
import {
  buildProxyEnvBlock,
  buildCaEnvBlock,
  isPathSafeForMount,
  registerIntegrationRuntimeAdapter,
  resolveBundleEntry,
  WORKSPACE_ENV_VAR,
  type IntegrationRuntimeAdapter,
  type RuntimeAdapterRunContext,
  type SpawnIntegrationOptions,
  type SpawnedIntegration,
} from "./integration-runtime-adapter.ts";

/**
 * Map MCPB-compatible `server.type` to the *default* Appstrate runner
 * image. The runner image carries the language interpreter; the
 * sidecar's own image carries none. Adding a new runtime is one map
 * entry here + one `runtime-pi/runners/{name}/Dockerfile`.
 *
 * These bare `:latest` tags only resolve on a host that ran
 * `bun run docker:build:runners` (local dev / OSS). Production overrides
 * each entry with a versioned GHCR ref via the `RUNNER_IMAGE_*` env vars
 * below — see `resolveRunnerImage`.
 */
const DEFAULT_RUNNER_IMAGE_BY_TYPE: Record<string, string> = {
  node: "appstrate-mcp-runner-node:latest",
  // In process mode `bun` runs as a host subprocess; in docker mode it gets
  // its own container here, like every other runtime — keeps tier-3's
  // cgroup/cap-drop/network isolation (the sidecar runs as root with the
  // Docker socket mounted, so third-party bun code never shares its process).
  bun: "appstrate-mcp-runner-bun:latest",
  python: "appstrate-mcp-runner-python:latest",
  // MCPB 0.4 / AFPS §3.4 — `uv` runs Python through Astral's `uv`
  // resolver. Dedicated image built on `ghcr.io/astral-sh/uv:python3.12-alpine`
  // so `uv run` is on PATH and can materialise per-bundle venvs from
  // pyproject.toml / requirements.txt / PEP-723 inline metadata.
  uv: "appstrate-mcp-runner-uv:latest",
  binary: "appstrate-mcp-runner-binary:latest",
};

/**
 * Operator env var carrying the resolved image ref per runtime. In
 * production these point at versioned GHCR images
 * (`ghcr.io/appstrate/appstrate-mcp-runner-<type>:<version>`), forwarded
 * from the API host into the sidecar container via `pickOperatorSidecarEnv`
 * (`SIDECAR_OPERATOR_ENV_KEYS` in `@appstrate/runner-pi`). Absent → the
 * bare `:latest` default, which only resolves on a host that pre-built the
 * runner images. Unlike `PI_IMAGE`/`SIDECAR_IMAGE` (consumed by the API to
 * create the agent + sidecar containers), runner images are consumed *here*
 * inside the sidecar — so they ride the operator-env forwarding channel
 * rather than the API's own `getEnv()`.
 */
const RUNNER_IMAGE_ENV_BY_TYPE: Record<string, string> = {
  node: "RUNNER_IMAGE_NODE",
  bun: "RUNNER_IMAGE_BUN",
  python: "RUNNER_IMAGE_PYTHON",
  uv: "RUNNER_IMAGE_UV",
  binary: "RUNNER_IMAGE_BINARY",
};

/**
 * Resolve the runner image for an MCPB `server.type`: operator
 * `RUNNER_IMAGE_*` override if set + non-empty, else the compiled bare-tag
 * default. Returns undefined for an unknown type so the caller emits the
 * supported-types error.
 */
function resolveRunnerImage(type: string): string | undefined {
  const envKey = RUNNER_IMAGE_ENV_BY_TYPE[type];
  const override = envKey ? process.env[envKey] : undefined;
  if (override !== undefined && override !== "") return override;
  return DEFAULT_RUNNER_IMAGE_BY_TYPE[type];
}

/**
 * Path inside the runner container where the run-CA cert lands. `/tmp`
 * is guaranteed to exist on every runner image; `docker cp` does NOT
 * create parent directories on the destination side, so anything
 * pointing at a non-existent dir (e.g. `/etc/appstrate/`) would fail
 * with `Could not find the file <parent> in container`, silently
 * breaking every HTTP-delivery integration on the run. The standard
 * trust-store env vars accept arbitrary paths — they don't care.
 */
const CA_CONTAINER_PATH = "/tmp/appstrate-ca.pem";

interface ContainerPlan {
  image: string;
  /** Path inside the runner the entrypoint executes (passed as CMD). */
  containerEntry: string;
}

interface DockerExecSubprocess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
}

type DockerExecSpawn = (
  cmd: string[],
  opts: { stdin: "ignore"; stdout: "pipe"; stderr: "pipe" },
) => DockerExecSubprocess & { kill: (signal?: number | string) => void };

/**
 * Upper bound on any single `docker` CLI invocation. A wedged docker daemon
 * would otherwise hang integration boot unbounded (no timeout on
 * `proc.exited`), leaking the subprocess. 60s is generous: `docker cp` of a
 * large bundle is legitimately slow, but a healthy daemon answers create/
 * exec/cp well within this. On expiry we kill the subprocess and reject so
 * the per-spec try/catch in `integrations-boot.ts` records it in `failed[]`.
 */
const DOCKER_EXEC_TIMEOUT_MS = 60_000;

async function dockerExec(args: string[]): Promise<string> {
  const bunSpawn = (globalThis as unknown as { Bun?: { spawn?: DockerExecSpawn } }).Bun?.spawn;
  if (!bunSpawn) throw new Error("integration-runtime-adapter-docker: Bun.spawn unavailable");
  const proc = bunSpawn(["docker", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  // Race `proc.exited` against a timer. On expiry, kill the subprocess and
  // reject; on the normal path, clear the timer so it doesn't keep the
  // process alive.
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      proc.kill();
      reject(
        new Error(
          `docker ${args[0]} timed out after ${DOCKER_EXEC_TIMEOUT_MS}ms (daemon unresponsive)`,
        ),
      );
    }, DOCKER_EXEC_TIMEOUT_MS);
  });
  try {
    const [stdout, stderr, code] = await Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]),
      timeout,
    ]);
    if (code !== 0) {
      throw new Error(`docker ${args[0]} failed (exit ${code}): ${stderr.trim() || stdout.trim()}`);
    }
    return stdout.trim();
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function planContainer(spec: IntegrationSpawnSpec, bundleRoot: string): ContainerPlan {
  const server = spec.manifest.server;
  if (!server) {
    throw new Error("integration-runtime-adapter-docker: spec has no server to spawn");
  }
  const t = server.type;
  if (!t) {
    throw new Error(
      "integration-runtime-adapter-docker: server.type required for local-source spawn",
    );
  }
  const image = resolveRunnerImage(t);
  if (!image) {
    throw new Error(
      `integration-runtime-adapter-docker: server.type "${t}" has no runner image. ` +
        `Supported types: ${Object.keys(DEFAULT_RUNNER_IMAGE_BY_TYPE).join(", ")}`,
    );
  }
  const entry = server.entry_point;
  if (!entry) {
    throw new Error(
      `integration-runtime-adapter-docker: server.entry_point required for server.type="${t}"`,
    );
  }
  // Path-traversal guard on the host-side path. We still re-derive the
  // container-side path below — this check exists so a malformed
  // manifest can't trick us into docker-cp'ing outside the bundle root.
  resolveBundleEntry(bundleRoot, entry);
  const rel = entry.replace(/^\.?\/+/, "");
  const containerEntry = posix.join("/bundle", rel);
  return { image, containerEntry };
}

async function killContainer(containerId: string): Promise<void> {
  // `rm -f` instead of `kill`: a container that crashed between
  // `docker create` and `docker start -ai` (e.g. `docker cp` failed
  // while staging the bundle) is in the `created` state with no PID 1,
  // so `docker kill` returns an error and `--rm` never fires (it only
  // triggers on container *exit*). `rm -f` works on any state and
  // collapses the kill+remove into one call. Errors stay swallowed —
  // the orphan reaper (label `appstrate.managed=true`) is the safety
  // net for sidecar crashes.
  await dockerExec(["rm", "-f", containerId]).catch(() => {});
}

/**
 * AFPS §7.6 (CC-5) — materialise a `delivery.files` entry into the
 * runner container. Writes the decoded bytes to a sidecar-local temp file
 * with the requested POSIX mode, then `docker cp`'s it into the container
 * at the absolute manifest path. Returns the host temp file path so the
 * caller can clean up after spawn.
 *
 * Security:
 *   - The container path is the manifest-declared key. The platform-side
 *     resolver enforces absolute-POSIX + no `..` + non-root (see
 *     `isSafeDeliveryFilePath`) before this code ever runs, so the value
 *     reaching us is structurally safe.
 *   - The host temp file lives in `os.tmpdir()/appstrate-files-<random>/`
 *     and is unlinked after the cp completes (the per-integration
 *     `materializeFileMounts` collector handles cleanup).
 *   - `docker cp` does NOT create parent directories on the destination
 *     side. We pre-create the parent inside the container via
 *     `docker exec mkdir -p` so manifest paths like
 *     `/run/creds/cert.pem` work without operators having to image the
 *     full directory tree.
 */
/**
 * R8a — reject container destination paths that escape the runner's safe
 * writable area. The platform-side resolver (`isSafeDeliveryFilePath`)
 * already rejects relative + `..` traversal + NUL bytes + pure root, so by
 * the time we get here `containerPath` is structurally a safe absolute
 * POSIX path. The extra check below adds a second floor: top-level system
 * directories the runner has no business mutating from credential mounts.
 *
 * Rejected prefixes:
 *   - `/dev/`, `/proc/`, `/sys/` — kernel-managed; mounting credentials
 *     there would corrupt the running container, not write a file.
 *   - `/etc/passwd*`, `/etc/shadow*`, `/etc/sudoers*` — privilege escalation
 *     surface; even if the runner is `--cap-drop ALL`, mounting over these
 *     is operator error worth refusing loudly.
 *   - `/.docker/`, `/.dockerenv` — Docker-private surfaces.
 */
export function isContainerPathSafeForMount(containerPath: string): boolean {
  // Shared floor + Docker-private surfaces: `/.docker/` (prefix) and
  // `/.dockerenv` (file) on top of the kernel-managed +
  // privilege-escalation floor enforced by `isPathSafeForMount`.
  return isPathSafeForMount(containerPath, {
    extraForbiddenPrefixes: ["/.docker/"],
    extraForbiddenFiles: ["/.dockerenv"],
  });
}

async function materializeFileMountsInContainer(
  containerId: string,
  fileMounts: Record<string, { content_b64: string; mode: string }>,
): Promise<string[]> {
  const hostTempFiles: string[] = [];
  // One temp dir per spawn, cleaned up by the caller after cp completes.
  const tempDir = await mkdtemp(join(tmpdir(), "appstrate-files-"));
  hostTempFiles.push(tempDir);

  // The temp dir holds decoded (decrypted) credential bytes on the host fs
  // (not tmpfs). The caller only registers it for cleanup AFTER we return
  // successfully — so if any `writeFile` / `docker exec` / `docker cp`
  // throws mid-way, we must remove it here before re-throwing, otherwise
  // the decrypted bytes leak on disk for good. The happy-path cleanup
  // contract is unchanged: on success we return the dir and the caller
  // owns its lifecycle.
  try {
    for (const [containerPath, entry] of Object.entries(fileMounts)) {
      // R8a — refuse paths into kernel-managed / privilege-escalation
      // surfaces. The platform-side validator already strips `..` /
      // relative paths; this is the second floor.
      if (!isContainerPathSafeForMount(containerPath)) {
        throw new Error(
          `integration-runtime-adapter-docker: refused to mount credential file at unsafe container path ${containerPath}`,
        );
      }
      // Decode bytes from the base64 wire form.
      const bytes = Buffer.from(entry.content_b64, "base64");
      // Random host-side filename — the container path is reconstructed
      // separately, so we don't leak the manifest path into the host fs.
      const hostFile = join(tempDir, `f-${hostTempFiles.length}`);
      await writeFile(hostFile, bytes);
      // chmod on the host side so the runner reads the file with the
      // requested mode after `docker cp` (cp preserves perms from source).
      const modeOctal = parseInt(entry.mode, 8);
      if (!Number.isNaN(modeOctal)) {
        await chmod(hostFile, modeOctal);
      }
      // R8a — pre-create the parent dir inside the container so `docker cp`
      // succeeds when the manifest path goes deeper than the runner image's
      // baked-in tree (e.g. `/etc/appstrate/certs/`). The container is in
      // `Created` state before `docker start`; `docker exec` against it works
      // since Docker 1.13 (exec runs `runc exec` which doesn't require the
      // PID 1 process to be live — it creates a new process namespace
      // member). We swallow errors (some older runtimes refuse exec on a
      // not-yet-started container) and fall back to the historical behaviour
      // where `docker cp` itself errors out — the run boot then fails fast
      // with a clear message that surfaces in the boot report.
      const parent = posix.dirname(containerPath);
      if (parent !== "/" && parent !== ".") {
        // `mkdir -p` is idempotent and works on every base image
        // (busybox/alpine/slim). Using `--user 0` would require an
        // elevated runner; we accept the default user (`node` / `python`
        // / `nobody` depending on image) — the runner has write
        // permissions to its own writable layer regardless.
        await dockerExec(["exec", containerId, "mkdir", "-p", parent]).catch(() => {
          // Older docker / not-yet-started container: ignore. The
          // subsequent `docker cp` will surface the missing-parent error
          // itself if the directory truly doesn't exist.
        });
      }
      await dockerExec(["cp", hostFile, `${containerId}:${containerPath}`]);
    }
  } catch (err) {
    // Failed before returning the dir to the caller's collector — wipe the
    // decrypted credential bytes ourselves, then re-throw so the per-spec
    // try/catch in `integrations-boot.ts` records the failure.
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  return hostTempFiles;
}

/**
 * Write integration credentials to a private, 0600 `docker --env-file` on the
 * host, returning the file path plus its containing temp dir (for cleanup).
 *
 * Why a file rather than `-e KEY=VALUE`: command-line args are world-readable
 * via `/proc/<pid>/cmdline`, so passing secrets on the docker CLI's argv leaks
 * the plaintext to any local process for the duration of `docker create`. An
 * env-file keeps the values off argv; the caller reads it once (create bakes
 * the env into the container config) and deletes it immediately after.
 *
 * The file uses docker's `KEY=VALUE`-per-line format. Values are written
 * verbatim; docker parses each line up to the first newline, so a credential
 * value must not itself contain a newline (integration credentials are tokens/
 * keys — single-line by construction). Created with mode 0600 (+ explicit
 * chmod, defeating a permissive umask) so only the sidecar uid can read it.
 */
async function writeSecretEnvFile(
  env: Record<string, string>,
): Promise<{ path: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "appstrate-env-"));
  const path = join(dir, "integration.env");
  const body = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  await writeFile(path, body, { mode: 0o600 });
  // Explicit chmod in case the process umask stripped bits at create time.
  await chmod(path, 0o600);
  return { path, dir };
}

/**
 * Per-run transparent egress infrastructure (#779): the sidecar's IP on
 * the per-run bridge, the DNS responder that resolves every external name
 * to it, and the SNI-passthrough splicers on :443/:80. `null` when the
 * setup failed or doesn't apply — spawn() then omits `--dns` and the
 * runner degrades to the proxy-env-only contract (pre-#779 behaviour).
 */
interface TransparentEgressInfra {
  readonly dnsIp: string;
  readonly handles: ReadonlyArray<{ close(): Promise<void> }>;
}

/**
 * Discover the sidecar's own IPv4 on the per-run network and mount the
 * transparent egress plane on it. Binding to that specific IP (not
 * 0.0.0.0) keeps :53/:443/:80 off the sidecar's other interfaces (the
 * shared egress network) — only this run's containers can reach them.
 *
 * Low-port binds require the platform to have granted
 * `net.ipv4.ip_unprivileged_port_start=0` on the sidecar container (it
 * does whenever the run declares integrations). Any failure — inspect,
 * bind, older daemon — is logged and swallowed: transparent egress is an
 * interop layer, not a security boundary, so degrading to the CONNECT
 * proxy contract is always safe.
 *
 * The splicers use the default DNS resolver for their resolve-and-pin
 * floor — deliberately NOT `bundleFetchOpts.resolveHostFn`, which is a
 * test-injection seam (always `undefined` in production; see the
 * `bootIntegrations` call in server.ts) and isn't threaded through the
 * adapter interface. If a production resolver override ever lands,
 * revisit so both egress planes resolve identically.
 */
async function setupTransparentEgress(runNetwork: string): Promise<TransparentEgressInfra | null> {
  const handles: Array<{ close(): Promise<void> }> = [];
  try {
    // `hostname()` inside a container is the container ID — inspect self.
    const ip = await dockerExec([
      "inspect",
      "--format",
      `{{(index .NetworkSettings.Networks "${runNetwork}").IPAddress}}`,
      hostname(),
    ]);
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      throw new Error(`could not resolve sidecar IP on ${runNetwork} (got '${ip}')`);
    }
    const onEvent = (event: { kind: string; target: string; reason?: string }) => {
      const log = event.kind === "tunnel-opened" ? logger.info : logger.warn;
      log.call(logger, "transparent egress event", event);
    };
    const dns = createIntegrationDnsResponder({ answerIpv4: ip, host: ip, port: 53 });
    handles.push(dns);
    const tls = createTransparentEgressListener({ host: ip, port: 443, onEvent });
    handles.push(tls);
    const http = createTransparentEgressListener({ host: ip, port: 80, onEvent });
    handles.push(http);
    await Promise.all([dns.ready, tls.ready, http.ready]);
    logger.info("transparent egress ready", { dnsIp: ip });
    return { dnsIp: ip, handles };
  } catch (err) {
    for (const h of handles) {
      await h.close().catch(() => {});
    }
    logger.warn(
      "transparent egress unavailable — env-delivery runners fall back to the CONNECT proxy contract (proxy-unaware HTTP clients will fail, #779)",
      { error: err instanceof Error ? err.message : String(err) },
    );
    return null;
  }
}

export function createDockerIntegrationRuntimeAdapter(): IntegrationRuntimeAdapter {
  const containerIds: string[] = [];
  /** Per-spawn host temp directories holding decoded fileMounts bytes. */
  const hostTempDirsByContainer: Map<string, string[]> = new Map();
  let runNetwork: string | null = null;
  let transparentEgress: TransparentEgressInfra | null = null;

  return {
    id: "docker",

    async prepare(runId: string): Promise<RuntimeAdapterRunContext> {
      // The per-run docker network is created by the platform launcher
      // (`appstrate-exec-<runId>`) with the sidecar attached under the
      // `sidecar` DNS alias. The runner joins the same network so its
      // HTTPS_PROXY resolves via Docker's embedded DNS. RUN_ID is set
      // on sidecar create; when it's absent (sidecar booted outside
      // the platform launcher's path — dev / tests), we fall back to
      // the default bridge with loopback URLs and skip the alias path.
      const envRunId = process.env.RUN_ID;
      runNetwork = envRunId ? `appstrate-exec-${envRunId}` : null;
      // #779 — transparent egress plane for proxy-unaware HTTP clients.
      // Only meaningful on a per-run bridge (a routable sidecar IP exists).
      transparentEgress = runNetwork ? await setupTransparentEgress(runNetwork) : null;
      logger.info("docker integration adapter ready", { runId, runNetwork });
      return {
        // Bind 0.0.0.0 when we have a per-run network — the runner
        // reaches the listener via the bridge. Without a network we
        // can't make the listener routable from a sibling container
        // anyway, so 127.0.0.1 is the safe default.
        listenerBindHost: runNetwork ? "0.0.0.0" : "127.0.0.1",
        proxyUrlFor: (port: number) =>
          runNetwork ? `http://sidecar:${port}` : `http://127.0.0.1:${port}`,
      };
    },

    async spawn(options: SpawnIntegrationOptions): Promise<SpawnedIntegration> {
      const { runId, spec, bundleRoot, egress, browser, workspaceHandle, onStderrLine } = options;
      const plan = planContainer(spec, bundleRoot);
      const safeNs = spec.namespace.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
      const containerName = `appstrate-integ-${safeNs}-${runId.slice(0, 8)}-${Date.now()}`;

      // Only NON-secret routing env rides `-e` on the command line. The
      // integration credentials (`spec.spawnEnv`) are delivered via a 0600
      // `--env-file` instead — see `writeSecretEnvFile` and the create call
      // below. Passing them as `-e KEY=VALUE` would expose the plaintext in
      // the docker CLI's argv (`/proc/<pid>/cmdline`, world-readable) for the
      // create's lifetime.
      const envFlags: string[] = [];
      if (egress) {
        // Proxy routing for BOTH listener kinds (MITM + plain CONNECT).
        // The proxy URL is `http://sidecar:<port>` (non-secret routing info).
        for (const [k, v] of Object.entries(buildProxyEnvBlock(egress.proxyUrl))) {
          envFlags.push("-e", `${k}=${v}`);
        }
        // CA trust ONLY for a TLS-terminating MITM listener; a plain CONNECT
        // egress listener has a null caCertHostPath → no CA env, no cert mint.
        // The CA env values are container file paths (non-secret).
        if (egress.caCertHostPath !== null) {
          for (const [k, v] of Object.entries(buildCaEnvBlock(CA_CONTAINER_PATH))) {
            envFlags.push("-e", `${k}=${v}`);
          }
        }
      }

      // Per-run shared workspace mount. Wired ONLY when the spec's
      // referenced mcp-server opted in via _meta.workspace AND the
      // launching orchestrator carried a workspace handle of the right
      // shape (volume for docker). A volume mismatch (spec says yes,
      // handle says no / wrong-kind) is logged as a warning and the
      // runner spawns without workspace access rather than aborting
      // the run.
      const volumeFlags: string[] = [];
      if (spec.workspaceMount) {
        if (workspaceHandle?.kind === "volume") {
          const roSuffix = spec.workspaceMount.access === "ro" ? ":ro" : "";
          volumeFlags.push("-v", `${workspaceHandle.name}:${spec.workspaceMount.mount}${roSuffix}`);
          envFlags.push("-e", `${WORKSPACE_ENV_VAR}=${spec.workspaceMount.mount}`);
        } else {
          // ERROR-level (not warn): the mcp-server author explicitly
          // opted into a shared workspace via `_meta.workspace` AND
          // the platform's MCP Roots advertisement will tell its
          // protocol client the path is available — but the actual
          // bind is missing. A SOTA mcp-server that caches roots/list
          // would then issue write calls against an unmounted path,
          // failing in ways that look like server bugs rather than
          // misconfig. Surface loudly so operators see it on the
          // first run, not the tenth.
          logger.error(
            "spec declares workspaceMount but launching orchestrator carried no volume handle; runner spawned WITHOUT workspace — opt-in mcp-server tools will fail",
            {
              integrationId: spec.integrationId,
              haveHandle: workspaceHandle?.kind ?? "none",
              declaredMount: spec.workspaceMount.mount,
              declaredAccess: spec.workspaceMount.access,
            },
          );
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
        `appstrate.integration=${spec.integrationId}`,
      ];

      const networkFlags: string[] = runNetwork ? ["--network", runNetwork] : [];

      // #779 — transparent egress for `delivery.env` runners (plain CONNECT
      // egress, `caCertHostPath === null`). `--dns` points the embedded DNS
      // forwarder (127.0.0.11) at the sidecar's responder, so external names
      // resolve to the sidecar's SNI-passthrough splicer and proxy-unaware
      // HTTP clients (undici/fetch, axios) get egress without cooperating.
      // Network aliases (`sidecar`) keep resolving locally in the embedded
      // DNS — only external lookups are forwarded. MITM-delivery runners are
      // deliberately excluded: splicing their traffic would silently bypass
      // credential injection; their contract stays proxy-env + CA trust.
      const dnsFlags: string[] =
        egress && egress.caCertHostPath === null && transparentEgress
          ? ["--dns", transparentEgress.dnsIp]
          : [];

      // Deliver integration credentials off-argv via a 0600 env-file. `docker
      // create` reads the file synchronously and bakes the values into the
      // container config, so we can (and do) delete it immediately after —
      // minimising how long the decrypted secrets sit on the host fs. The
      // container sees exactly the same env vars as before.
      const envFileFlags: string[] = [];
      let secretEnvDir: string | null = null;
      const secretEnv = {
        ...spec.spawnEnv,
        ...(browser
          ? {
              APPSTRATE_BROWSER_ENDPOINT: browser.endpoint,
              APPSTRATE_BROWSER_TOKEN: browser.authToken,
              APPSTRATE_BROWSER_PROTOCOL: String(browser.protocolVersion),
            }
          : {}),
      };
      if (Object.keys(secretEnv).length > 0) {
        const written = await writeSecretEnvFile(secretEnv);
        secretEnvDir = written.dir;
        envFileFlags.push("--env-file", written.path);
      }

      let containerId: string;
      try {
        containerId = await dockerExec([
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
          ...dnsFlags,
          ...volumeFlags,
          ...labelFlags,
          ...envFileFlags,
          ...envFlags,
          plan.image,
          plan.containerEntry,
        ]);
      } finally {
        // Wipe the decrypted-secret env-file whether create succeeded or not.
        if (secretEnvDir) {
          await rm(secretEnvDir, { recursive: true, force: true }).catch(() => {});
        }
      }
      containerIds.push(containerId);

      // docker cp <src>/. <id>:/<dst>/  — the trailing `/.` semantics
      // copy the directory's *contents* into /bundle (already exists in
      // the runner image as the WORKDIR), so the runner's entrypoint
      // sees `/bundle/server/index.js` at the path the manifest declared.
      await dockerExec(["cp", `${bundleRoot}/.`, `${containerId}:/bundle/`]);
      // Deliver the run CA only for a TLS-terminating MITM listener. A plain
      // CONNECT egress listener does not terminate TLS, so the runner needs no
      // extra CA (null caCertHostPath).
      if (egress && egress.caCertHostPath !== null) {
        await dockerExec(["cp", egress.caCertHostPath, `${containerId}:${CA_CONTAINER_PATH}`]);
      }

      // AFPS §7.6 (CC-5) — materialise `delivery.files` entries into
      // the runner container BEFORE `docker start -ai` so the entrypoint
      // observes them at boot. The host temp dir is cleaned up by
      // `shutdown()` (we keep the reference so cleanup is exception-safe).
      if (spec.fileMounts && Object.keys(spec.fileMounts).length > 0) {
        const hostTempDirs = await materializeFileMountsInContainer(containerId, spec.fileMounts);
        hostTempDirsByContainer.set(containerId, hostTempDirs);
      }

      // `docker start -ai <id>` starts the entrypoint AND attaches stdio.
      // SubprocessTransport spawns this as a child, pipes the JSON-RPC
      // line stream through, and tears the whole thing down on close().
      // Auto-rm on the container side handles cleanup if we crash without
      // a graceful close.
      const transport = new SubprocessTransport({
        command: "docker",
        args: ["start", "-ai", containerId],
        // `env` is NOT passed to the docker CLI — credentials were baked
        // into the container at create-time via the (now-deleted) 0600
        // `--env-file`. The CLI only needs PATH/HOME/DOCKER_HOST to find
        // the daemon socket.
        envPassthrough: ["PATH", "HOME", "DOCKER_HOST"],
        onStderrLine,
      });

      return { transport, diagnosticId: containerId.slice(0, 12) };
    },

    async shutdown(): Promise<void> {
      // Container kill is best-effort — `--rm` will clean up after
      // SubprocessTransport closes the docker-attach stdio anyway. This
      // belt-and-suspenders kill covers servers that ignore stdin EOF.
      for (const id of containerIds) {
        await killContainer(id);
      }
      containerIds.length = 0;
      // AFPS §7.6 (CC-5) — clean up host-side temp files holding
      // decoded `delivery.files` bytes. Best-effort: if the dir is gone
      // (already cleaned, container's own --rm removed it, …) we skip.
      for (const dirs of hostTempDirsByContainer.values()) {
        for (const dir of dirs) {
          await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      }
      hostTempDirsByContainer.clear();
      // #779 — tear down the transparent egress plane (DNS responder +
      // SNI-passthrough splicers). Idempotent: close() resolves even when
      // the underlying socket already died.
      if (transparentEgress) {
        for (const h of transparentEgress.handles) {
          await h.close().catch(() => {});
        }
        transparentEgress = null;
      }
    },
  };
}

registerIntegrationRuntimeAdapter({
  id: "docker",
  create: createDockerIntegrationRuntimeAdapter,
});
