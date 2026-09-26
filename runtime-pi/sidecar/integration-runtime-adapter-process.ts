// SPDX-License-Identifier: Apache-2.0

/**
 * In-process integration runtime adapter — the universal fallback.
 *
 * Spawns each integration MCP server as a direct subprocess of the sidecar
 * (`Bun.spawn`): no container, no per-run network. Runners share the sidecar's
 * network namespace, so every listener binds 127.0.0.1 and the MITM CA is a
 * path on the shared fs. Used in dev, in tests and inside the Firecracker
 * guest; on Docker the docker adapter takes precedence.
 *
 * A runner on the sidecar's uid could read `/proc/<sidecar-pid>/environ` — the
 * platform API key, the run token, the proxy basic-auth, every connected
 * integration's decrypted credentials. So this adapter REFUSES to spawn without
 * a setuid exec wrapper (`APPSTRATE_RUNNER_EXEC`) and a runner uid pool
 * (`APPSTRATE_RUNNER_UIDS`), which only the Firecracker guest supervisor
 * provides; see {@link requireRunnerIsolation}.
 *
 * Each runner execs as `<wrapper> [--workspace] <uid> <command> [args...]` on
 * a pool uid of its own, which is how listener peers are attributed: the
 * kernel's socket table (`/proc/net/tcp`) names the uid owning the client end
 * of each connection a listener accepts ({@link socketOwnerUid}). The guest gives a
 * runner uid loopback-only egress and redirects its DNS to 127.0.0.1:53, so
 * every route out crosses a sidecar listener: the runner's own CONNECT/MITM
 * listener, or the transparent plane (#779) this adapter mounts on 127.0.0.1
 * for proxy-unaware clients, on the first plain-CONNECT runner's spawn.
 */

