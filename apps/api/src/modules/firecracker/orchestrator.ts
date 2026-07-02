// SPDX-License-Identifier: Apache-2.0

/**
 * Firecracker orchestrator — one microVM per run.
 *
 * Topology (option "VM-per-run"): the isolation boundary IS the microVM.
 * The sidecar, the agent, and any per-integration MCP runners all execute
 * inside the same guest, separated by uid + in-guest nftables rules:
 *
 *   host                             guest (one Firecracker microVM)
 *   ────────────────────────────     ─────────────────────────────────
 *   platform API (:PORT)             /sbin/appstrate-init → supervisor
 *   ├─ TAP afc<n> 10.x.y.1/30  ←──── eth0 10.x.y.2/30
 *   ├─ lo alias 10.x.255.1     ←──── sink POSTs (uid-scoped allow)
 *   └─ nft table appstrate_fc        ├─ sidecar  (uid 1000, full egress)
 *      (guest↔host policy)           │   └─ integration runners (children)
 *                                    └─ agent    (uid 1001, lo + sink only)
 *
 * The agent reaches the sidecar over the guest loopback
 * (`http://127.0.0.1:8080`), so the sidecar's placeholder-substituting
 * LLM proxy, forward proxy and MCP surface work unchanged. The sidecar
 * spawns integrations with `INTEGRATION_RUNTIME_ADAPTER=process` — from
 * its in-guest perspective the world looks exactly like process mode,
 * while the HOST keeps a hardware virtualization boundary around the
 * whole run.
 *
 * Requirements (checked at initialize): Linux, /dev/kvm, the firecracker
 * binary, and the kernel/rootfs artifacts produced by
 * `apps/api/src/modules/firecracker/scripts/` (see docs/architecture/FIRECRACKER.md).
 *
 * Config delivery: the per-run launch spec (sidecar env + agent env,
 * including credentials) travels on a read-only ext4 "config drive"
 * attached as the VM's second block device — never on the kernel
 * command line, never through MMDS (size limits). The drive file lives
 * under FIRECRACKER_DATA_DIR (mode 0600) for the lifetime of the run;
 * point that directory at a tmpfs to keep secrets off persistent disk.
 */