import { mkdir, readFile, stat, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { SubprocessTransport } from "@appstrate/mcp-transport";
import { isMcpServerRuntime, type McpServerRuntime } from "@appstrate/core/mcp-server";
import type { EgressPolicy } from "@appstrate/afps-runtime/resolvers";

import type { Endpoint, Peer } from "./helpers.ts";
import { logger } from "./logger.ts";
import type { IntegrationSpawnSpec } from "./integrations-boot.ts";
import {
  startTransparentEgressPlane,
  type TransparentEgressPlane,
  type TransparentEgressPlaneOptions,
} from "./integration-transparent-listener.ts";
import { noRunnerPeers, policyForRunnerPeer, type PeerAttribution } from "./runner-peers.ts";
import {
  buildProxyEnvBlock,
  buildCaEnvBlock,
  isPathSafeForMount,
  normalizeMountPath,
  registerIntegrationRuntimeAdapter,
  resolveBundleEntry,
  WORKSPACE_ENV_VAR,
  type IntegrationRuntimeAdapter,
  type RuntimeAdapterRunContext,
  type SpawnIntegrationOptions,
  type SpawnedIntegration,
} from "./integration-runtime-adapter.ts";

/**
 * Subprocess-mode interpreter mapping. Symmetric with
 * RUNNER_IMAGE_BY_TYPE in the docker adapter — adding a new runtime
 * requires updating both.
 */
const HOST_INTERPRETER_BY_TYPE: Record<
  McpServerRuntime,
  { command: string; argsBefore: string[] }
> = {
  node: { command: "node", argsBefore: [] },
  // `bun` runs the entry directly (`.ts` / `.js`) — the sidecar's own
  // runtime, always on PATH in process mode. In docker mode the docker
  // adapter runs bun in the `appstrate-mcp-runner-bun` container instead.
  bun: { command: "bun", argsBefore: [] },
  python: { command: "python3", argsBefore: ["-u"] },
  // MCPB 0.4 / AFPS §3.4 — `uv run <entry>` resolves a project's
  // virtualenv + dependencies on the fly. Requires `uv` on PATH; we fail
  // fast at spawn-time with a clear error if it's missing (see
  // `planSubprocess`). The `-u` would only apply to a direct Python
  // invocation; `uv run` forwards stdout/stderr unbuffered by default.
  uv: { command: "uv", argsBefore: ["run"] },
  // `binary` is a no-op: exec the bundle entry directly.
  binary: { command: "", argsBefore: [] },
};

/** Inclusive uid range the supervisor reserves for runners, one uid per runner. */
interface RunnerUidPool {
  first: number;
  last: number;
}

/** `APPSTRATE_RUNNER_UIDS` (`"<first>-<last>"`) parsed strictly; a string says why it is unusable. */
function parseRunnerUidPool(raw: string | undefined): RunnerUidPool | string {
  if (raw === undefined) return "no APPSTRATE_RUNNER_UIDS runner uid pool";
  const match = /^(\d+)-(\d+)$/.exec(raw);
  const first = Number(match?.[1]);
  const last = Number(match?.[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first > last) {
    return `APPSTRATE_RUNNER_UIDS "${raw}" is not a "<first>-<last>" uid range with first <= last`;
  }
  return { first, last };
}

/**
 * Fail-closed gate on the only thing that makes a host subprocess a
 * boundary: the ability to land each runner on a uid of its own.
 *
 * The Firecracker guest supervisor sets `APPSTRATE_RUNNER_EXEC` to a
 * setuid wrapper (`spawnAs`, `modules/firecracker/guest/supervisor.ts`)
 * and `APPSTRATE_RUNNER_UIDS` to the uid pool that wrapper accepts, so
 * each runner there executes on its own runner uid: the sidecar's environ
 * is unreadable to it, and the listeners can tell it from the other
 * runners. Nothing else sets them — host process mode (the
 * `RUN_ADAPTER=process` default, the zero-install path) has no portable
 * way to drop privilege from Bun, so the runner would be a same-uid child
 * that can read every credential the sidecar holds.
 *
 * The env allowlist in `SubprocessTransport` does not close that: it
 * bounds what we HAND the child, not what the child can go and read out
 * of the parent. The boundary therefore moves to admission — refuse the
 * spawn — rather than pretending a scrubbed env is isolation.
 *
 * Third-party bytes are the reason this is a refusal and not a warning:
 * a `source.kind: "local"` integration runs code the platform fetched
 * from a package registry, in the sidecar's own trust domain. Only
 * `local` integrations spawn at all — `remote` (Streamable HTTP MCP)
 * and `none` (api_call-only) never reach an adapter, so they are
 * unaffected by this gate.
 *
 * What is checked, and what that proves. The wrapper var must name a regular
 * file carrying the SETUID bit (`S_ISUID`) — the shipped wrapper is built
 * `chown root:1000` + `chmod 4750`
 * (`apps/api/src/modules/firecracker/scripts/Dockerfile.rootfs`). Presence
 * alone proved nothing: `APPSTRATE_RUNNER_EXEC=/usr/bin/env` satisfied it while
 * exec'ing the runner on the sidecar's own uid, so the gate reported a boundary
 * that did not exist. A file with no setuid bit CANNOT change the child's uid,
 * whatever it does once running, so refusing it is exact. The pool must parse
 * as a uid range: without one there is no uid to hand the wrapper.
 *
 * It is not checked that the setuid owner is root, or that it is anyone other
 * than the sidecar's own uid: a stat cannot tell a privilege DROP from a
 * same-uid setuid file, and the wrapper's uid layout is the guest image's to
 * declare, not the sidecar's to assume (the wrapper itself refuses a uid
 * outside its compiled pool). This is a misconfiguration gate, not an
 * adversary boundary — the party who sets these env vars is the orchestrator,
 * and the party it defends against is the third-party runner bytes, which
 * cannot set them.
 *
 * Returns the wrapper path and the narrowed pool, so the check and the values
 * it gates can never disagree.
 */
async function requireRunnerIsolation(
  spec: IntegrationSpawnSpec,
  uidPool: RunnerUidPool | string,
): Promise<{ wrapper: string; pool: RunnerUidPool }> {
  const wrapper = process.env.APPSTRATE_RUNNER_EXEC;
  const serverPackageId = spec.manifest.server?.packageId ?? spec.integrationId;
  // Explicitly typed so TypeScript narrows past each refusal: a `never`
  // return only narrows through an annotated binding.
  const refuse: (why: string) => never = (why: string) => {
    throw new Error(
      `${spec.integrationId}: refusing to spawn its mcp-server "${serverPackageId}" — ` +
        `source.kind "local" runs third-party code, which this adapter spawns only on a uid ` +
        `of its own, through a setuid APPSTRATE_RUNNER_EXEC wrapper onto a uid from the ` +
        `APPSTRATE_RUNNER_UIDS pool (${why}). On the sidecar's uid the runner could read the ` +
        `sidecar's environment — platform API key, run token, proxy credentials, every ` +
        `connected integration's decrypted tokens — straight out of /proc; on a shared uid ` +
        `the egress listeners could not tell it from another runner. Remedies, cheapest ` +
        `first: set INTEGRATION_RUNTIME_ADAPTER=docker to keep the run itself in process ` +
        `mode while each integration runner gets its own container; or run under ` +
        `RUN_ADAPTER=docker; or under RUN_ADAPTER=firecracker, whose guest supervisor ` +
        `provides both. Integrations whose source.kind is "remote" or "none" spawn nothing ` +
        `and are unaffected.`,
    );
  };
  if (!wrapper) refuse("no APPSTRATE_RUNNER_EXEC wrapper");

  // The try wraps ONLY the syscall, so a refusal thrown below cannot be
  // mistaken for a stat failure and re-labelled.
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(wrapper);
  } catch {
    refuse(`APPSTRATE_RUNNER_EXEC "${wrapper}" does not exist or cannot be stat'ed`);
  }
  if (!st.isFile()) refuse(`APPSTRATE_RUNNER_EXEC "${wrapper}" is not a regular file`);
  // 0o4000 = S_ISUID. Bun exposes no `constants.S_ISUID`, and the octal is the
  // same number the wrapper's `chmod 4750` writes.
  if ((st.mode & 0o4000) === 0) {
    refuse(
      `APPSTRATE_RUNNER_EXEC "${wrapper}" carries no setuid bit, so exec'ing it leaves the runner on the sidecar's uid`,
    );
  }
  if (typeof uidPool === "string") refuse(uidPool);
  return { wrapper, pool: uidPool };
}

/**
 * Uid owning the runner-side client socket of the connection a listener
 * accepted from `peer`, from `/proc/net/tcp` text: the ESTABLISHED row keyed by
 * that connection's 4-tuple — `local_address` is the peer's end and
 * `rem_address` the listener's (the accepted socket is the mirror row, and
 * SO_REUSEADDR sockets sharing the peer's end have another remote). IPv4 only:
 * process-mode listeners bind 127.0.0.1. The kernel prints each address as the
 * host-order hex of the network-order u32, read here as little-endian (x86_64
 * and aarch64 guests both are), and the port as plain hex: 127.0.0.1:8080 is
 * `0100007F:1F90`.
 */
export function socketOwnerUid(procNetTcp: string, peer: Peer): number | undefined {
  const local = procNetTcpEndpoint(peer);
  const remote = procNetTcpEndpoint(peer.listener);
  if (local === undefined || remote === undefined) return undefined;
  for (const line of procNetTcp.split("\n")) {
    // sl local_address rem_address st tx:rx tr:when retrnsmt uid …
    const fields = line.trim().split(/\s+/);
    if (fields[1] === local && fields[2] === remote && fields[3] === "01") {
      const uid = Number(fields[7]);
      return Number.isSafeInteger(uid) ? uid : undefined;
    }
  }
  return undefined;
}

/** An IPv4 endpoint as `/proc/net/tcp` prints it; undefined for anything else. */
function procNetTcpEndpoint({ address, port }: Endpoint): string | undefined {
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address)?.slice(1);
  if (!octets || !Number.isInteger(port) || port < 0 || port > 0xffff) return undefined;
  const hex = (n: number, width: number) => n.toString(16).toUpperCase().padStart(width, "0");
  return `${octets
    .map((octet) => hex(Number(octet), 2))
    .reverse()
    .join("")}:${hex(port, 4)}`;
}

/**
 * `/proc/net/tcp` is generated a page at a time, so a read racing socket churn
 * can skip a row: a miss is re-read up to this many reads in total.
 */
const PROC_NET_TCP_READS = 3;

interface SubprocessPlan {
  command: string;
  args: string[];
  cwd: string;
}

function planSubprocess(spec: IntegrationSpawnSpec, bundleRoot: string): SubprocessPlan {
  const server = spec.manifest.server;
  if (!server) {
    throw new Error("integration-runtime-adapter-process: spec has no server to spawn");
  }
  const t = server.type;
  if (!t) {
    throw new Error(
      "integration-runtime-adapter-process: server.type required for local-source spawn",
    );
  }
  if (!isMcpServerRuntime(t)) {
    throw new Error(
      `integration-runtime-adapter-process: server.type "${t}" has no host-interpreter mapping`,
    );
  }
  const cfg = HOST_INTERPRETER_BY_TYPE[t];
  const entry = server.entry_point;
  if (!entry) {
    throw new Error(
      `integration-runtime-adapter-process: server.entry_point required for server.type="${t}"`,
    );
  }
  const absEntry = resolveBundleEntry(bundleRoot, entry);
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
 * AFPS §7.6 (CC-5) — materialise `delivery.files` for the process
 * adapter. Subprocesses share the host filesystem, so we attempt to write
 * each entry at the manifest-declared absolute path with the requested
 * mode. When that fails (typically a dev machine without write permission
 * to `/run/`, `/etc/`, …), we fall back to a per-run scratch dir under the
 * sidecar's tmp space and surface the actual path via an env var
 * `APPSTRATE_FILE_MOUNT_<sanitized-path>` so the integration code can pick
 * it up. Pure-Docker deployments don't hit the fallback (the runner image
 * always permits writes to `/tmp` and `/run/`).
 *
 * Returns the set of created paths so `shutdown()` can clean them up.
 */