import {
  access,
  mkdir,
  mkdtemp,
  rm,
  readdir,
  open as fsOpen,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { getEnv } from "@appstrate/env";
import { getFirecrackerEnv } from "./env.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { pickOperatorSidecarEnv } from "@appstrate/runner-pi";
import type {
  RunOrchestrator,
  WorkloadHandle,
  WorkloadSpec,
  IsolationBoundary,
  SidecarLaunchSpec,
  CleanupReport,
  StopResult,
} from "@appstrate/core/platform-types";
import { logger } from "../../lib/logger.ts";
import { buildBaseSidecarEnv } from "../../services/orchestrator/sidecar-env.ts";
import {
  drainStream,
  spawnCollect,
  tailFileLines,
} from "../../services/orchestrator/subprocess-util.ts";
import { SubnetAllocator, platformAliasIp, type RunSubnet } from "./subnet.ts";
import {
  createHostExec,
  createTap,
  deleteTap,
  listTapDevices,
  setupHostNetwork,
  teardownHostNetwork,
  type HostExec,
} from "./host-net.ts";
import {
  buildGuestConfig,
  buildKernelBootArgs,
  buildVmConfig,
  parseExitMarker,
  vmSizing,
} from "./vm-config.ts";

/** How much console tail to scan for the exit marker (bytes). */
const EXIT_MARKER_SCAN_BYTES = 64 * 1024;
/** How often the per-VM watchdog stats the console log (ms). */
const CONSOLE_WATCH_INTERVAL_MS = 10_000;
/**
 * Minimum firecracker binary version. 1.16 is what the docs require, and
 * anything below 1.15.1 is exposed to CVE-2026-5747 (virtio-pci OOB
 * write, guest-root → potential host code execution) — enforce the floor
 * instead of merely documenting it.
 */
const MIN_FIRECRACKER = { major: 1, minor: 16 };

type BunProcess = ReturnType<typeof Bun.spawn>;

interface VmRecord {
  runId: string;
  subnet: RunSubnet;
  runDir: string;
  consolePath: string;
  apiSocketPath: string;
  proc: BunProcess | null;
  /** Set once stopWorkload initiated a teardown — suppresses crash logs. */
  stopping: boolean;
  /** Console-size watchdog (FIRECRACKER_MAX_CONSOLE_BYTES enforcement). */
  consoleWatch?: ReturnType<typeof setInterval>;
  /**
   * Per-run exit-marker nonce (set by startWorkload). Only console markers
   * carrying it are trusted by waitForExit — see GuestConfig.exit_marker_nonce.
   */
  exitNonce?: string;
}

/** Per-run state persisted for the boot-time orphan sweep. */
interface RunStateFile {
  runId: string;
  tapDevice: string;
  pid?: number;
  /** VMM API socket path — pid-identity anchor for the orphan sweep. */
  apiSocketPath?: string;
}

export interface FirecrackerOrchestratorDeps {
  /** Privileged host-command executor (ip/nft/sysctl). Injectable for tests. */
  hostExec?: HostExec;
  /**
   * Agent command override forwarded into the guest config — used ONLY by
   * the dev smoke harness (apps/api/src/modules/firecracker/scripts/dev/smoke.ts) to validate
   * the boot machinery without a live platform. Never set in production.
   */
  agentArgvOverride?: string[];
}

export class FirecrackerOrchestrator implements RunOrchestrator {
  private readonly hostExec: HostExec;
  private readonly allocator: SubnetAllocator;
  private readonly vms = new Map<string, VmRecord>();
  /** Sidecar env captured by createSidecar, consumed by startWorkload(agent). */
  private readonly pendingSidecarEnv = new Map<string, Record<string, string>>();
  /** Agent spec captured by createWorkload, consumed by startWorkload(agent). */
  private readonly pendingAgentSpecs = new Map<string, WorkloadSpec>();

  private readonly agentArgvOverride: string[] | undefined;

  /**
   * Per-instance 0700 directory holding the VMM API sockets (see
   * createIsolationBoundary). Created lazily; promise-cached so two
   * concurrent boundary creations never mkdtemp twice.
   */
  private socketDirPromise: Promise<string> | null = null;

  /** Host-lock pidfile path once acquired (see acquireHostLock). */
  private hostLockPath: string | null = null;

  /**
   * Fail-closed gate: boot's parallel init swallows initialize() errors so
   * one broken backend can't block the API, but a run must NEVER start
   * without the host firewall — createIsolationBoundary refuses instead.
   */
  private initialized = false;

  constructor(deps: FirecrackerOrchestratorDeps = {}) {
    this.hostExec = deps.hostExec ?? createHostExec();
    this.agentArgvOverride = deps.agentArgvOverride;
    this.allocator = new SubnetAllocator(getFirecrackerEnv().FIRECRACKER_SUBNET_CIDR);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async initialize(): Promise<void> {
    const env = getEnv();
    const fcEnv = getFirecrackerEnv();
    if (process.platform !== "linux") {
      throw new Error(
        "RUN_ADAPTER=firecracker requires a Linux host with KVM. " +
          "On macOS, develop inside the Lima VM (bun run test:firecracker / apps/api/src/modules/firecracker/scripts/dev/).",
      );
    }
    const missing: string[] = [];
    // access(), not Bun.file().exists(): /dev/kvm is a character device
    // (exists() is false for non-regular files) and R|W also validates
    // that this uid may actually open it (kvm group membership).
    await access("/dev/kvm", fsConstants.R_OK | fsConstants.W_OK).catch(() => {
      missing.push("/dev/kvm (KVM not available or not accessible)");
    });
    if (!(await Bun.file(fcEnv.FIRECRACKER_KERNEL_PATH).exists())) {
      missing.push(`kernel at ${fcEnv.FIRECRACKER_KERNEL_PATH}`);
    }
    if (!(await Bun.file(fcEnv.FIRECRACKER_ROOTFS_PATH).exists())) {
      missing.push(`rootfs at ${fcEnv.FIRECRACKER_ROOTFS_PATH}`);
    }
    if (missing.length > 0) {
      throw new Error(
        `Firecracker orchestrator prerequisites missing: ${missing.join("; ")}. ` +
          `Build the artifacts with \`bun run firecracker:build\` (see docs/architecture/FIRECRACKER.md).`,
      );
    }
    // Fails loudly here (not at first run) when the binary is absent.
    const version =
      (await this.execLocal([fcEnv.FIRECRACKER_BIN, "--version"])).split("\n")[0] ?? "";
    const versionMatch = /v?(\d+)\.(\d+)/.exec(version);
    const major = versionMatch ? Number(versionMatch[1]) : 0;
    const minor = versionMatch ? Number(versionMatch[2]) : 0;
    if (
      major < MIN_FIRECRACKER.major ||
      (major === MIN_FIRECRACKER.major && minor < MIN_FIRECRACKER.minor)
    ) {
      throw new Error(
        `Firecracker >= ${MIN_FIRECRACKER.major}.${MIN_FIRECRACKER.minor} required ` +
          `(older releases are exposed to CVE-2026-5747) — "${fcEnv.FIRECRACKER_BIN} --version" ` +
          `reported: ${version || "(empty)"}`,
      );
    }

    await mkdir(resolve(fcEnv.FIRECRACKER_DATA_DIR), { recursive: true, mode: 0o700 });
    await this.acquireHostLock(resolve(fcEnv.FIRECRACKER_DATA_DIR));
    await setupHostNetwork(this.hostExec, {
      subnetCidr: fcEnv.FIRECRACKER_SUBNET_CIDR,
      aliasIp: platformAliasIp(fcEnv.FIRECRACKER_SUBNET_CIDR),
      platformPort: env.PORT,
      egressDenyCidrs: fcEnv.FIRECRACKER_EGRESS_DENY_CIDRS.split(",").filter(Boolean),
    });
    this.initialized = true;
    logger.info("Firecracker orchestrator initialized", {
      version,
      kernel: fcEnv.FIRECRACKER_KERNEL_PATH,
      rootfs: fcEnv.FIRECRACKER_ROOTFS_PATH,
      subnetCidr: fcEnv.FIRECRACKER_SUBNET_CIDR,
    });
  }

  async shutdown(): Promise<void> {
    // Full per-run teardown (VM, TAP, sockets, run dirs) BEFORE removing
    // the host firewall — a VM must never outlive the policy table.
    const records = [...this.vms.values()];
    await Promise.all(records.map((vm) => this.destroyVm(vm, 5)));
    this.vms.clear();
    this.pendingSidecarEnv.clear();
    this.pendingAgentSpecs.clear();
    await teardownHostNetwork(this.hostExec);
    if (this.socketDirPromise) {
      const socketDir = await this.socketDirPromise.catch(() => null);
      if (socketDir) await rm(socketDir, { recursive: true, force: true }).catch(() => {});
      this.socketDirPromise = null;
    }
    if (this.hostLockPath) {
      await rm(this.hostLockPath, { force: true }).catch(() => {});
      this.hostLockPath = null;
    }
  }

  async ensureImages(_images: string[]): Promise<void> {
    // No container images — the kernel/rootfs artifacts are validated once
    // at initialize().
  }

  async cleanupOrphans(): Promise<CleanupReport> {
    const fcEnv = getFirecrackerEnv();
    const dataDir = resolve(fcEnv.FIRECRACKER_DATA_DIR);
    let workloads = 0;
    let isolationBoundaries = 0;

    let entries: string[];
    try {
      // Only run directories: the data dir also holds the host-lock
      // pidfile (orchestrator.pid), which must survive the sweep.
      const dirents = await readdir(dataDir, { withFileTypes: true });
      entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      const dir = join(dataDir, name);
      const state = await this.readStateFile(dir);
      if (state?.pid && state.pid > 0) {
        // A recorded pid may have been recycled by an unrelated process
        // since the crash — only kill it if /proc still shows a
        // firecracker VMM bound to THIS run's API socket.
        if (await this.pidIsOurVmm(state.pid, state.apiSocketPath)) {
          try {
            process.kill(state.pid, "SIGKILL");
            workloads++;
          } catch {
            // Already dead.
          }
        } else {
          logger.warn("Orphan sweep: pid is not this run's firecracker VMM — skipping kill", {
            runId: state.runId,
            pid: state.pid,
          });
        }
      }
      if (state?.tapDevice) {
        await deleteTap(this.hostExec, state.tapDevice).catch(() => {});
      }
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      isolationBoundaries++;
    }

    // Sweep TAP devices with no backing run dir (crash between TAP create
    // and state write). The platform owns the `afc<n>` namespace.
    try {
      for (const tap of await listTapDevices(this.hostExec)) {
        await deleteTap(this.hostExec, tap).catch(() => {});
      }
    } catch (err) {
      logger.warn("Firecracker orphan TAP sweep failed", { error: getErrorMessage(err) });
    }

    return { workloads, isolationBoundaries, workspaces: 0 };
  }

  // -------------------------------------------------------------------------
  // Boundary
  // -------------------------------------------------------------------------

  async createIsolationBoundary(runId: string): Promise<IsolationBoundary> {
    if (!this.initialized) {
      throw new Error(
        "Firecracker orchestrator is not initialized (host firewall setup failed or " +
          "never ran) — refusing to start a run without host↔guest isolation. " +
          "Check the boot logs for the initialize() failure.",
      );
    }
    const fcEnv = getFirecrackerEnv();
    // Admission control BEFORE any allocation: overcommitting host RAM
    // with unbounded concurrent VMs is worse than failing the run fast.
    const maxVms = fcEnv.FIRECRACKER_MAX_CONCURRENT_VMS;
    if (maxVms > 0 && this.vms.size >= maxVms) {
      throw new Error(
        `Firecracker orchestrator at capacity: ${this.vms.size}/${maxVms} concurrent ` +
          `microVMs (FIRECRACKER_MAX_CONCURRENT_VMS) — refusing to start run ${runId}`,
      );
    }
    const socketDir = await this.ensureSocketDir();
    const runDir = join(resolve(fcEnv.FIRECRACKER_DATA_DIR), runId);
    await mkdir(runDir, { recursive: true, mode: 0o700 });

    const subnet = this.allocator.allocate();
    try {
      await createTap(this.hostExec, subnet);
    } catch (err) {
      this.allocator.release(subnet.index);
      await rm(runDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    await this.writeStateFile(runDir, { runId, tapDevice: subnet.tapDevice });

    const aliasIp = platformAliasIp(fcEnv.FIRECRACKER_SUBNET_CIDR);
    this.vms.set(runId, {
      runId,
      subnet,
      runDir,
      consolePath: join(runDir, "console.log"),
      // NOT under runDir: AF_UNIX paths are capped at ~108 bytes (SUN_LEN)
      // and FIRECRACKER_DATA_DIR/<runId>/ routinely exceeds it — Firecracker
      // then dies at startup with FailedToBindAndRunHttpServer. A short
      // per-instance mkdtemp 0700 directory under tmpdir stays well under
      // the cap AND keeps the sockets out of the world-writable flat /tmp
      // (unix-socket connect permission is umask-dependent there). The
      // subnet index is unique among this orchestrator's live runs.
      apiSocketPath: join(socketDir, `afc-${subnet.index}.sock`),
      proc: null,
      stopping: false,
    });

    return {
      id: runDir,
      name: `firecracker-${runId}`,
      // In-guest path: the sidecar and integration runners live in the
      // same VM as the agent, so from every consumer's perspective the
      // workspace is a plain directory.
      workspace: { kind: "directory", path: "/workspace" },
      sidecarEndpoints: {
        sidecarUrl: "http://127.0.0.1:8080",
        llmProxyUrl: "http://127.0.0.1:8080/llm",
        forwardProxyUrl: "http://127.0.0.1:8081",
        // The platform alias must bypass the forward proxy — sink POSTs
        // go straight out eth0 (uid-scoped allow in the guest firewall).
        noProxy: `localhost,127.0.0.1,${aliasIp}`,
      },
    };
  }

  async removeIsolationBoundary(boundary: IsolationBoundary): Promise<void> {
    const runId = boundary.name.replace(/^firecracker-/, "");
    const vm = this.vms.get(runId);
    if (vm) {
      await this.destroyVm(vm, 0);
    }
    this.pendingSidecarEnv.delete(runId);
    this.pendingAgentSpecs.delete(runId);
    await rm(boundary.id, { recursive: true, force: true }).catch(() => {});
  }

  /** Tear down one run's VM + network + on-disk state. Idempotent, best-effort. */
  private async destroyVm(vm: VmRecord, graceSeconds: number): Promise<void> {
    if (vm.consoleWatch) clearInterval(vm.consoleWatch);
    await this.killVm(vm, graceSeconds).catch(() => {});
    try {
      await deleteTap(this.hostExec, vm.subnet.tapDevice);
      // Only a confirmed delete frees the index — releasing it while the
      // device lingers would poison the next run that draws the same index
      // (its `ip tuntap add` fails on the existing device). A stuck index
      // is reclaimed by the boot-time orphan sweep.
      this.allocator.release(vm.subnet.index);
    } catch (err) {
      logger.warn("Failed to delete TAP device — keeping its subnet index reserved", {
        runId: vm.runId,
        tap: vm.subnet.tapDevice,
        error: getErrorMessage(err),
      });
    }
    await rm(vm.apiSocketPath, { force: true }).catch(() => {});
    await rm(vm.runDir, { recursive: true, force: true }).catch(() => {});
    this.vms.delete(vm.runId);
  }

  // -------------------------------------------------------------------------
  // Workloads
  // -------------------------------------------------------------------------

  async createSidecar(
    runId: string,
    boundary: IsolationBoundary,
    spec: SidecarLaunchSpec,
  ): Promise<WorkloadHandle> {
    const sidecarEnv = buildBaseSidecarEnv({
      spec,
      baseEnv: pickOperatorSidecarEnv(),
      port: "8080",
      runId,
      platformApiUrl: await this.resolvePlatformApiUrl(),
      workspace: boundary.workspace,
    });
    // The sidecar runs INSIDE the guest — its integration runners are
    // guest subprocesses, exactly the process-adapter contract.
    sidecarEnv.INTEGRATION_RUNTIME_ADAPTER = "process";
    this.pendingSidecarEnv.set(runId, sidecarEnv);
    // The sidecar process starts with the VM (startWorkload on the agent
    // boots the guest; the supervisor launches sidecar then agent). The
    // parallel-boot contract holds: the agent's MCP handshake retries
    // until the in-guest sidecar listener is up.
    return { id: `fc-${runId}-sidecar`, runId, role: "sidecar" };
  }

  async createWorkload(spec: WorkloadSpec, _boundary: IsolationBoundary): Promise<WorkloadHandle> {
    this.pendingAgentSpecs.set(spec.runId, spec);
    return { id: `fc-${spec.runId}-${spec.role}`, runId: spec.runId, role: spec.role };
  }

  async startWorkload(handle: WorkloadHandle): Promise<void> {
    // The VM hosts every role; it boots exactly once, when the agent —
    // the workload pi.ts drives the lifecycle through — is started.
    if (handle.role !== "agent") return;

    const env = getEnv();
    const fcEnv = getFirecrackerEnv();
    const vm = this.vms.get(handle.runId);
    const agentSpec = this.pendingAgentSpecs.get(handle.runId);
    if (!vm || !agentSpec) {
      throw new Error(
        `Firecracker orchestrator: no boundary/agent spec for run ${handle.runId} — ` +
          `createIsolationBoundary + createWorkload must run before startWorkload`,
      );
    }

    vm.exitNonce = randomBytes(16).toString("hex");
    const aliasIp = platformAliasIp(fcEnv.FIRECRACKER_SUBNET_CIDR);
    // skipSidecar runs never called createSidecar — no pending env entry.
    const sidecarEnv = this.pendingSidecarEnv.get(handle.runId);
    const guestConfig = buildGuestConfig({
      runId: handle.runId,
      exitMarkerNonce: vm.exitNonce,
      platformIp: aliasIp,
      platformPort: env.PORT,
      sidecarEnv,
      agentEnv: agentSpec.env,
      agentUnrestrictedEgress: agentSpec.egress === true,
      ...(this.agentArgvOverride ? { agentArgv: this.agentArgvOverride } : {}),
    });
    // The guest config now owns the credentials — drop them from the API
    // heap immediately instead of letting them linger until removeWorkload.
    this.pendingSidecarEnv.delete(handle.runId);
    this.pendingAgentSpecs.delete(handle.runId);

    const configDrivePath = join(vm.runDir, "config.img");
    await this.buildConfigDrive(vm.runDir, configDrivePath, guestConfig);

    const sizing = vmSizing(agentSpec.resources, sidecarEnv !== undefined);
    const vmConfig = buildVmConfig({
      kernelPath: resolve(fcEnv.FIRECRACKER_KERNEL_PATH),
      rootfsPath: resolve(fcEnv.FIRECRACKER_ROOTFS_PATH),
      configDrivePath,
      bootArgs: buildKernelBootArgs(vm.subnet),
      subnet: vm.subnet,
      vcpuCount: sizing.vcpuCount,
      memSizeMib: sizing.memSizeMib,
    });
    const vmConfigPath = join(vm.runDir, "vmconfig.json");
    await writeFile(vmConfigPath, JSON.stringify(vmConfig, null, 2), { mode: 0o600 });

    // Firecracker refuses to bind over an existing socket file (stale from
    // a crashed predecessor that shared the pid+index pair).
    await rm(vm.apiSocketPath, { force: true }).catch(() => {});
    const proc = Bun.spawn(
      [fcEnv.FIRECRACKER_BIN, "--api-sock", vm.apiSocketPath, "--config-file", vmConfigPath],
      {
        cwd: vm.runDir,
        // Serial console (guest kernel + supervisor + workload stdout)
        // lands in one append-only file; streamLogs tails it.
        stdout: Bun.file(vm.consolePath),
        stderr: "pipe",
      },
    );
    vm.proc = proc;
    drainStream(proc, `fc:${handle.runId}`);
    // Mandatory (unlike the pre-spawn pid-less write): without the pid on
    // disk, a platform crash leaves a VMM the boot sweep cannot kill. A
    // VMM we cannot account for must not run — kill it and fail the run.
    try {
      await this.writeStateFileStrict(vm.runDir, {
        runId: handle.runId,
        tapDevice: vm.subnet.tapDevice,
        pid: proc.pid,
        apiSocketPath: vm.apiSocketPath,
      });
    } catch (err) {
      vm.stopping = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already dead.
      }
      await proc.exited.catch(() => {});
      vm.proc = null;
      throw new Error(
        `Firecracker orchestrator: failed to persist the VMM pid for run ${handle.runId} — ` +
          `killed the VMM rather than leave it unsweepable: ${getErrorMessage(err)}`,
      );
    }

    this.startConsoleWatch(vm, fcEnv.FIRECRACKER_MAX_CONSOLE_BYTES);
    proc.exited.then((code) => {
      if (vm.consoleWatch) clearInterval(vm.consoleWatch);
      if (code !== 0 && !vm.stopping) {
        logger.error("Firecracker VMM exited non-zero", {
          runId: handle.runId,
          exitCode: code,
        });
      }
    });

    logger.info("Firecracker microVM booted", {
      runId: handle.runId,
      pid: proc.pid,
      tap: vm.subnet.tapDevice,
      guestIp: vm.subnet.guestIp,
      vcpus: sizing.vcpuCount,
      memMib: sizing.memSizeMib,
    });
  }

  async stopWorkload(handle: WorkloadHandle, timeoutSeconds = 5): Promise<void> {
    const vm = this.vms.get(handle.runId);
    if (!vm?.proc) return;
    vm.stopping = true;
    await this.killVm(vm, timeoutSeconds);
  }

  async removeWorkload(handle: WorkloadHandle): Promise<void> {
    // Both roles share the VM. The first remove kills it; the boundary
    // teardown reclaims TAP/dir. Pending specs are dropped per-role so a
    // re-created workload can't accidentally reuse stale env.
    const vm = this.vms.get(handle.runId);
    if (vm?.proc) {
      vm.stopping = true;
      await this.killVm(vm, 0).catch(() => {});
    }
    if (handle.role === "sidecar") this.pendingSidecarEnv.delete(handle.runId);
    else this.pendingAgentSpecs.delete(handle.runId);
  }

  async waitForExit(handle: WorkloadHandle): Promise<number> {
    const vm = this.vms.get(handle.runId);
    if (!vm?.proc) return 1;
    await vm.proc.exited;
    // The VMM exiting 0 only means the guest powered off — the workload
    // outcome is the supervisor's nonce-authenticated exit marker on the
    // serial console (the console is shared with workload stdout, so an
    // un-nonced marker is ignored as a potential forgery).
    const tail = await this.readConsoleTail(vm.consolePath);
    const marker = vm.exitNonce ? parseExitMarker(tail, vm.exitNonce) : null;
    if (marker === null) {
      // Killed (stop/cancel) or crashed before the supervisor could
      // report — non-zero so pi.ts treats it as a non-clean exit unless
      // its own timeout/cancel flags already explain it.
      return vm.stopping ? 137 : 1;
    }
    return marker;
  }

  async *streamLogs(handle: WorkloadHandle, signal?: AbortSignal): AsyncGenerator<string> {
    const vm = this.vms.get(handle.runId);
    if (!vm) return;

    let exited = vm.proc === null;
    vm.proc?.exited.then(() => {
      exited = true;
    });
    yield* tailFileLines(vm.consolePath, () => exited, signal);
  }

  async stopByRunId(runId: string, timeoutSeconds?: number): Promise<StopResult> {
    const vm = this.vms.get(runId);
    if (!vm) return "not_found";
    if (!vm.proc) return "already_stopped";
    vm.stopping = true;
    await this.killVm(vm, timeoutSeconds ?? 5);
    return "stopped";
  }

  async resolvePlatformApiUrl(): Promise<string> {
    const env = getEnv();
    const fcEnv = getFirecrackerEnv();
    return `http://${platformAliasIp(fcEnv.FIRECRACKER_SUBNET_CIDR)}:${env.PORT}`;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Attempt a graceful guest shutdown through the VMM API, then kill the
   * VMM process. SendCtrlAltDel is x86_64-only — on aarch64 the call
   * fails and we fall through to the kill, which is acceptable: by the
   * time stop is requested the run is already terminal platform-side.
   */
  private async killVm(vm: VmRecord, graceSeconds: number): Promise<void> {
    const proc = vm.proc;
    if (!proc) return;
    if (graceSeconds > 0) {
      try {
        await fetch("http://localhost/actions", {
          method: "PUT",
          // Bun extension — request over the VMM's unix API socket.
          unix: vm.apiSocketPath,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action_type: "SendCtrlAltDel" }),
          // A wedged VMM must never block cancel/shutdown — abort fast
          // and fall through to the SIGKILL below.
          signal: AbortSignal.timeout(1_000),
        });
      } catch {
        // aarch64 / wedged VMM / socket already gone — fall through to
        // the kill.
      }
      const exited = await Promise.race([
        proc.exited.then(() => true),
        new Promise<false>((r) => setTimeout(() => r(false), graceSeconds * 1000)),
      ]);
      if (exited) return;
    }
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already dead.
    }
    await proc.exited.catch(() => {});
  }

  /**
   * Materialise the guest config as a small read-only ext4 image
   * (`mkfs.ext4 -d`): no privileges needed, no size negotiation with
   * MMDS, and the secrets never touch the kernel command line.
   *
   * In-image ownership is forced to root:root with owner-only modes via
   * `debugfs` (unprivileged — it edits the image file, not a mount).
   * `mkfs -d` would otherwise preserve the staging files' owner = this
   * API process's uid, and if that uid collides with an in-guest workload
   * uid (1000/1001/1002) the workload could read the whole launch spec.
   * Belt-and-suspenders with the supervisor's unmount-before-workloads.
   */
  private async buildConfigDrive(
    runDir: string,
    imagePath: string,
    guestConfig: unknown,
  ): Promise<void> {
    const stagingDir = join(runDir, "config-drive");
    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(stagingDir, { recursive: true, mode: 0o700 });
    try {
      const payload = JSON.stringify(guestConfig);
      await writeFile(join(stagingDir, "config.json"), payload, { mode: 0o600 });

      // Payload + ext4 metadata headroom, floored at 1 MiB (mkfs minimum).
      // Byte length, not .length: the payload is written as UTF-8 and
      // JSON.stringify leaves non-ASCII unescaped — a mostly-multibyte
      // agent prompt would overflow a code-unit-sized image and fail mkfs.
      const sizeBytes = Math.max(1024 * 1024, Buffer.byteLength(payload) * 2 + 512 * 1024);
      await rm(imagePath, { force: true });
      // Sparse pre-allocation in-process — no `truncate` child spawn.
      const image = await fsOpen(imagePath, "w", 0o600);
      try {
        await image.truncate(sizeBytes);
      } finally {
        await image.close();
      }
      await this.execLocal(["mkfs.ext4", "-q", "-d", stagingDir, imagePath]);
      // One debugfs run for all six ownership/mode fixups (`-f -` reads
      // the command list from stdin; a failing command still yields a
      // non-zero exit) instead of six child spawns on the boot path.
      const debugfsScript =
        [
          "sif / uid 0",
          "sif / gid 0",
          "sif / mode 040500",
          "sif /config.json uid 0",
          "sif /config.json gid 0",
          "sif /config.json mode 0100400",
        ].join("\n") + "\n";
      await this.execLocal(["debugfs", "-w", "-f", "-", imagePath], debugfsScript);
    } finally {
      // The staging dir holds the plaintext launch spec (credentials) —
      // it must not survive a mkfs/debugfs failure.
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Unprivileged local command (mkfs/debugfs/firecracker --version). */
  private async execLocal(cmd: string[], stdin?: string): Promise<string> {
    const { exitCode, stdout, stderr } = await spawnCollect(cmd, { stdin });
    if (exitCode !== 0) {
      throw new Error(`Command failed (${exitCode}): ${cmd.join(" ")} — ${stderr.trim()}`);
    }
    return stdout;
  }

  /**
   * PID-reuse guard for the orphan sweep: `true` only when /proc shows a
   * live process whose argv looks like a firecracker VMM AND (when the
   * state file recorded one) references this run's API socket.
   */
  private async pidIsOurVmm(pid: number, apiSocketPath?: string): Promise<boolean> {
    let cmdline: string;
    try {
      cmdline = await Bun.file(`/proc/${pid}/cmdline`).text();
    } catch {
      return false; // Process already gone.
    }
    const argv = cmdline.split("\0");
    if (!argv.some((arg) => arg.includes("firecracker"))) return false;
    return apiSocketPath === undefined || argv.includes(apiSocketPath);
  }

  private async readConsoleTail(consolePath: string): Promise<string> {
    try {
      const file = Bun.file(consolePath);
      const size = file.size;
      const from = Math.max(0, size - EXIT_MARKER_SCAN_BYTES);
      return await file.slice(from, size).text();
    } catch {
      return "";
    }
  }

  /** Best-effort variant — for the pre-spawn (pid-less) write only. */
  private async writeStateFile(runDir: string, state: RunStateFile): Promise<void> {
    try {
      await this.writeStateFileStrict(runDir, state);
    } catch (err) {
      logger.warn("Failed to write firecracker run state file", {
        runId: state.runId,
        error: getErrorMessage(err),
      });
    }
  }

  /** Throwing variant — the post-spawn pid write must not be lost. */
  private async writeStateFileStrict(runDir: string, state: RunStateFile): Promise<void> {
    await writeFile(join(runDir, "state.json"), JSON.stringify(state), { mode: 0o600 });
  }

  /** Lazily create the per-instance 0700 API-socket directory. */
  private ensureSocketDir(): Promise<string> {
    // mkdtemp creates the directory 0700 — only this uid may traverse it.
    // A rejection must not stay cached (it would permanently fail every
    // future run over one transient tmpdir hiccup) — clear and rethrow so
    // the next boundary retries.
    this.socketDirPromise ??= mkdtemp(join(tmpdir(), "afc-")).catch((err: unknown) => {
      this.socketDirPromise = null;
      throw err;
    });
    return this.socketDirPromise;
  }

  /**
   * Single-orchestrator-per-host guard: two API processes on one host
   * would mutually sweep each other's live TAP devices (cleanupOrphans
   * reclaims every `afc*`) and collide on subnet indexes. Advisory
   * pidfile (O_EXCL create, stale-pid takeover) — not flock, but good
   * enough for the two-instance foot-gun it exists to catch.
   */
  private async acquireHostLock(dataDir: string): Promise<void> {
    const lockPath = join(dataDir, "orchestrator.pid");
    try {
      await writeFile(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const raw = await Bun.file(lockPath)
        .text()
        .catch(() => "");
      const existingPid = Number.parseInt(raw.trim(), 10);
      if (Number.isInteger(existingPid) && existingPid > 0 && existingPid !== process.pid) {
        if (this.pidAlive(existingPid)) {
          throw new Error(
            `another Firecracker orchestrator (pid ${existingPid}) owns this host — ` +
              `two instances would sweep each other's TAP devices and collide on subnets`,
          );
        }
      }
      // Stale lock from a crashed predecessor — take over.
      await writeFile(lockPath, String(process.pid), { mode: 0o600 });
    }
    this.hostLockPath = lockPath;
  }

  private pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM = alive but owned by another uid — still counts as alive.
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  /**
   * Console-size watchdog: the serial console appends unbounded (kernel +
   * supervisor + full workload stdout) — past the cap, the VM is killed
   * and the run fails with the killed semantics.
   */
  private startConsoleWatch(vm: VmRecord, maxBytes: number): void {
    const timer = setInterval(() => {
      void (async () => {
        let size: number;
        try {
          size = (await stat(vm.consolePath)).size;
        } catch {
          return; // Console not created yet / already reclaimed.
        }
        if (size <= maxBytes) return;
        clearInterval(timer);
        logger.error(
          "Firecracker console log exceeded FIRECRACKER_MAX_CONSOLE_BYTES — killing VM",
          {
            runId: vm.runId,
            size,
            maxBytes,
          },
        );
        vm.stopping = true;
        await this.killVm(vm, 0).catch(() => {});
      })();
    }, CONSOLE_WATCH_INTERVAL_MS);
    vm.consoleWatch = timer;
  }

  private async readStateFile(runDir: string): Promise<RunStateFile | null> {
    try {
      const raw: unknown = JSON.parse(await Bun.file(join(runDir, "state.json")).text());
      if (typeof raw !== "object" || raw === null) return null;
      const obj = raw as Record<string, unknown>;
      if (typeof obj.runId !== "string" || typeof obj.tapDevice !== "string") return null;
      return {
        runId: obj.runId,
        tapDevice: obj.tapDevice,
        ...(typeof obj.pid === "number" ? { pid: obj.pid } : {}),
        ...(typeof obj.apiSocketPath === "string" ? { apiSocketPath: obj.apiSocketPath } : {}),
      };
    } catch {
      return null;
    }
  }
}