/**
 * R8a — safe-path floor for `delivery.files` on the process adapter.
 *
 * ENTIRELY the shared floor: {@link isPathSafeForMount} refuses every surface
 * the system reads on its own initiative — kernel-managed trees, the PATH and
 * loader search directories, the loader/shell/cron/auth files, the system
 * trust store, and the per-run `/workspace/` tree. `/usr/` and `/workspace/`
 * used to be passed here as this adapter's extras; they are not
 * adapter-specific and both adapters passed them, so they moved into the floor
 * along with the rest of the class `/usr/` was refused for.
 *
 * Why the floor matters MORE here than under docker: this adapter has FEWER
 * containment layers, not more. It is the Tier-0 default and what the
 * Firecracker orchestrator pins, and `materializeFileMountsOnHost` does
 * `mkdir -p` + `writeFile` at the manifest-declared path with the
 * manifest-declared mode, so the bytes reach the host or the guest rootfs
 * directly.
 *
 * ADAPTER-SPECIFIC, and deliberately NOT enforced here: `/.docker/` and
 * `/.dockerenv`. Those are Docker-private surfaces that exist inside a runner
 * container and mean nothing on the host filesystem.
 *
 * `delivery.files` exists for certs, keys and service-account JSON, which
 * belong under `/run/`, `/etc/<vendor>/` or `/tmp/` — none of the above.
 */
export function isHostPathSafeForMount(hostPath: string): boolean {
  return isPathSafeForMount(hostPath);
}

export async function materializeFileMountsOnHost(
  runId: string,
  fileMounts: Record<string, { content_b64: string; mode: string }>,
): Promise<{ createdPaths: string[]; envOverrides: Record<string, string> }> {
  const createdPaths: string[] = [];
  const envOverrides: Record<string, string> = {};

  for (const [declaredPath, entry] of Object.entries(fileMounts)) {
    // The path is canonicalized ONCE, and everything downstream — the safety
    // check, the `mkdir -p`, the `writeFile`, the scratch mirror and the env
    // override name — uses that one form. Checking `/./usr/local/bin/gh` while
    // writing it is how the floor was bypassed: the check compared strings and
    // the kernel resolved the path, landing the file on the PATH the check had
    // just refused.
    const containerPath = normalizeMountPath(declaredPath);
    // R8a — refuse kernel-managed / privilege-escalation / auto-consumed
    // surfaces even on the process adapter. The fallback scratch path bypass
    // is also gated on this check: a manifest pointing at `/dev/null` would
    // otherwise silently write to the scratch dir, mojibake'ing the contract.
    if (!isHostPathSafeForMount(containerPath)) {
      logger.warn("delivery.files: refused to mount credential file at unsafe path; skipping", {
        manifestPath: declaredPath,
      });
      continue;
    }
    const bytes = Buffer.from(entry.content_b64, "base64");
    const modeOctal = parseInt(entry.mode, 8);
    const finalMode = Number.isNaN(modeOctal) ? 0o400 : modeOctal;

    let writtenAt: string | null = null;
    try {
      // Try the manifest-declared path first. Best-effort `mkdir -p` for
      // the parent: deeper-than-existing paths get created if we have
      // permission, otherwise the writeFile catches and we fall back.
      const parent = dirname(containerPath);
      if (parent && parent !== "/" && parent !== ".") {
        await mkdir(parent, { recursive: true });
      }
      await writeFile(containerPath, bytes, { mode: finalMode });
      await chmod(containerPath, finalMode);
      writtenAt = containerPath;
    } catch (err) {
      // Fall back to a per-run scratch dir. Mirror the manifest path
      // structure so two files with the same basename don't collide.
      const scratchRoot = join(tmpdir(), `appstrate-mounts-${runId}`);
      const scratchPath = join(
        scratchRoot,
        containerPath.replace(/^\/+/, "").replace(/[^A-Za-z0-9._/-]+/g, "_"),
      );
      try {
        await mkdir(dirname(scratchPath), { recursive: true });
        await writeFile(scratchPath, bytes, { mode: finalMode });
        await chmod(scratchPath, finalMode);
        writtenAt = scratchPath;
        // Sanitise the manifest path into a valid env-var name fragment.
        const envSuffix = containerPath
          .replace(/^\/+/, "")
          .replace(/[^A-Za-z0-9]+/g, "_")
          .toUpperCase();
        envOverrides[`APPSTRATE_FILE_MOUNT_${envSuffix}`] = scratchPath;
        logger.info(
          "delivery.files: fell back to scratch path (process adapter could not write manifest path)",
          { manifestPath: containerPath, scratchPath, error: String(err) },
        );
      } catch (fallbackErr) {
        logger.warn("delivery.files: both manifest and scratch write failed; skipping entry", {
          manifestPath: containerPath,
          error: String(fallbackErr),
        });
      }
    }
    if (writtenAt) createdPaths.push(writtenAt);
  }

  return { createdPaths, envOverrides };
}

export function createProcessIntegrationRuntimeAdapter({
  // procfs reports size 0; readFile reads to EOF.
  readProcNetTcp = () => readFile("/proc/net/tcp", "utf8"),
  transparentPlane = {},
}: {
  /** Kernel TCP socket table; tests inject fixtures. */
  readProcNetTcp?: () => Promise<string>;
  /** Transparent plane ports and splicer stubs; tests cannot bind 53/443/80. */
  transparentPlane?: Pick<TransparentEgressPlaneOptions, "ports" | "splicer">;
} = {}): IntegrationRuntimeAdapter {
  /**
   * Files/dirs created for `delivery.files` materialisation, cleaned up on
   * shutdown so per-run credential material doesn't outlive the run.
   */
  const createdPaths: string[] = [];
  // Read once: admission and attribution judge the same pool.
  const uidPool = parseRunnerUidPool(process.env.APPSTRATE_RUNNER_UIDS);
  /** Runner uid → integration id, one uid per `spawn()`, allocated in pool order. */
  const runnersByUid = new Map<number, string>();
  let allocatedUids = 0;
  /** Integration id → policy the transparent plane serves that runner. */
  const transparentPolicies = new Map<string, EgressPolicy>();
  let plane: Promise<TransparentEgressPlane | null> | null = null;
  /** Set by `shutdown()`: a plane started after it would have no one to close it. */
  let shutDown = false;
  const refuseAfterShutdown = () => {
    if (shutDown) throw new Error("process integration adapter is shut down");
  };

  const attribution: PeerAttribution =
    typeof uidPool === "string"
      ? // No pool: admission refuses every spawn, so no peer can be a runner.
        noRunnerPeers
      : async (peer) => {
          // A pool uid exists only through `spawn()`, which registers it before
          // the runner starts.
          if (runnersByUid.size === 0) return null;
          // Not IPv4: no row can ever name it, so no re-read can either.
          if (!procNetTcpEndpoint(peer) || !procNetTcpEndpoint(peer.listener)) return undefined;
          for (let read = 1; ; read += 1) {
            let table: string;
            try {
              table = await readProcNetTcp();
            } catch (err) {
              logger.warn("runner peer lookup failed — refusing unattributable peers", {
                error: err instanceof Error ? err.message : String(err),
              });
              return undefined;
            }
            const uid = socketOwnerUid(table, peer);
            if (uid !== undefined) {
              if (uid < uidPool.first || uid > uidPool.last) return null;
              return runnersByUid.get(uid);
            }
            if (read === PROC_NET_TCP_READS) return undefined;
          }
        };

  /**
   * #779 — the plane, started once: its DNS answers 127.0.0.1, where the guest
   * redirects every runner's DNS. Runs without a plain-CONNECT runner never
   * bind 53/443/80.
   */
  const ensurePlane = () => {
    refuseAfterShutdown();
    return (plane ??= startTransparentEgressPlane({
      ipv4: async () => "127.0.0.1",
      policyForPeer: policyForRunnerPeer(attribution, transparentPolicies),
      ...transparentPlane,
    }));
  };

  return {
    id: "process",

    async prepare(runId: string): Promise<RuntimeAdapterRunContext> {
      logger.info("process integration adapter ready", { runId });
      // Subprocess inherits the parent's NS — loopback reaches the
      // listener directly.
      return {
        listenerBindHost: "127.0.0.1",
        proxyUrlFor: (port: number) => `http://127.0.0.1:${port}`,
      };
    },

    async spawn(options: SpawnIntegrationOptions): Promise<SpawnedIntegration> {
      refuseAfterShutdown();
      const { runId, spec, bundleRoot, egress, workspaceHandle, onStderrLine } = options;
      // First, before any credential material is rendered: a runner we are
      // going to refuse must not have `delivery.files` secrets written to
      // disk on its behalf.
      const { wrapper, pool } = await requireRunnerIsolation(spec, uidPool);
      const plan = planSubprocess(spec, bundleRoot);
      // Reserved in one synchronous block, before any further await, so two
      // concurrent spawns can never be handed the same uid.
      const uid = pool.first + allocatedUids;
      if (uid > pool.last) {
        throw new Error(
          `${spec.integrationId}: runner uid pool APPSTRATE_RUNNER_UIDS is exhausted — ` +
            `all ${pool.last - pool.first + 1} uids are held by this run's other runners`,
        );
      }
      allocatedUids += 1;
      runnersByUid.set(uid, spec.integrationId);
      // The runner reads its bundle and, when MITM-delivered, the run CA in place,
      // on its own uid, and both sit under a 0700 mkdtemp root; the entries inside
      // are written under the sidecar's umask (022 — nothing sets another), so only
      // the roots need widening. Neither is credential material (package code, a
      // public CA certificate — the CA key is staged in the minter's own 0700
      // dir), and both stay owned by the sidecar: no runner can write into them.
      await chmod(bundleRoot, 0o755);
      if (egress && egress.caCertHostPath !== null) {
        await chmod(dirname(egress.caCertHostPath), 0o755);
      }
      // The plane serves the runners docker gives `--dns`: plain-CONNECT egress.
      // A MITM-delivery runner's DNS lands on 127.0.0.1 too (the guest redirect
      // is per uid, not per kind) and the plane refuses it: splicing would
      // bypass credential injection. Up before the runner starts: its DNS lands
      // on the plane from its first lookup.
      if (egress && egress.caCertHostPath === null) {
        transparentPolicies.set(spec.integrationId, egress.policy);
        await ensurePlane();
      }
      const procEnv: Record<string, string> = { ...spec.spawnEnv };
      if (egress) {
        // Proxy routing for BOTH listener kinds (MITM + plain CONNECT).
        Object.assign(procEnv, buildProxyEnvBlock(egress.proxyUrl));
        // CA trust ONLY for a TLS-terminating MITM listener. Subprocess sees
        // the host fs directly; pass the CA path through unchanged (no docker
        // cp). A plain CONNECT egress listener has a null caCertHostPath.
        if (egress.caCertHostPath !== null) {
          Object.assign(procEnv, buildCaEnvBlock(egress.caCertHostPath));
        }
      }
      // Per-run shared workspace exposure for the subprocess. Unlike
      // docker mode (which bind-mounts a volume), the subprocess just
      // reads the host directory path directly via env var. The mcp-
      // server code uses APPSTRATE_WORKSPACE uniformly across both
      // modes so a single implementation works.
      //
      // Note: `access: "ro"` is advisory only on the process adapter —
      // there is no kernel-enforced read-only bind. Servers that need
      // hard enforcement should run in docker mode where the bind
      // mount's `:ro` flag denies writes at the syscall layer.
      const workspaceDir =
        spec.workspaceMount && workspaceHandle?.kind === "directory" ? workspaceHandle.path : null;
      if (workspaceDir !== null) {
        procEnv[WORKSPACE_ENV_VAR] = workspaceDir;
      } else if (spec.workspaceMount) {
        // ERROR-level (symmetry with the docker adapter): an opt-in
        // mcp-server whose runtime env lacks the workspace will
        // either crash on first tool call or silently misbehave —
        // operators need to see this on the first run, not buried
        // in a debug log.
        logger.error(
          "spec declares workspaceMount but launching orchestrator carried no directory handle; runner spawned WITHOUT workspace — opt-in mcp-server tools will fail",
          {
            integrationId: spec.integrationId,
            haveHandle: workspaceHandle?.kind ?? "none",
            declaredMount: spec.workspaceMount.mount,
            declaredAccess: spec.workspaceMount.access,
          },
        );
      }
      // AFPS §7.6 (CC-5) — materialise `delivery.files` entries
      // before the subprocess starts so the entrypoint sees them at boot.
      if (spec.fileMounts && Object.keys(spec.fileMounts).length > 0) {
        const { createdPaths: paths, envOverrides } = await materializeFileMountsOnHost(
          runId,
          spec.fileMounts,
        );
        createdPaths.push(...paths);
        Object.assign(procEnv, envOverrides);
      }
      // The setuid wrapper drops the runner onto its own uid instead of the
      // sidecar's: the sidecar's environ (credentials) stays unreadable, and
      // `attribution` maps the runner's sockets back to this integration. It
      // sets the runner's HOME to that uid's private home, and grants the
      // `workspace` group only on `--workspace`, so a runner reaches /workspace
      // only when handed it.
      const transport = new SubprocessTransport({
        command: wrapper,
        args: [
          ...(workspaceDir !== null ? ["--workspace"] : []),
          String(uid),
          plan.command,
          ...plan.args,
        ],
        cwd: plan.cwd,
        env: procEnv,
        envPassthrough: ["PATH", "NODE_OPTIONS"],
        onStderrLine,
      });
      return { transport, diagnosticId: null };
    },

    peerAttribution() {
      return attribution;
    },

    async shutdown(): Promise<void> {
      shutDown = true;
      // Nothing to do for the subprocess itself — SubprocessTransport owns it
      // and tears it down on `transport.close()` (called by the MCP client's
      // `client.close()` in `bootIntegrations.shutdown`).
      //
      // AFPS §7.6 (CC-5) — clean up the per-run `delivery.files`
      // material so it doesn't outlive the run. Best-effort: a file already
      // gone (deleted by the integration, parent dir wiped, …) is fine.
      for (const path of createdPaths) {
        await rm(path, { force: true }).catch(() => {});
      }
      createdPaths.length = 0;
      const started = plane;
      plane = null;
      await (await started)?.close();
      transparentPolicies.clear();
    },
  };
}

registerIntegrationRuntimeAdapter({
  id: "process",
  create: createProcessIntegrationRuntimeAdapter,
});
