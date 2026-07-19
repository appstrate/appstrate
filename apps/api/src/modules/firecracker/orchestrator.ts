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
 * binary, the kernel/rootfs artifacts produced by
 * `apps/api/src/modules/firecracker/scripts/` (see docs/architecture/FIRECRACKER.md),
 * and — with FIRECRACKER_JAILER=on, the production default — root plus
 * the upstream `jailer` binary (same release as firecracker). Each VMM
 * then runs chrooted under an unprivileged per-VM uid with cgroup
 * bounds (see jail.ts); FIRECRACKER_JAILER=off is the unprivileged dev
 * escape hatch (direct spawn, loudly warned).
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
  chmod,
  chown,
  mkdir,
  readlink,
  rm,
  rmdir,
  readdir,
  open as fsOpen,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { getFirecrackerEnv, jailUidRange } from "./runner/host-env.ts";
import { parsePlatformApiUrl } from "./runner/platform-url.ts";
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
  ExecutionRequirements,
  IsolationBoundaryOptions,
} from "@appstrate/core/platform-types";
import { logger } from "./runner/logger.ts";
import { buildBaseSidecarEnv } from "../../services/orchestrator/sidecar-env.ts";
import {
  getBrowserResourceProfile,
  MAX_BROWSER_INSTANCES_PER_RUN,
} from "../../services/browser-execution-profiles.ts";
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
import {
  mmdsPayloadBytes,
  splitCredentials,
  MMDS_SAFETY_MARGIN_BYTES,
  MMDS_STORE_LIMIT_BYTES,
  type MmdsPayload,
} from "./credential-split.ts";
import { BoundaryExistsError, RUN_ID_RE } from "./runner/protocol.ts";
import {
  assertJailerVersionParity,
  buildJailerArgv,
  computeJailPaths,
  defaultJailFs,
  fcExecName,
  jailChrootBase,
  placeChrootSecret,
  prepareChrootArtifacts,
  removeJailDir,
  writeChrootVmConfig,
  CHROOT_CONFIG_DRIVE_PATH,
  CHROOT_KERNEL_PATH,
  CHROOT_ROOTFS_PATH,
  JAIL_MEMORY_SLACK_MIB,
  JAIL_PARENT_CGROUP,
  JAIL_PIDS_MAX,
  type JailFs,
  type JailPaths,
} from "./jail.ts";
import type { FirecrackerEnv } from "./runner/host-env.ts";

/** How much console tail to scan for the exit marker (bytes). */
const EXIT_MARKER_SCAN_BYTES = 64 * 1024;
/** How often the per-VM watchdog stats the console log (ms). */
const CONSOLE_WATCH_INTERVAL_MS = 10_000;
/**
 * Console tail retained at teardown (phase 4). The run workspace — and
 * with it `console.log` — is deleted when the VM is torn down; the last
 * slice is copied to the archive first so a failed run stays debuggable.
 */
const CONSOLE_ARCHIVE_BYTES = 256 * 1024;
/** Console upper bound the {@link readConsole} endpoint will ever serve. */
const CONSOLE_MAX_TAIL_BYTES = 256 * 1024;
/** Most recent archived consoles kept — older ones are pruned at teardown. */
const CONSOLE_ARCHIVE_MAX_FILES = 100;

/** How often the exit reaper sweeps {@link FirecrackerOrchestrator.vms} (ms). */
const EXIT_REAPER_INTERVAL_MS = 60_000;
/**
 * Attempts for transiently-failing teardown host ops (TAP delete, cgroup
 * rmdir). Kept small: the only legitimate transient is the kernel still
 * releasing a just-killed VMM's resources, which clears in milliseconds —
 * anything that survives the retries is left for the boot sweep.
 */
const CLEANUP_RETRY_ATTEMPTS = 3;

/** ENOENT narrowing for teardown paths — "already gone" is done, not a retry. */
function isMissingFsEntry(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}
/**
 * How long an exited VMM's record may linger before the reaper reclaims
 * it. Generous on purpose: a healthy platform claims the exit within
 * seconds (waitForExit long-poll), so anything past this is a platform
 * that died mid-run — never a live waiter. The same bound covers a
 * boundary that never got a VMM at all (age from record creation): a
 * healthy platform calls startWorkload within seconds of the create, so
 * anything past this is a platform that died between the two — or a
 * captured-bearer replay minting boundaries it will never boot.
 */
const EXIT_REAP_AFTER_MS = 5 * 60_000;

/**
 * Why a workload's microVM + workspace were destroyed, logged on every
 * teardown so there is never a silent path from "booted" to "gone".
 * Derived from the actual call paths:
 *   - `finalize`      — the run ended and pi.ts removed the boundary
 *   - `watchdog-kill` — the platform asked the daemon to stop the run by
 *                       id (stall watchdog / user cancel share this path)
 *   - `orphan-sweep`  — boot-time reclamation of a crashed predecessor
 *   - `shutdown`      — the daemon itself is stopping
 *   - `crash`         — the VMM exited abnormally without an intentional stop
 *   - `reaper`        — the VMM exited (or the boundary never got a VMM
 *                       at all) but the run was never finalized by any
 *                       platform (the platform died mid-run); the
 *                       periodic exit reaper reclaims the record and its
 *                       FIRECRACKER_MAX_CONCURRENT_VMS slot
 *   - `max-lifetime`  — the guest outlived the spec's hard host-side
 *                       lifetime ceiling (WorkloadSpec.maxLifetimeSeconds)
 *                       — the last-resort kill for a platform↔daemon
 *                       partition where the platform's own timeout can no
 *                       longer reach the workload
 */
export type TeardownReason =
  "finalize" | "watchdog-kill" | "orphan-sweep" | "shutdown" | "crash" | "reaper" | "max-lifetime";
/**
 * Minimum firecracker binary version. 1.16 is what the docs require, and
 * anything below 1.15.1 is exposed to CVE-2026-5747 (virtio-pci OOB
 * write, guest-root → potential host code execution) — enforce the floor
 * instead of merely documenting it. The floor also covers CVE-2026-1386
 * (jailer symlink following → arbitrary host file overwrite, fixed
 * upstream in 1.13.2 / 1.14.1) — any ≥1.16 release contains that fix.
 */
const MIN_FIRECRACKER = { major: 1, minor: 16 };

/**
 * Platform HTTP port paired with the host lo alias — the port guests
 * reach the platform endpoint on when no `platformApiUrl` is supplied.
 * The daemon always supplies one, so this path only serves the dev smoke
 * harness (scripts/dev/smoke.ts binds its platform stub on the lo alias
 * at this port). Read straight from the environment (default 3000) so
 * this class — the daemon's engine and the smoke harness's driver —
 * never pulls the full platform env schema (`@appstrate/env`).
 */
function loAliasPlatformPort(): number {
  return Number(process.env.PORT ?? 3000);
}

type BunProcess = ReturnType<typeof Bun.spawn>;

/**
 * Overwrite the MMDS payload's secret values in place after a successful
 * PUT — the store now lives in the VMM, so the API process should not keep
 * a copy on its heap any longer than necessary.
 */
function scrubMmdsPayload(payload: MmdsPayload): void {
  for (const key of Object.keys(payload.sidecar_env)) payload.sidecar_env[key] = "";
  for (const key of Object.keys(payload.agent_env)) payload.agent_env[key] = "";
}

interface VmRecord {
  runId: string;
  subnet: RunSubnet;
  runDir: string;
  consolePath: string;
  apiSocketPath: string;
  proc: BunProcess | null;
  /** Capability resources admitted before the VM exists and consumed at boot. */
  requirements?: ExecutionRequirements;
  /** Set once stopWorkload initiated a teardown — suppresses crash logs. */
  stopping: boolean;
  /**
   * `Date.now()` at boundary creation. Reaper anchor for a record whose
   * VMM never spawned (`proc: null` — platform crash between create and
   * startWorkload, or a replayed create that nobody boots): with no
   * process there is never an `exitedAt`, so age from creation is the
   * only signal that the boundary is abandoned.
   */
  createdAt: number;
  /** Console-size watchdog (FIRECRACKER_MAX_CONSOLE_BYTES enforcement). */
  consoleWatch?: ReturnType<typeof setInterval>;
  /**
   * Per-run exit-marker nonce (set by startWorkload). Only console markers
   * carrying it are trusted by waitForExit — see GuestConfig.exit_marker_nonce.
   */
  exitNonce?: string;
  /** `Date.now()` at VMM spawn — teardown uptime + liveness uptime. */
  bootedAt?: number;
  /**
   * `Date.now()` at VMM exit (stamped by startWorkload's exit handler).
   * The exit reaper destroys records that carry this past
   * {@link EXIT_REAP_AFTER_MS} — a live platform claims the exit within
   * seconds (waitForExit), so a lingering stamp means the platform died
   * mid-run and nobody will ever call removeIsolationBoundary.
   */
  exitedAt?: number;
  /**
   * Hard host-side lifetime ceiling (WorkloadSpec.maxLifetimeSeconds) —
   * armed at spawn, cleared by destroyVm. Fires only when the platform's
   * own timeout could not reach the workload (platform death/partition).
   */
  lifetimeTimer?: ReturnType<typeof setTimeout>;
  /**
   * Overrides the teardown reason a caller passes to destroyVm — stamped
   * by kill paths that know WHY the VM is going away (watchdog stop,
   * console-cap kill) before the generic cleanup runs.
   */
  teardownReason?: TeardownReason;
  /** Jailer confinement layout — set when FIRECRACKER_JAILER=on. */
  jail?: JailPaths;
  /**
   * Settles when {@link FirecrackerOrchestrator.killVm} abandons a
   * D-state VMM after the bounded post-SIGKILL reap. `proc.exited` never
   * resolves for such a process, so every waiter (waitForExit — the
   * promise pi.ts blocks a whole run on) must race against this signal
   * instead of hanging behind one wedged kernel ioctl.
   */
  reapAbandoned: Promise<void>;
  /** Resolver for {@link reapAbandoned}. */
  abandonReap: () => void;
  /**
   * The single in-flight teardown for this record (see
   * {@link FirecrackerOrchestrator.destroyVm}) — set on the first destroy
   * request, shared by every concurrent/subsequent one so the subnet
   * index, TAP device and `vms` entry are released exactly once.
   */
  teardown?: Promise<void>;
}

/** Per-run state persisted for the boot-time orphan sweep. */
interface RunStateFile {
  runId: string;
  tapDevice: string;
  pid?: number;
  /** VMM API socket path — pid-identity anchor for the orphan sweep. */
  apiSocketPath?: string;
  /**
   * Jailer fields (FIRECRACKER_JAILER=on). Inside the chroot every VMM
   * shares the SAME argv ("firecracker --api-sock /run/firecracker.socket
   * …"), so the argv-based identity above cannot discriminate jailed
   * runs — the sweep matches on the recorded chroot (/proc/<pid>/root)
   * or the reserved per-VM uid instead. Absent on state files written
   * by older daemons or with the jailer off (argv identity still used).
   */
  jailId?: string;
  jailUid?: number;
  chrootPath?: string;
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
  /**
   * Remote platform API URL (issue #819): the orchestrator runs inside
   * the appstrate-runner daemon on a KVM host while the platform API
   * lives elsewhere (e.g. a Docker container on the same machine). Must
   * be `http(s)://<IPv4>[:port]` — guests have no DNS resolver, so a
   * hostname would never resolve in-guest (validated fail-fast in the
   * constructor). When set: resolvePlatformApiUrl advertises it verbatim
   * (no lo-alias/PORT computation), the guest config targets its ip:port,
   * and the host firewall unconditionally accepts guest→ip:port (see
   * host-net.ts `platformForward`). The daemon always sets it; absent =
   * dev smoke-harness topology (scripts/dev/smoke.ts serves a platform
   * stub on the host lo alias), lo-alias delivery unchanged.
   */
  platformApiUrl?: string;
  /**
   * Chroot-prep filesystem ops (hardlink/chown/…). Injectable for unit
   * tests only — chown to an unallocated jail uid requires root.
   */
  jailFs?: JailFs;
  /**
   * Single MMDS PUT (credential broker) — writes the payload to the VMM's
   * in-memory data store over its unix API socket. Injectable so unit
   * tests can pin the broker contract (payload PUT'd, failure fail-closes
   * the run) without a live VMM. Production is {@link defaultMmdsPut}.
   */
  mmdsPut?: (apiSocketPath: string, payload: MmdsPayload) => Promise<void>;
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

  /** Verbatim deps.platformApiUrl — advertised to the sidecar as-is. */
  private readonly platformApiUrlOverride: string | undefined;
  /** Parsed override — the ip:port guests must always be allowed to reach. */
  private readonly platformForward: { ip: string; port: number } | undefined;

  /**
   * Deterministic per-data-dir 0700 directory holding the VMM API sockets
   * (see ensureSocketDir / socketRoot). Created lazily; promise-cached so
   * two concurrent boundary creations never race to mkdir it.
   */
  private socketDirPromise: Promise<string> | null = null;

  /**
   * runIds whose boundary allocation is currently in flight (added
   * synchronously before the first await of createIsolationBoundary,
   * removed in its finally). Together with {@link vms} this is the
   * one-boundary-per-runId guard: a duplicate/replayed create — including
   * one racing the original — is rejected atomically instead of
   * allocating a second TAP + subnet index for the same run. Its size is
   * also the in-flight-creation count {@link activeSlots} adds to
   * `vms.size` so the concurrency cap is race-free across the awaits
   * between the admission gate and `vms.set`.
   */
  private readonly creatingBoundaries = new Set<string>();

  /**
   * Base backoff between teardown-cleanup retries, doubling per attempt
   * (see retryCleanup). Instance field so tests can shrink it — same
   * precedent as {@link vmmReapTimeoutMs}.
   */
  private cleanupRetryBaseMs = 200;

  /** Host-lock pidfile path once acquired (see acquireHostLock). */
  private hostLockPath: string | null = null;

  /** Chroot-prep fs ops — node:fs/promises in production (see deps.jailFs). */
  private readonly jailFs: JailFs;

  /** Single MMDS PUT (credential broker) — see deps.mmdsPut / defaultMmdsPut. */
  private readonly mmdsPut: (apiSocketPath: string, payload: MmdsPayload) => Promise<void>;

  /** FIRECRACKER_BIN resolved to an absolute path (jailer `--exec-file`). */
  private fcBinResolved: string | null = null;

  /** FIRECRACKER_JAILER_BIN resolved to an absolute path (spawned argv[0]). */
  private jailerBinResolved: string | null = null;

  /**
   * Bound on the post-SIGKILL `proc.exited` wait (see killVm): a VMM
   * wedged in D-state (broken KVM ioctl) never reaps, and an unbounded
   * await would hang cancel/teardown/shutdown behind it. Instance field
   * so tests can shrink it (Reflect precedent).
   */
  private vmmReapTimeoutMs = 10_000;

  /**
   * Fail-closed gate: boot's parallel init swallows initialize() errors so
   * one broken backend can't block the API, but a run must NEVER start
   * without the host firewall — createIsolationBoundary refuses instead.
   */
  private initialized = false;

  /**
   * Periodic exit reaper (started by initialize(), cleared by shutdown()):
   * sweeps {@link vms} for records whose VMM exited but were never
   * finalized by any platform — see {@link reapExitedVms}.
   */
  private exitReaper?: ReturnType<typeof setInterval>;

  constructor(deps: FirecrackerOrchestratorDeps = {}) {
    this.hostExec = deps.hostExec ?? createHostExec();
    this.jailFs = deps.jailFs ?? defaultJailFs;
    this.mmdsPut = deps.mmdsPut ?? this.defaultMmdsPut.bind(this);
    this.agentArgvOverride = deps.agentArgvOverride;
    this.platformApiUrlOverride = deps.platformApiUrl;
    const parsedForward =
      deps.platformApiUrl === undefined ? undefined : parsePlatformApiUrl(deps.platformApiUrl);
    this.platformForward = parsedForward && { ip: parsedForward.ip, port: parsedForward.port };
    this.allocator = new SubnetAllocator(getFirecrackerEnv().FIRECRACKER_SUBNET_CIDR);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async initialize(): Promise<void> {
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

    // Data dir before the jailer gates — initializeJailer validates the
    // directory chain it lives in.
    await mkdir(resolve(fcEnv.FIRECRACKER_DATA_DIR), { recursive: true, mode: 0o700 });

    if (fcEnv.FIRECRACKER_JAILER === "on") {
      await this.initializeJailer(fcEnv, version);
    } else {
      logger.warn(
        "FIRECRACKER_JAILER=off — VMMs will run UNJAILED (no chroot, no per-VM uid drop, " +
          "no cgroup bounds) under this process's uid. Development only; never run " +
          "production workloads this way.",
      );
    }

    await this.acquireHostLock(resolve(fcEnv.FIRECRACKER_DATA_DIR));
    await setupHostNetwork(this.hostExec, {
      subnetCidr: fcEnv.FIRECRACKER_SUBNET_CIDR,
      aliasIp: platformAliasIp(fcEnv.FIRECRACKER_SUBNET_CIDR),
      platformPort: loAliasPlatformPort(),
      egressDenyCidrs: fcEnv.FIRECRACKER_EGRESS_DENY_CIDRS.split(",").filter(Boolean),
      // Remote-platform mode: guests must reach the override's ip:port
      // unconditionally (it typically sits inside the deny CIDRs above).
      ...(this.platformForward ? { platformForward: this.platformForward } : {}),
      // Escaped-VMM output guard (jailer mode): drop host-output traffic
      // originated by any jailed VMM uid toward IMDS/RFC1918/loopback —
      // the TAP-scoped rules above never see it (see host-net.ts).
      ...(fcEnv.FIRECRACKER_JAILER === "on" ? { vmmUidRange: jailUidRange(fcEnv) } : {}),
    });
    this.initialized = true;
    // Exit reaper (ROB-1, layer 2): when the platform dies mid-run, nobody
    // calls waitForExit/removeIsolationBoundary — an exited VMM's record
    // (and its FIRECRACKER_MAX_CONCURRENT_VMS slot) would leak until the
    // next daemon restart. Deliberately no unref (consoleWatch's interval
    // keeps the same convention).
    this.exitReaper = setInterval(() => {
      void this.reapExitedVms().catch(() => {});
    }, EXIT_REAPER_INTERVAL_MS);
    logger.info("Firecracker orchestrator initialized", {
      version,
      kernel: fcEnv.FIRECRACKER_KERNEL_PATH,
      rootfs: fcEnv.FIRECRACKER_ROOTFS_PATH,
      subnetCidr: fcEnv.FIRECRACKER_SUBNET_CIDR,
    });
  }

  /**
   * Jailer-mode boot gates (FIRECRACKER_JAILER=on): root, a working
   * jailer binary FROM THE SAME RELEASE as firecracker, a cgroup-v2
   * hierarchy when cgroup bounds are on, trustworthy jailer inputs
   * (binaries + directory chains), the chroot base, and world-readable
   * artifacts. Runs before the host lock so a misconfigured host fails
   * loudly at boot, never at the first run.
   */
  private async initializeJailer(fcEnv: FirecrackerEnv, fcVersion: string): Promise<void> {
    if (process.getuid?.() !== 0) {
      throw new Error(
        "FIRECRACKER_JAILER=on (the default) requires the daemon to run as root — the " +
          "jailer chroots each VMM and drops it to an unprivileged per-VM uid, which only " +
          "root can do. Run under the installed systemd unit (User=root), or set " +
          "FIRECRACKER_JAILER=off for unprivileged development (the VMM then runs " +
          "UNJAILED — never do this in production).",
      );
    }
    // Fails loudly here (not at first run) when the jailer binary is
    // absent/broken — same pattern as the firecracker version probe.
    const jailerVersion =
      (await this.execLocal([fcEnv.FIRECRACKER_JAILER_BIN, "--version"])).split("\n")[0] ?? "";
    // jailer and firecracker ship in the same upstream release tarball and
    // MUST come from the same release (upstream requirement). The installer
    // keeps the two in lockstep under <dataDir>/bin, but env overrides can
    // bypass it — enforce, don't assume.
    assertJailerVersionParity(fcVersion, jailerVersion);
    // Both binaries need real paths: `--exec-file` requires one, and the
    // trust checks below stat the resolved chain. A PATH problem surfaces
    // at boot, not at the first run.
    const fcBin = this.resolveFcBinPath(fcEnv);
    const jailerBin = this.resolveJailerBinPath(fcEnv);
    // cgroup-v2 probe: with FIRECRACKER_JAIL_CGROUPS=on the jailer writes
    // memory.max/pids.max under the unified hierarchy and exits with
    // CgroupHierarchyMissing on a v1/hybrid host — at the FIRST RUN, long
    // after initialize() reported green. Probe here instead.
    if (fcEnv.FIRECRACKER_JAIL_CGROUPS === "on") {
      await this.assertCgroupV2Controllers(["memory", "pids", "cpu"]);
    }
    // Jailer input trust (upstream places this on the operator): the two
    // binaries must be root-owned and not group/world-writable along their
    // whole path chain — the jailer copies --exec-file into every chroot
    // and runs it as the VMM. The chroot base / data dir chains must not
    // be world-writable (an attacker-writable parent lets the jail tree be
    // swapped out from under the daemon). Ownership of the dirs is not
    // enforced: dev/CI layouts legitimately live under user homes.
    await this.assertTrustedPathChain(fcBin, "FIRECRACKER_BIN", { requireRootOwned: true });
    await this.assertTrustedPathChain(jailerBin, "FIRECRACKER_JAILER_BIN", {
      requireRootOwned: true,
    });
    // Chroot base: sibling of the runs dir, same filesystem as the
    // artifacts (hardlink constraint — see jail.ts).
    await mkdir(jailChrootBase(fcEnv.FIRECRACKER_DATA_DIR), { recursive: true, mode: 0o700 });
    await this.assertTrustedPathChain(jailChrootBase(fcEnv.FIRECRACKER_DATA_DIR), "jail base", {
      requireRootOwned: false,
    });
    await this.assertTrustedPathChain(resolve(fcEnv.FIRECRACKER_DATA_DIR), "FIRECRACKER_DATA_DIR", {
      requireRootOwned: false,
    });
    // The kernel/rootfs are hardlinked into every VM's chroot and read
    // by unprivileged per-VM uids → they must be root:root 0644. They
    // are not secret (public release artifacts); enforce, don't document.
    for (const artifact of [
      resolve(fcEnv.FIRECRACKER_KERNEL_PATH),
      resolve(fcEnv.FIRECRACKER_ROOTFS_PATH),
    ]) {
      try {
        await chown(artifact, 0, 0);
        await chmod(artifact, 0o644);
      } catch (err) {
        throw new Error(
          `Firecracker jailer: could not make "${artifact}" root:root 0644 (jailed VMMs ` +
            `hardlink and read it as unprivileged uids): ${getErrorMessage(err)}`,
        );
      }
    }
    logger.info("Firecracker jailer enabled", {
      jailerVersion,
      uidBase: fcEnv.FIRECRACKER_JAIL_UID_BASE,
      cgroups: fcEnv.FIRECRACKER_JAIL_CGROUPS,
    });
  }

  /** Resolve FIRECRACKER_BIN to an absolute path (cached) — jailer `--exec-file`. */
  private resolveFcBinPath(fcEnv: FirecrackerEnv): string {
    if (this.fcBinResolved) return this.fcBinResolved;
    const bin = fcEnv.FIRECRACKER_BIN;
    const resolved = bin.includes("/") ? resolve(bin) : Bun.which(bin);
    if (!resolved) {
      throw new Error(
        `Firecracker jailer: FIRECRACKER_BIN "${bin}" was not found on PATH — the jailer's ` +
          `--exec-file requires a resolvable binary path`,
      );
    }
    this.fcBinResolved = resolved;
    return resolved;
  }

  /** Resolve FIRECRACKER_JAILER_BIN to an absolute path (cached). */
  private resolveJailerBinPath(fcEnv: FirecrackerEnv): string {
    if (this.jailerBinResolved) return this.jailerBinResolved;
    const bin = fcEnv.FIRECRACKER_JAILER_BIN;
    const resolved = bin.includes("/") ? resolve(bin) : Bun.which(bin);
    if (!resolved) {
      throw new Error(`Firecracker jailer: FIRECRACKER_JAILER_BIN "${bin}" was not found on PATH`);
    }
    this.jailerBinResolved = resolved;
    return resolved;
  }

  /**
   * Boot probe for the unified cgroup-v2 hierarchy: the named controllers
   * must appear in /sys/fs/cgroup/cgroup.controllers. On a v1/hybrid host
   * (or without delegation) the file is absent or lacks them — fail HERE
   * with the escape hatch spelled out, not at the first run as an opaque
   * jailer CgroupHierarchyMissing crash.
   */
  private async assertCgroupV2Controllers(needed: string[]): Promise<void> {
    const controllers = await Bun.file("/sys/fs/cgroup/cgroup.controllers")
      .text()
      .catch(() => null);
    const available = controllers?.trim().split(/\s+/) ?? [];
    const missing = needed.filter((c) => !available.includes(c));
    if (controllers === null || missing.length > 0) {
      throw new Error(
        `Firecracker jailer: FIRECRACKER_JAIL_CGROUPS=on requires the cgroup-v2 unified ` +
          `hierarchy with the ${needed.join("+")} controllers, but ` +
          (controllers === null
            ? `/sys/fs/cgroup/cgroup.controllers is not readable (cgroup v1/hybrid host?)`
            : `controller(s) ${missing.join(", ")} are not enabled at the root`) +
          `. Enable cgroup v2 on this host, or set FIRECRACKER_JAIL_CGROUPS=off to keep ` +
          `the jail without resource bounds.`,
      );
    }
  }

  /**
   * Walk `path` and every parent up to `/`, enforcing the jailer-input
   * trust rules (upstream explicitly delegates these to the operator):
   * no component may be world-writable, and — for the binaries the jailer
   * will copy into chroots and exec — every component must be root-owned
   * and not group-writable either. The sticky bit does not exempt a dir:
   * jailer inputs have no business living under /tmp-style directories.
   */
  private async assertTrustedPathChain(
    path: string,
    what: string,
    opts: { requireRootOwned: boolean },
  ): Promise<void> {
    let current = resolve(path);
    for (;;) {
      const st = await stat(current).catch((err: unknown) => {
        throw new Error(
          `Firecracker jailer: cannot stat "${current}" while validating ${what}: ` +
            getErrorMessage(err),
        );
      });
      const badModeBits = opts.requireRootOwned ? 0o022 : 0o002;
      if ((st.mode & badModeBits) !== 0) {
        throw new Error(
          `Firecracker jailer: "${current}" (in the path of ${what}) is ` +
            `${opts.requireRootOwned ? "group/world" : "world"}-writable ` +
            `(mode ${(st.mode & 0o7777).toString(8)}) — a writable component lets an ` +
            `unprivileged user swap the jailer's inputs. Tighten its permissions.`,
        );
      }
      if (opts.requireRootOwned && st.uid !== 0) {
        throw new Error(
          `Firecracker jailer: "${current}" (in the path of ${what}) is owned by uid ` +
            `${st.uid}, not root — the jailer executes this input as the VMM; only ` +
            `root-owned chains are trusted.`,
        );
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  async shutdown(): Promise<void> {
    if (this.exitReaper) {
      clearInterval(this.exitReaper);
      this.exitReaper = undefined;
    }
    // Full per-run teardown (VM, TAP, sockets, run dirs) BEFORE removing
    // the host firewall — a VM must never outlive the policy table.
    const records = [...this.vms.values()];
    await Promise.all(records.map((vm) => this.destroyVm(vm, 5, "shutdown")));
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
      if (state && (state.jailUid !== undefined || state.chrootPath !== undefined)) {
        // Jailed run: every in-chroot VMM shares the SAME argv, so the
        // argv/socket identities below cannot discriminate. Match on the
        // jail itself instead (chroot root / reserved uid) — see
        // sweepJailedVmm. Recorded pid deliberately ignored: the jail
        // identity scan is strictly stronger than a pid-reuse guess.
        workloads += await this.sweepJailedVmm(state);
      } else if (state?.pid && state.pid > 0) {
        // A recorded pid may have been recycled by an unrelated process
        // since the crash — only kill it if /proc still shows a
        // firecracker VMM bound to THIS run's API socket.
        if (await this.pidIsOurVmm(state.pid, state.apiSocketPath)) {
          if (this.killPid(state.pid)) workloads++;
        } else {
          logger.warn("Orphan sweep: pid is not this run's firecracker VMM — skipping kill", {
            runId: state.runId,
            pid: state.pid,
          });
        }
      } else if (state?.apiSocketPath) {
        // Pre-spawn crash window: createIsolationBoundary persists the api
        // socket path BEFORE startWorkload records the pid. A daemon crash
        // in between leaves a running VMM with no pid on disk — find it by
        // the exact `--api-sock` it was launched with. Conservative: only
        // a /proc entry that IS a firecracker VMM referencing this socket
        // is a positive match; anything else is left untouched.
        const pid = await this.findVmmByApiSocket(state.apiSocketPath);
        if (pid !== null && this.killPid(pid)) workloads++;
      }
      if (state?.tapDevice) {
        await deleteTap(this.hostExec, state.tapDevice).catch(() => {});
      }
      // Reclaim the run's jail tree (chrootPath = <jailDir>/root — remove
      // the whole <jailDir>). Hardlinks only drop a link count; the
      // shared artifacts survive. Best-effort like every step here.
      // Containment first: this is a recursive root rm whose target comes
      // from an on-disk JSON file — a corrupted state.json must never aim
      // it outside the jail base (chrootPath:"/x" would rm "/").
      if (state?.chrootPath) {
        const jailBase = jailChrootBase(fcEnv.FIRECRACKER_DATA_DIR);
        const jailDir = dirname(resolve(state.chrootPath));
        if (jailDir.startsWith(jailBase + sep)) {
          await rm(jailDir, { recursive: true, force: true }).catch(() => {});
        } else {
          logger.warn(
            "Orphan sweep: state.json chrootPath resolves outside the jail base — skipping rm",
            { runId: state.runId, chrootPath: state.chrootPath, jailBase },
          );
        }
        if (state.jailId) await this.removeJailCgroup(state.jailId);
      }
      // Preserve the crashed run's console before its workspace is reclaimed
      // — a crash-swept run is exactly the kind that needs post-mortem
      // forensics. The exit-marker nonce died with the previous daemon, so
      // it can't be authenticated here (reported false, not scanned).
      const orphanRunId = state?.runId ?? name;
      const orphanTail = await this.readConsoleTail(
        join(dir, "console.log"),
        CONSOLE_ARCHIVE_BYTES,
      );
      await this.archiveConsole(orphanRunId, orphanTail).catch((err) => {
        logger.warn("Firecracker orphan console archive failed — continuing sweep", {
          runId: orphanRunId,
          error: getErrorMessage(err),
        });
      });
      logger.info("Firecracker workload destroyed", {
        runId: orphanRunId,
        reason: "orphan-sweep" satisfies TeardownReason,
        exitMarkerFound: false,
        uptimeMs: 0,
      });
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      isolationBoundaries++;
    }

    // Jail residue with NO state file at all (crash between chroot prep
    // and the pre-spawn state write, or a wiped data dir): a firecracker
    // whose /proc root points under OUR chroot base is positively ours.
    workloads += await this.sweepJailBase();

    // Empty per-VM cgroup dirs orphaned by a reap-timeout teardown: when a
    // D-state VMM outlives its runDir/state.json, nothing above reaches its
    // cgroup — once the kernel finally releases the process the dir sits
    // empty under appstrate-fc/ forever. rmdir(2) only: a still-populated
    // group fails and is left alone.
    await this.sweepJailCgroups();

    // Sweep TAP devices with no backing run dir (crash between TAP create
    // and state write). The platform owns the `afc<n>` namespace.
    try {
      for (const tap of await listTapDevices(this.hostExec)) {
        await deleteTap(this.hostExec, tap).catch(() => {});
      }
    } catch (err) {
      logger.warn("Firecracker orphan TAP sweep failed", { error: getErrorMessage(err) });
    }

    // Reclaim the socket root a crashed predecessor left behind. The root
    // is deterministic per data dir, so this successor finds it; any VMM
    // that held a socket in it was already killed above. Safe to remove
    // wholesale here: the sweep runs at boot before ensureSocketDir creates
    // this daemon's own socket (it is lazy, first-run only).
    await rm(this.socketRoot(), { recursive: true, force: true }).catch(() => {});

    return { workloads, isolationBoundaries, workspaces: 0 };
  }

  // -------------------------------------------------------------------------
  // Boundary
  // -------------------------------------------------------------------------

  /** Booted microVMs plus in-flight creations holding a reserved slot. */
  private activeSlots(): number {
    return this.vms.size + this.creatingBoundaries.size;
  }

  /**
   * The runner daemon is the final capability-admission boundary. A rolling
   * upgrade may deliver additive requirement fields, but a capability this
   * binary cannot provision must never be ignored. Resource totals are also
   * checked against the daemon's own profile registry so a malformed or stale
   * client cannot request a browser while under-sizing the guest.
   */
  private assertSupportedRequirements(
    runId: string,
    requirements: ExecutionRequirements | undefined,
  ): void {
    if (!requirements) return;
    let browserInstances = 0;
    let minimumMemoryBytes = 0;
    let minimumNanoCpus = 0;
    let minimumPids = 0;
    for (const capability of requirements.capabilities) {
      if (capability.kind !== "browser" || capability.profile !== "standard") {
        throw new Error(
          `Firecracker orchestrator: unsupported required capability for run ${runId}`,
        );
      }
      if (!Number.isInteger(capability.instances) || capability.instances <= 0) {
        throw new Error(
          `Firecracker orchestrator: invalid browser instance count for run ${runId}`,
        );
      }
      browserInstances += capability.instances;
      const profile = getBrowserResourceProfile(capability.profile);
      minimumMemoryBytes += profile.memoryBytes * capability.instances;
      minimumNanoCpus += profile.nanoCpus * capability.instances;
      minimumPids += (profile.pidsLimit ?? 0) * capability.instances;
    }
    if (browserInstances > MAX_BROWSER_INSTANCES_PER_RUN) {
      throw new Error(
        `Firecracker orchestrator: run ${runId} requests ${browserInstances} browser ` +
          `instances; maximum is ${MAX_BROWSER_INSTANCES_PER_RUN}`,
      );
    }
    const supplemental = requirements.supplementalResources;
    if (
      supplemental.memoryBytes < minimumMemoryBytes ||
      supplemental.nanoCpus < minimumNanoCpus ||
      (supplemental.pidsLimit ?? 0) < minimumPids
    ) {
      throw new Error(
        `Firecracker orchestrator: supplemental resources under-provision required ` +
          `browser capability for run ${runId}`,
      );
    }
  }

  async createIsolationBoundary(
    runId: string,
    opts?: IsolationBoundaryOptions,
  ): Promise<IsolationBoundary> {
    if (!this.initialized) {
      throw new Error(
        "Firecracker orchestrator is not initialized (host firewall setup failed or " +
          "never ran) — refusing to start a run without host↔guest isolation. " +
          "Check the boot logs for the initialize() failure.",
      );
    }
    // Defense in depth: the daemon route already rejects an unsafe runId
    // (protocol.ts createBoundaryBodySchema), but the smoke harness drives
    // this engine directly and `runId` reaches the filesystem verbatim
    // (join(dataDir, runId) below, <archive>/<runId>.log at teardown).
    if (!RUN_ID_RE.test(runId)) {
      throw new Error(
        `Firecracker orchestrator: runId "${runId}" is outside the safe ` +
          `run-identifier charset — refusing (it reaches the filesystem verbatim)`,
      );
    }
    this.assertSupportedRequirements(runId, opts?.requirements);
    // One boundary per runId, ever-live. Checked here and reserved below in
    // the SAME synchronous stretch (no await between check and add) so two
    // concurrent creates for the same runId cannot both pass — the loser
    // throws and allocates nothing. A record still in `vms` (including one
    // whose teardown is in flight) also counts: a replayed POST — the
    // captured-bearer attack this guards against — must never draw a second
    // TAP + subnet index that removeIsolationBoundary would then leak.
    if (this.vms.has(runId) || this.creatingBoundaries.has(runId)) {
      throw new BoundaryExistsError(runId);
    }
    const fcEnv = getFirecrackerEnv();
    // Admission control BEFORE any allocation: overcommitting host RAM
    // with unbounded concurrent VMs is worse than failing the run fast.
    // The gate counts booted VMs PLUS in-flight creations: `this.vms.set`
    // only lands after several awaits, so a plain `this.vms.size` check
    // would be TOCTOU — two concurrent creations would each see room and
    // both proceed past the cap. The runId is added to the in-flight set
    // synchronously here (before the first await) and removed in the
    // finally once the run is either in `vms` or rolled back — the set
    // doubles as the reserved-slot count (see activeSlots).
    const maxVms = fcEnv.FIRECRACKER_MAX_CONCURRENT_VMS;
    if (maxVms > 0 && this.activeSlots() >= maxVms) {
      throw new Error(
        `Firecracker orchestrator at capacity: ${this.activeSlots()}/${maxVms} concurrent ` +
          `microVMs (FIRECRACKER_MAX_CONCURRENT_VMS) — refusing to start run ${runId}`,
      );
    }
    this.creatingBoundaries.add(runId);
    try {
      const jailerOn = fcEnv.FIRECRACKER_JAILER === "on";
      // Jailer mode needs no tmpdir socket root — the API socket lives
      // inside the chroot (see below).
      const socketDir = jailerOn ? null : await this.ensureSocketDir();
      const runDir = join(resolve(fcEnv.FIRECRACKER_DATA_DIR), runId);
      await mkdir(runDir, { recursive: true, mode: 0o700 });

      // allocate() can throw (subnet pool exhausted) AFTER the mkdir above —
      // reclaim the just-created runDir so a failed admission leaves nothing
      // on disk (the inner try below only covers post-allocate failures).
      let subnet: RunSubnet;
      try {
        subnet = this.allocator.allocate();
      } catch (err) {
        await rm(runDir, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
      let jail: JailPaths | undefined;
      try {
        // Compute the jail layout BEFORE the TAP exists: computeJailPaths
        // throws on the AF_UNIX socket-length guard (too-deep
        // FIRECRACKER_DATA_DIR) and must roll back only the index + dir.
        if (jailerOn) {
          jail = computeJailPaths({
            dataDir: fcEnv.FIRECRACKER_DATA_DIR,
            fcExecName: fcExecName(fcEnv.FIRECRACKER_BIN),
            runId,
            subnetIndex: subnet.index,
            uidBase: fcEnv.FIRECRACKER_JAIL_UID_BASE,
          });
        }
        // Jailed VMMs run as an unprivileged per-VM uid — the TAP must be
        // born owned by that uid or TUNSETIFF fails (see createTap).
        await createTap(this.hostExec, subnet, jail ? { ownerUid: jail.uid } : {});
      } catch (err) {
        this.allocator.release(subnet.index);
        await rm(runDir, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
      // Jailer mode: the socket sits at the jailer-conventional
      // /run/firecracker.socket INSIDE the chroot; host-side we reach it
      // at <root>/run/firecracker.socket (length-guarded above).
      // Direct mode: NOT under runDir — AF_UNIX paths are capped at ~108
      // bytes (SUN_LEN) and FIRECRACKER_DATA_DIR/<runId>/ routinely
      // exceeds it (Firecracker then dies at startup with
      // FailedToBindAndRunHttpServer). The socket dir is a short,
      // deterministic per-data-dir 0700 directory under tmpdir (see
      // ensureSocketDir): under the cap, out of the world-writable flat
      // /tmp, AND recoverable by a successor daemon. The subnet index is
      // unique among this orchestrator's live runs.
      const apiSocketPath = jail
        ? jail.apiSocketHostPath
        : join(socketDir as string, `afc-${subnet.index}.sock`);
      // Persist the socket path (+ jail identity) BEFORE the VMM spawns
      // (the pid is added by writeStateFileStrict in startWorkload). A
      // daemon crash in the window between spawn and the pid write would
      // otherwise leave a VMM the pid-based orphan sweep cannot see —
      // the boot sweep falls back to matching this socket path (direct)
      // or the chroot/uid (jailed) against /proc (see cleanupOrphans).
      await this.writeStateFile(runDir, {
        runId,
        tapDevice: subnet.tapDevice,
        apiSocketPath,
        ...(jail ? { jailId: jail.jailId, jailUid: jail.uid, chrootPath: jail.rootDir } : {}),
      });

      // Remote-platform mode: the guest talks to the override ip, not the
      // host lo alias — the noProxy exemption must track whichever one the
      // sink POSTs actually target.
      const platformIp = this.platformForward?.ip ?? platformAliasIp(fcEnv.FIRECRACKER_SUBNET_CIDR);
      let abandonReap!: () => void;
      const reapAbandoned = new Promise<void>((resolveAbandon) => {
        abandonReap = resolveAbandon;
      });
      this.vms.set(runId, {
        runId,
        subnet,
        runDir,
        consolePath: join(runDir, "console.log"),
        apiSocketPath,
        proc: null,
        stopping: false,
        createdAt: Date.now(),
        ...(opts?.requirements ? { requirements: opts.requirements } : {}),
        reapAbandoned,
        abandonReap,
        ...(jail ? { jail } : {}),
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
          // The platform endpoint must bypass the forward proxy — sink POSTs
          // go straight out eth0 (uid-scoped allow in the guest firewall).
          noProxy: `localhost,127.0.0.1,${platformIp}`,
        },
      };
    } finally {
      // A run that reached `vms.set` is now counted by `this.vms.size`; one
      // that threw released its subnet/dir above. Either way the reservation
      // is done — drop it so activeSlots never double-counts. The same
      // delete releases the per-runId guard: a successful create is now
      // covered by the `vms.has` check, a failed one may legitimately be
      // retried.
      this.creatingBoundaries.delete(runId);
    }
  }

  async removeIsolationBoundary(boundary: IsolationBoundary): Promise<void> {
    // `boundary.id` crosses the daemon wire as an opaque z.string().min(1)
    // (protocol.ts isolationBoundarySchema) yet reaches a recursive rm here
    // — a crafted id like "/" or "../.." would delete host state outside
    // the run tree. Contain it before any destructive fs op.
    const target = this.assertUnderDataDir(boundary.id, "boundary id");
    const runId = boundary.name.replace(/^firecracker-/, "");
    const vm = this.vms.get(runId);
    if (vm) {
      await this.destroyVm(vm, 0, "finalize");
    }
    this.pendingSidecarEnv.delete(runId);
    this.pendingAgentSpecs.delete(runId);
    await rm(target, { recursive: true, force: true }).catch(() => {});
  }

  /**
   * Resolve a wire-supplied path and require it to live strictly under
   * FIRECRACKER_DATA_DIR. Guards the destructive fs ops whose target
   * arrives from the daemon wire (see removeIsolationBoundary). Throws a
   * clear error — never silently no-ops — so a crafted path is a loud
   * rejection, not a silent skip.
   */
  private assertUnderDataDir(candidate: string, what: string): string {
    const dataDir = resolve(getFirecrackerEnv().FIRECRACKER_DATA_DIR);
    const resolved = resolve(candidate);
    if (!resolved.startsWith(dataDir + sep)) {
      throw new Error(
        `Firecracker orchestrator: ${what} "${candidate}" resolves outside ` +
          `FIRECRACKER_DATA_DIR (${dataDir}) — refusing filesystem operation`,
      );
    }
    return resolved;
  }

  /**
   * Tear down one run's VM + network + on-disk state. Idempotent AND
   * single-flight: concurrent teardowns for the same run (a double remove
   * from the wire, the exit reaper racing a finalize, shutdown racing a
   * cancel) all await ONE underlying teardown — the subnet index, the TAP
   * device and the `vms` record are released exactly once, so a second
   * teardown can never delete a TAP name a new run has already re-drawn
   * from the allocator.
   */
  private destroyVm(vm: VmRecord, graceSeconds: number, reason: TeardownReason): Promise<void> {
    vm.teardown ??= this.destroyVmOnce(vm, graceSeconds, reason);
    return vm.teardown;
  }

  /**
   * The actual teardown — only ever entered once per record via destroyVm.
   * Never throws: every fallible op inside is caught — partial failures
   * are logged and swept at next boot.
   */
  private async destroyVmOnce(
    vm: VmRecord,
    graceSeconds: number,
    reason: TeardownReason,
  ): Promise<void> {
    if (vm.consoleWatch) clearInterval(vm.consoleWatch);
    if (vm.lifetimeTimer) clearTimeout(vm.lifetimeTimer);
    // Kill AND confirm the reap BEFORE touching the VMM's resources: a
    // not-yet-reaped process still holds the TAP fd and populates its
    // cgroup, so deleting them first would only manufacture EBUSY.
    const vmmReaped = await this.killVm(vm, graceSeconds).catch((err: unknown) => {
      logger.warn("Firecracker VMM kill errored during teardown — continuing cleanup", {
        runId: vm.runId,
        error: getErrorMessage(err),
      });
      return false;
    });
    // Teardown observability (phase 4): read the console tail ONCE, derive
    // the exit-marker signal, archive it, and emit a structured line — all
    // BEFORE the workspace (with console.log) is deleted below. No silent
    // path from boot to gone.
    const tail = await this.readConsoleTail(vm.consolePath, CONSOLE_ARCHIVE_BYTES);
    const exitMarkerFound = vm.exitNonce ? parseExitMarker(tail, vm.exitNonce) !== null : false;
    await this.archiveConsole(vm.runId, tail).catch((err) => {
      logger.warn("Firecracker console archive failed — continuing teardown", {
        runId: vm.runId,
        error: getErrorMessage(err),
      });
    });
    logger.info("Firecracker workload destroyed", {
      runId: vm.runId,
      reason: this.effectiveTeardownReason(vm, reason),
      exitMarkerFound,
      vmmReaped,
      uptimeMs: vm.bootedAt !== undefined ? Date.now() - vm.bootedAt : 0,
    });
    try {
      // Retried: right after the kill the kernel may still be releasing
      // the VMM's TAP fd, so the first `ip link del` can transiently fail.
      await this.retryCleanup(() => deleteTap(this.hostExec, vm.subnet.tapDevice));
      // ORDERING HAZARD — the index is released only AFTER the confirmed
      // TAP delete: releasing it while the device lingers would poison the
      // next run that draws the same index (its `ip tuntap add` fails on
      // the existing device), and a re-drawn TAP name must never be
      // re-deleted by this stale teardown. A stuck index is reclaimed by
      // the boot-time orphan sweep.
      this.allocator.release(vm.subnet.index);
    } catch (err) {
      logger.warn("Failed to delete TAP device after retries — keeping its subnet index reserved", {
        runId: vm.runId,
        tap: vm.subnet.tapDevice,
        attempts: CLEANUP_RETRY_ATTEMPTS,
        error: getErrorMessage(err),
      });
    }
    if (vm.jail) {
      // The whole jail tree — chroot root, exec copy, hardlinks (the
      // shared artifacts just lose a link count), config drive, socket.
      await removeJailDir(vm.jail.jailDir, this.jailFs).catch((err) => {
        logger.warn("Failed to remove the run's jail chroot tree", {
          runId: vm.runId,
          jailDir: vm.jail?.jailDir,
          error: getErrorMessage(err),
        });
      });
      await this.removeJailCgroup(vm.jail.jailId);
    }
    await rm(vm.apiSocketPath, { force: true }).catch(() => {});
    await rm(vm.runDir, { recursive: true, force: true }).catch(() => {});
    // Wipe the run's credential-bearing pending maps HERE — the single
    // teardown funnel — so the never-booted-then-reaped path (platform died
    // between createWorkload and startWorkload) can't leave the run token,
    // model keys, or integration tokens in daemon heap until restart. The
    // happy path already cleared them at startWorkload; this covers the
    // reaper/finalize/exit paths that never call removeIsolationBoundary.
    this.pendingSidecarEnv.delete(vm.runId);
    this.pendingAgentSpecs.delete(vm.runId);
    this.vms.delete(vm.runId);
  }

  /**
   * Exit-reaper sweep (ROB-1, layer 2): destroy every record whose VMM
   * exited more than {@link EXIT_REAP_AFTER_MS} ago — AND every boundary
   * that never got a VMM (`proc: null`) and is older than the same bound.
   * A healthy platform claims an exit within seconds (waitForExit
   * long-poll) and boots a created boundary within seconds (startWorkload)
   * — a record past either threshold means the platform died mid-run (or
   * a captured bearer replayed creates it never intends to boot) and
   * nobody will ever finalize this run; without the sweep, the VmRecord,
   * its TAP + subnet index and its FIRECRACKER_MAX_CONCURRENT_VMS slot
   * leak until daemon restart. Returns the number of records reaped
   * (internal seam for unit tests).
   */
  private async reapExitedVms(now = Date.now()): Promise<number> {
    let reaped = 0;
    for (const vm of [...this.vms.values()]) {
      const exitStale = vm.exitedAt !== undefined && now - vm.exitedAt > EXIT_REAP_AFTER_MS;
      // Never-booted boundary: no process means no exit event can ever
      // stamp `exitedAt` — age from record creation is the only signal.
      const neverBootedStale = vm.proc === null && now - vm.createdAt > EXIT_REAP_AFTER_MS;
      if (!exitStale && !neverBootedStale) continue;
      logger.info(
        exitStale
          ? "VMM exited but no platform claimed the run — reaping"
          : "Boundary created but no VMM was ever started — reaping",
        {
          runId: vm.runId,
          idleMs: now - (vm.exitedAt ?? vm.createdAt),
        },
      );
      // destroyVmOnce never throws — no retry branch needed here.
      await this.destroyVm(vm, 0, "reaper");
      reaped++;
    }
    return reaped;
  }

  /**
   * Generic bounded retry: run `op` up to `attempts` times, sleeping
   * `baseMs` between attempts and multiplying the delay by `backoff` after
   * each failure (`backoff: 1` = fixed interval). The last error
   * propagates so each caller decides how loudly to log.
   */
  private async retryOp(
    op: () => Promise<unknown>,
    opts: { attempts: number; baseMs: number; backoff: number },
  ): Promise<void> {
    let delayMs = opts.baseMs;
    for (let attempt = 1; ; attempt++) {
      try {
        await op();
        return;
      } catch (err) {
        if (attempt >= opts.attempts) throw err;
        await new Promise((r) => setTimeout(r, delayMs));
        delayMs *= opts.backoff;
      }
    }
  }

  /**
   * Bounded retry for teardown host ops that transiently fail while the
   * kernel finishes releasing a just-killed VMM's resources — cgroup
   * rmdir answers EBUSY until the VMM is fully reaped, and a TAP delete
   * can race the fd release the same way. Backoff doubles per attempt
   * (base {@link cleanupRetryBaseMs}).
   */
  private retryCleanup(op: () => Promise<unknown>): Promise<void> {
    return this.retryOp(op, {
      attempts: CLEANUP_RETRY_ATTEMPTS,
      baseMs: this.cleanupRetryBaseMs,
      backoff: 2,
    });
  }

  /**
   * Removal of the per-VM cgroup dir the jailer created
   * (`/sys/fs/cgroup/appstrate-fc/<jailId>`, cgroup v2). rmdir(2) only —
   * cgroupfs semantics: succeeds once the VMM is reaped and the group is
   * empty. Retried (a just-killed VMM may not be reaped yet → EBUSY);
   * absent (ENOENT) is success, handled inside the op so it never burns a
   * retry; anything that survives the retries is logged and left for the
   * boot sweep — never swallowed silently.
   */
  private async removeJailCgroup(jailId: string): Promise<void> {
    const parent = join("/sys/fs/cgroup", JAIL_PARENT_CGROUP);
    const path = join(parent, jailId);
    // Containment: at boot this jailId comes from an on-disk state.json — a
    // crafted value ("../../…") must never aim the rmdir outside the
    // appstrate-fc slice. join() has already normalized any traversal, so a
    // resolved path that no longer sits under the parent is rejected. The
    // in-memory teardown caller passes a trusted jailId and always passes.
    if (!resolve(path).startsWith(resolve(parent) + sep)) {
      logger.warn("Skipping cgroup removal: jailId escapes the appstrate-fc slice", { jailId });
      return;
    }
    try {
      await this.retryCleanup(async () => {
        try {
          await rmdir(path);
        } catch (err) {
          // Already gone (or the jailer never created it) — success.
          if (!isMissingFsEntry(err)) throw err;
        }
      });
    } catch (err) {
      logger.warn("Failed to remove the run's per-VM cgroup after retries — left for boot sweep", {
        jailId,
        attempts: CLEANUP_RETRY_ATTEMPTS,
        error: getErrorMessage(err),
      });
    }
  }

  /**
   * Boot-time sweep of EVERY per-VM cgroup dir under the appstrate-fc
   * slice (see cleanupOrphans). rmdir(2) only — cgroupfs refuses to remove
   * a populated group, so a dir that still hosts a live VMM survives.
   */
  private async sweepJailCgroups(): Promise<void> {
    const base = join("/sys/fs/cgroup", JAIL_PARENT_CGROUP);
    let dirents;
    try {
      dirents = await readdir(base, { withFileTypes: true });
    } catch {
      return; // Slice absent — the jailer never ran with cgroups on this host.
    }
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      await rmdir(join(base, dirent.name)).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // Workloads
  // -------------------------------------------------------------------------

  async createSidecar(
    runId: string,
    boundary: IsolationBoundary,
    spec: SidecarLaunchSpec,
  ): Promise<WorkloadHandle> {
    // Admission: a sidecar spec carries the run token + credential bundle env.
    // Refuse to stash it unless the run owns a live boundary — otherwise a
    // stray (or replayed-on-a-captured-bearer) call would leave secrets in a
    // pending map with no VmRecord for the reaper to ever sweep.
    this.assertBoundaryExists(runId, "createSidecar");
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
    // Same admission gate as createSidecar: the agent spec's env carries
    // credentials — never stash it for a run with no live boundary.
    this.assertBoundaryExists(spec.runId, "createWorkload");
    this.pendingAgentSpecs.set(spec.runId, spec);
    return { id: `fc-${spec.runId}-${spec.role}`, runId: spec.runId, role: spec.role };
  }

  /**
   * Guard the credential-stashing create* calls: the run must already own a
   * boundary VmRecord (createIsolationBoundary ran). Without it a pending
   * env/spec entry would have no VmRecord, so neither the exit reaper nor a
   * finalize teardown would ever wipe the secrets it holds.
   */
  private assertBoundaryExists(runId: string, verb: string): void {
    if (!this.vms.has(runId)) {
      throw new Error(
        `Firecracker orchestrator: ${verb} for run ${runId} has no isolation boundary — ` +
          `createIsolationBoundary must run first`,
      );
    }
  }

  async startWorkload(handle: WorkloadHandle): Promise<void> {
    // The VM hosts every role; it boots exactly once, when the agent —
    // the workload pi.ts drives the lifecycle through — is started.
    if (handle.role !== "agent") return;

    const fcEnv = getFirecrackerEnv();
    const vm = this.vms.get(handle.runId);
    const agentSpec = this.pendingAgentSpecs.get(handle.runId);
    if (!vm || !agentSpec) {
      throw new Error(
        `Firecracker orchestrator: no boundary/agent spec for run ${handle.runId} — ` +
          `createIsolationBoundary + createWorkload must run before startWorkload`,
      );
    }

    vm.exitNonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    // Remote-platform mode: the guest firewall's sink-POST allow and the
    // supervisor's platform endpoint must target the override, not the
    // host lo alias (which nothing listens on in that topology).
    const aliasIp = platformAliasIp(fcEnv.FIRECRACKER_SUBNET_CIDR);
    // skipSidecar runs never called createSidecar — no pending env entry.
    const sidecarEnv = this.pendingSidecarEnv.get(handle.runId);

    // Credential broker: with FIRECRACKER_CREDENTIAL_BROKER=mmds (default)
    // the secret keys are stripped off the config drive and served in-memory
    // via MMDS after boot; config-drive mode keeps today's inline delivery.
    const mmdsMode = fcEnv.FIRECRACKER_CREDENTIAL_BROKER === "mmds";
    const split = mmdsMode
      ? splitCredentials(sidecarEnv, agentSpec.env)
      : {
          driveSidecarEnv: sidecarEnv,
          driveAgentEnv: agentSpec.env,
          mmdsPayload: { sidecar_env: {}, agent_env: {} } satisfies MmdsPayload,
        };
    // Capacity, fail-closed: a known secret NEVER falls back onto the
    // config drive. Payloads above Firecracker's 50 KiB store default get
    // the VMM's limits raised at spawn (see mmdsSpawnArgs); beyond the
    // operator ceiling the run fails loudly instead of silently degrading
    // the at-rest guarantee.
    const mmdsBytes = mmdsMode ? mmdsPayloadBytes(split.mmdsPayload) : 0;
    if (mmdsMode && mmdsBytes > fcEnv.FIRECRACKER_MMDS_MAX_BYTES) {
      throw new Error(
        `Firecracker orchestrator: the run's brokered credential payload is ${mmdsBytes} bytes, ` +
          `above FIRECRACKER_MMDS_MAX_BYTES (${fcEnv.FIRECRACKER_MMDS_MAX_BYTES}) — refusing to ` +
          `start run ${handle.runId} rather than write known secrets to the config drive. ` +
          `Raise the ceiling, or shrink the run's integration payload.`,
      );
    }

    const guestConfig = buildGuestConfig({
      runId: handle.runId,
      exitMarkerNonce: vm.exitNonce,
      platformIp: this.platformForward?.ip ?? aliasIp,
      platformPort: this.platformForward?.port ?? loAliasPlatformPort(),
      sidecarEnv: split.driveSidecarEnv,
      agentEnv: split.driveAgentEnv,
      agentUnrestrictedEgress: agentSpec.egress === true,
      credentialSource: mmdsMode ? "mmds" : "inline",
      ...(this.agentArgvOverride ? { agentArgv: this.agentArgvOverride } : {}),
    });
    // The guest config + MMDS payload now own the credentials — drop them
    // from the pending maps immediately instead of letting them linger.
    this.pendingSidecarEnv.delete(handle.runId);
    this.pendingAgentSpecs.delete(handle.runId);

    const configDrivePath = join(vm.runDir, "config.img");
    await this.buildConfigDrive(vm.runDir, configDrivePath, guestConfig);

    const sizing = vmSizing(
      agentSpec.resources,
      sidecarEnv !== undefined,
      vm.requirements?.supplementalResources,
    );
    const proc = await this.spawnVmm(
      vm,
      configDrivePath,
      sizing,
      mmdsMode ? { payloadBytes: mmdsBytes } : null,
    );
    vm.proc = proc;
    vm.bootedAt = Date.now();
    drainStream(proc, `fc:${handle.runId}`);
    // Boot-window cancel latch (B4): stopWorkload/stopByRunId latch
    // `vm.stopping` even when no VMM has spawned yet — recheck it here so
    // a cancel that landed while spawnVmm was in flight kills the fresh
    // VMM instead of letting the run boot anyway. Kept BEFORE
    // writeStateFileStrict: a cancelled run must not persist a pid as if
    // it were live.
    if (vm.stopping) {
      await this.killVm(vm, 0).catch(() => {});
      vm.proc = null;
      throw new Error(
        `Firecracker orchestrator: run ${handle.runId} was cancelled during boot — ` +
          `killed the just-spawned VMM`,
      );
    }
    // Mandatory (unlike the pre-spawn pid-less write): without the pid on
    // disk, a platform crash leaves a VMM the boot sweep cannot kill. A
    // VMM we cannot account for must not run — kill it and fail the run.
    try {
      await this.writeStateFileStrict(vm.runDir, {
        runId: handle.runId,
        tapDevice: vm.subnet.tapDevice,
        pid: proc.pid,
        apiSocketPath: vm.apiSocketPath,
        ...(vm.jail
          ? { jailId: vm.jail.jailId, jailUid: vm.jail.uid, chrootPath: vm.jail.rootDir }
          : {}),
      });
    } catch (err) {
      vm.stopping = true;
      // Bounded kill+reap (killVm), NOT a raw `await proc.exited`: a VMM
      // wedged in D-state never settles `exited` even after SIGKILL, and
      // an unbounded await here would hang the run's start path forever.
      await this.killVm(vm, 0).catch(() => {});
      vm.proc = null;
      throw new Error(
        `Firecracker orchestrator: failed to persist the VMM pid for run ${handle.runId} — ` +
          `killed the VMM rather than leave it unsweepable: ${getErrorMessage(err)}`,
      );
    }

    // Credential broker: push the run's secrets into the booted VMM's
    // in-memory MMDS store. The guest supervisor fetches them at boot;
    // until they land, a sidecar-backed run would silently come up without
    // credentials — so this is FAIL-CLOSED. A short retry absorbs the
    // window where the just-spawned VMM has not yet bound its API socket;
    // on final failure the VM is destroyed and the run fails.
    if (mmdsMode) {
      try {
        await this.injectMmds(vm, split.mmdsPayload);
      } catch (err) {
        vm.stopping = true;
        await this.destroyVm(vm, 0, "crash").catch(() => {});
        throw new Error(
          `Firecracker orchestrator: MMDS credential injection failed for run ${handle.runId} — ` +
            `destroyed the VM rather than boot it without credentials: ${getErrorMessage(err)}`,
        );
      } finally {
        // Scrub the payload from the API heap regardless of outcome.
        scrubMmdsPayload(split.mmdsPayload);
      }
    }

    this.startConsoleWatch(vm, fcEnv.FIRECRACKER_MAX_CONSOLE_BYTES);
    // Hard lifetime ceiling (B2): a host-side, last-resort bound on the
    // guest's wall-clock life. The platform's own safety-net timeout
    // always fires first when the platform is alive — this timer only
    // matters under platform death/partition, where a looping guest would
    // otherwise run forever. Cleared by destroyVm.
    if (agentSpec.maxLifetimeSeconds !== undefined) {
      const maxLifetimeSeconds = agentSpec.maxLifetimeSeconds;
      vm.lifetimeTimer = setTimeout(() => {
        logger.error("microVM exceeded its hard lifetime ceiling — killing", {
          runId: handle.runId,
          maxLifetimeSeconds,
        });
        vm.stopping = true;
        vm.teardownReason = "max-lifetime";
        void this.killVm(vm, 0).catch(() => {});
      }, maxLifetimeSeconds * 1000);
    }
    proc.exited.then((code) => {
      if (vm.consoleWatch) clearInterval(vm.consoleWatch);
      // Reaper anchor (ROB-1): the exit reaper destroys records whose
      // stamp lingers past EXIT_REAP_AFTER_MS — i.e. exits no platform
      // ever claimed because it died mid-run.
      vm.exitedAt = Date.now();
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
    if (!vm) return;
    // Latch BEFORE the proc check (B4): a cancel landing in the boot
    // window (record exists, VMM not spawned yet) must not be a silent
    // no-op — startWorkload rechecks this latch right after spawn and
    // kills the just-spawned VMM.
    vm.stopping = true;
    if (!vm.proc) return;
    await this.killVm(vm, timeoutSeconds);
  }

  async removeWorkload(handle: WorkloadHandle): Promise<void> {
    // Both roles share the VM. The first remove kills it; the boundary
    // teardown reclaims TAP/dir. Pending specs are dropped per-role so a
    // re-created workload can't accidentally reuse stale env.
    const vm = this.vms.get(handle.runId);
    if (vm) {
      // Latch whenever the record exists (B4) — see stopWorkload.
      vm.stopping = true;
      if (vm.proc) await this.killVm(vm, 0).catch(() => {});
    }
    if (handle.role === "sidecar") this.pendingSidecarEnv.delete(handle.runId);
    else this.pendingAgentSpecs.delete(handle.runId);
  }

  async waitForExit(handle: WorkloadHandle): Promise<number> {
    const vm = this.vms.get(handle.runId);
    if (!vm?.proc) return 1;
    // Race the exit against the D-state abandon signal: after a timeout or
    // cancel, killVm SIGKILLs and reaps with a bound — but a VMM wedged in
    // an uninterruptible KVM/block ioctl never settles `exited`, and this
    // is the promise pi.ts blocks the whole run on. When killVm gives up,
    // resolve with the killed/crashed semantics instead of hanging.
    const outcome = await Promise.race([
      vm.proc.exited.then(
        () => "exited" as const,
        () => "exited" as const,
      ),
      vm.reapAbandoned.then(() => "abandoned" as const),
    ]);
    if (outcome === "abandoned") {
      // The leaked VMM cannot have printed an exit marker (the guest is
      // wedged with it) — killed vs crashed is decided by intent.
      return vm.stopping ? 137 : 1;
    }
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
    // Latch BEFORE the proc check (B4): a cancel in the boot window must
    // stick — startWorkload rechecks the latch right after spawn and
    // kills the just-spawned VMM instead of letting the run boot anyway.
    vm.stopping = true;
    // The platform stops a run by id from its stall watchdog (and shares
    // this route with user cancel) — record it so the eventual teardown
    // log attributes the kill instead of mislabelling it a clean finalize.
    vm.teardownReason = "watchdog-kill";
    if (!vm.proc) return "already_stopped";
    await this.killVm(vm, timeoutSeconds ?? 5);
    return "stopped";
  }

  async resolvePlatformApiUrl(): Promise<string> {
    // Remote-platform mode (appstrate-runner): the platform is NOT this
    // process — advertise the operator-provided URL verbatim, no
    // lo-alias/PORT computation.
    if (this.platformApiUrlOverride !== undefined) return this.platformApiUrlOverride;
    const fcEnv = getFirecrackerEnv();
    return `http://${platformAliasIp(fcEnv.FIRECRACKER_SUBNET_CIDR)}:${loAliasPlatformPort()}`;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Spawn the VMM — jailed (production default: chroot + per-VM uid +
   * cgroup bounds via the upstream jailer) or direct
   * (FIRECRACKER_JAILER=off, dev). Both paths share one process
   * contract: the returned handle's pid IS the VMM (the jailer exec()s
   * firecracker in-process — no --daemonize, no --new-pid-ns; see
   * jail.ts for why both flags would break that), stdout is the serial
   * console, `proc.exited` is the VMM exit.
   */
  private async spawnVmm(
    vm: VmRecord,
    configDrivePath: string,
    sizing: { vcpuCount: number; memSizeMib: number },
    mmds: { payloadBytes: number } | null,
  ): Promise<BunProcess> {
    const argv = vm.jail
      ? await this.prepareJailedSpawn(vm, vm.jail, configDrivePath, sizing, mmds)
      : await this.prepareDirectSpawn(vm, configDrivePath, sizing, mmds);
    // Firecracker refuses to bind over an existing socket file (stale from
    // a crashed predecessor that shared the pid+index pair).
    await rm(vm.apiSocketPath, { force: true }).catch(() => {});
    return Bun.spawn(argv, {
      cwd: vm.runDir,
      // Serial console (guest kernel + supervisor + workload stdout)
      // lands in one append-only file; streamLogs tails it.
      stdout: Bun.file(vm.consolePath),
      stderr: "pipe",
    });
  }

  /**
   * MMDS store-size flags for the firecracker argv. Firecracker bounds
   * both the in-VMM store (`--mmds-size-limit`, default = the HTTP API
   * payload cap) and the PUT body itself (`--http-api-max-payload-size`,
   * default 51200) — a brokered payload above the default needs BOTH
   * raised or the credential PUT 400s and the run fail-closes for the
   * wrong reason. The startWorkload ceiling has already bounded
   * `payloadBytes` by FIRECRACKER_MMDS_MAX_BYTES.
   */
  private mmdsSpawnArgs(mmds: { payloadBytes: number } | null): string[] {
    if (!mmds) return [];
    const needed = mmds.payloadBytes + MMDS_SAFETY_MARGIN_BYTES;
    if (needed <= MMDS_STORE_LIMIT_BYTES) return [];
    return ["--mmds-size-limit", String(needed), "--http-api-max-payload-size", String(needed)];
  }

  /** Direct (unjailed) spawn plan — host-absolute paths, dev only. */
  private async prepareDirectSpawn(
    vm: VmRecord,
    configDrivePath: string,
    sizing: { vcpuCount: number; memSizeMib: number },
    mmds: { payloadBytes: number } | null,
  ): Promise<string[]> {
    const fcEnv = getFirecrackerEnv();
    const vmConfig = buildVmConfig({
      kernelPath: resolve(fcEnv.FIRECRACKER_KERNEL_PATH),
      rootfsPath: resolve(fcEnv.FIRECRACKER_ROOTFS_PATH),
      configDrivePath,
      bootArgs: buildKernelBootArgs(vm.subnet),
      subnet: vm.subnet,
      vcpuCount: sizing.vcpuCount,
      memSizeMib: sizing.memSizeMib,
      mmds: mmds !== null,
    });
    const vmConfigPath = join(vm.runDir, "vmconfig.json");
    await writeFile(vmConfigPath, JSON.stringify(vmConfig, null, 2), { mode: 0o600 });
    return [
      fcEnv.FIRECRACKER_BIN,
      ...this.mmdsSpawnArgs(mmds),
      "--api-sock",
      vm.apiSocketPath,
      "--config-file",
      vmConfigPath,
    ];
  }

  /**
   * Jailed spawn plan: populate the chroot (hardlinked shared artifacts,
   * moved per-run secret config drive, chroot-relative vmconfig) and
   * build the jailer argv. Every path the VM config references is
   * CHROOT-relative — firecracker resolves them after pivot_root.
   */
  private async prepareJailedSpawn(
    vm: VmRecord,
    jail: JailPaths,
    configDrivePath: string,
    sizing: { vcpuCount: number; memSizeMib: number },
    mmds: { payloadBytes: number } | null,
  ): Promise<string[]> {
    const fcEnv = getFirecrackerEnv();
    await prepareChrootArtifacts(
      {
        rootDir: jail.rootDir,
        kernelPath: resolve(fcEnv.FIRECRACKER_KERNEL_PATH),
        rootfsPath: resolve(fcEnv.FIRECRACKER_ROOTFS_PATH),
      },
      this.jailFs,
    );
    // The config drive is SECRET and per-run: moved (never copied when
    // same-fs), owned by the jail uid, 0400 — only this VMM reads it.
    await placeChrootSecret(
      {
        from: configDrivePath,
        to: join(jail.rootDir, CHROOT_CONFIG_DRIVE_PATH),
        uid: jail.uid,
        gid: jail.gid,
      },
      this.jailFs,
    );
    const vmConfig = buildVmConfig({
      kernelPath: CHROOT_KERNEL_PATH,
      rootfsPath: CHROOT_ROOTFS_PATH,
      configDrivePath: CHROOT_CONFIG_DRIVE_PATH,
      bootArgs: buildKernelBootArgs(vm.subnet),
      subnet: vm.subnet,
      vcpuCount: sizing.vcpuCount,
      memSizeMib: sizing.memSizeMib,
      mmds: mmds !== null,
    });
    await writeChrootVmConfig(
      { rootDir: jail.rootDir, vmConfig, uid: jail.uid, gid: jail.gid },
      this.jailFs,
    );
    return buildJailerArgv({
      jailerBin: this.resolveJailerBinPath(fcEnv),
      fcBin: this.resolveFcBinPath(fcEnv),
      jail,
      ...(this.mmdsSpawnArgs(mmds).length > 0 ? { extraFcArgs: this.mmdsSpawnArgs(mmds) } : {}),
      ...(fcEnv.FIRECRACKER_JAIL_CGROUPS === "on"
        ? {
            cgroups: {
              // Guest RAM + VMM-process slack — a host-protection
              // ceiling (OOM reads as a crash), not workload QoS.
              memoryMaxBytes: (sizing.memSizeMib + JAIL_MEMORY_SLACK_MIB) * 1024 * 1024,
              pidsMax: JAIL_PIDS_MAX,
              // Bounds cpu.max so this VM can use exactly its vCPUs —
              // never the whole host (see buildJailerArgv).
              vcpuCount: sizing.vcpuCount,
            },
          }
        : {}),
    });
  }

  /**
   * Push the run's secrets into the VMM's in-memory MMDS store, with a
   * short retry loop: `PUT /mmds` can transiently fail in the window right
   * after spawn while the VMM binds its API socket. Firecracker allows the
   * PUT before or after boot, so retrying here is safe. Throws after the
   * final attempt — the caller fail-closes the run.
   */
  private async injectMmds(vm: VmRecord, payload: MmdsPayload): Promise<void> {
    const attempts = 5;
    try {
      // Fixed 200ms interval (backoff 1) — the socket-bind window this
      // absorbs is short and constant, unlike teardown's kernel-release
      // races.
      await this.retryOp(() => this.mmdsPut(vm.apiSocketPath, payload), {
        attempts,
        baseMs: 200,
        backoff: 1,
      });
    } catch (err) {
      throw new Error(`MMDS PUT failed after ${attempts} attempts: ${getErrorMessage(err)}`);
    }
  }

  /**
   * Production MMDS PUT — writes the data store over the VMM's unix API
   * socket (same Bun `unix:` fetch extension `killVm` uses for
   * SendCtrlAltDel). In jailed mode `vm.apiSocketPath` is the host-side
   * path inside the chroot (`<root>/run/firecracker.socket`). Firecracker
   * answers `PUT /mmds` with 204 No Content on success.
   */
  private async defaultMmdsPut(apiSocketPath: string, payload: MmdsPayload): Promise<void> {
    const res = await fetch("http://localhost/mmds", {
      method: "PUT",
      // Bun extension — request over the VMM's unix API socket.
      unix: apiSocketPath,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      // A wedged/not-yet-bound VMM must not hang the boot path.
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) {
      throw new Error(`MMDS PUT returned HTTP ${res.status}`);
    }
  }

  /**
   * Attempt a graceful guest shutdown through the VMM API, then kill the
   * VMM process. SendCtrlAltDel is x86_64-only — on aarch64 the call
   * fails and we fall through to the kill, which is acceptable: by the
   * time stop is requested the run is already terminal platform-side.
   *
   * Returns whether the VMM is confirmed gone (no process, exited, or
   * reaped after the SIGKILL) — `false` means the reap was abandoned
   * (D-state) and the process may still hold its TAP fd / cgroup, so the
   * caller's resource cleanup should expect transient failures.
   */
  private async killVm(vm: VmRecord, graceSeconds: number): Promise<boolean> {
    const proc = vm.proc;
    if (!proc) return true;
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
      if (exited) return true;
    }
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already dead.
    }
    // Bounded reap: a VMM wedged in D-state (uninterruptible KVM/block
    // ioctl) survives even SIGKILL until the kernel releases it — an
    // unbounded await here would hang cancel/teardown/shutdown behind
    // one broken VM. Time-box, log loudly, and move on: the leaked
    // process and its resources are reclaimed by the boot-time sweep.
    const reaped = await Promise.race([
      proc.exited.then(
        () => true,
        () => true,
      ),
      new Promise<false>((r) => setTimeout(() => r(false), this.vmmReapTimeoutMs)),
    ]);
    if (!reaped) {
      logger.error(
        "VMM did not reap after SIGKILL — possible D-state; leaking the process, " +
          "its resources will be swept at next boot",
        { runId: vm.runId, pid: proc.pid },
      );
      // Unblock every waiter racing on this signal (waitForExit): the
      // leaked process's `exited` promise may never settle.
      vm.abandonReap();
    }
    return reaped;
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

  /**
   * Scan /proc for the firecracker VMM launched with a given `--api-sock`
   * path — the pre-spawn orphan case where the crashed run's state.json
   * recorded the socket but never the pid. Returns the pid only on POSITIVE
   * identification (argv is a firecracker VMM AND references this exact
   * socket, via {@link pidIsOurVmm}); `null` otherwise, so a run is never
   * killed without it. Fail-closed on a host with no readable /proc.
   */
  private async findVmmByApiSocket(apiSocketPath: string): Promise<number | null> {
    for (const pid of await this.listProcPids()) {
      if (await this.pidIsOurVmm(pid, apiSocketPath)) return pid;
    }
    return null;
  }

  /** Numeric /proc entries; empty on hosts without /proc (fail closed). */
  private async listProcPids(): Promise<number[]> {
    try {
      const dirents = await readdir("/proc", { withFileTypes: true });
      return dirents
        .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
        .map((d) => Number(d.name));
    } catch {
      return []; // No /proc (non-Linux / restricted) — fail closed.
    }
  }

  /**
   * argv[0]'s BASENAME is the configured firecracker binary's basename,
   * or contains "firecracker" — i.e. the process was exec'd as the VMM
   * binary itself. Deliberately argv[0]-only (stricter than
   * {@link pidIsOurVmm}'s full-argv scan): the jail sweep pairs this gate
   * with a per-run identity match, and a full-argv scan would match any
   * process whose ARGUMENTS merely mention a firecracker path — the
   * `bun test …/modules/firecracker/…` runner included — turning the
   * sweep into a self-kill. The configured-basename branch keeps the
   * gate working when FIRECRACKER_BIN points at a renamed binary.
   */
  private async pidLooksLikeVmmBinary(pid: number): Promise<boolean> {
    try {
      const cmdline = await Bun.file(`/proc/${pid}/cmdline`).text();
      const argv0 = cmdline.split("\0")[0] ?? "";
      const base = argv0.split("/").pop() ?? "";
      return (
        base.includes("firecracker") || base === fcExecName(getFirecrackerEnv().FIRECRACKER_BIN)
      );
    } catch {
      return false; // Process already gone.
    }
  }

  /**
   * The `--id` value in a process's argv, or null. The jailer always
   * injects `--id <jailId>` into the firecracker argv it exec()s, so this
   * is a positive PER-RUN identity for jailed VMMs — immune to pid reuse
   * and to same-uid neighbours, unlike a bare uid match.
   */
  private async procJailArgvId(pid: number): Promise<string | null> {
    try {
      const argv = (await Bun.file(`/proc/${pid}/cmdline`).text()).split("\0");
      const flagIndex = argv.indexOf("--id");
      return flagIndex >= 0 ? (argv[flagIndex + 1] ?? null) : null;
    } catch {
      return null;
    }
  }

  /** readlink /proc/<pid>/root — the process's chroot; null when unreadable. */
  private async procRoot(pid: number): Promise<string | null> {
    try {
      return await readlink(`/proc/${pid}/root`);
    } catch {
      return null;
    }
  }

  /** SIGKILL a pid; returns whether the signal landed (false = already dead). */
  private killPid(pid: number): boolean {
    try {
      process.kill(pid, "SIGKILL");
      return true;
    } catch {
      return false; // Already dead.
    }
  }

  /**
   * Scan /proc for firecracker VMMs (argv[0] gate) matching `predicate`,
   * SIGKILL each, and return the count killed. The predicate carries the
   * distinct per-run identity test (jailId/chroot vs under-base prefix);
   * this skeleton owns only the shared scan-gate-kill loop.
   */
  private async killMatchingVmms(predicate: (pid: number) => Promise<boolean>): Promise<number> {
    let killed = 0;
    for (const pid of await this.listProcPids()) {
      if (!(await this.pidLooksLikeVmmBinary(pid))) continue;
      if (!(await predicate(pid))) continue;
      if (this.killPid(pid)) killed++;
    }
    return killed;
  }

  /**
   * Kill a jailed run's VMM by JAIL identity: a process exec'd as the
   * firecracker binary (argv[0] gate — see pidLooksLikeVmmBinary) whose
   * jailer-injected `--id` IS the recorded jailId, or whose /proc root
   * IS the recorded chroot. Both are positive PER-RUN identities immune
   * to pid reuse. Deliberately NO bare-uid branch: a uid match alone
   * would false-kill an unrelated same-uid process (the jail uid range
   * being "reserved" is an operator promise, not a kernel guarantee),
   * and every jailed VMM carries the `--id` in its argv anyway.
   */
  private async sweepJailedVmm(state: RunStateFile): Promise<number> {
    // Contain the chrootPath match key exactly like the jail rm does: a
    // corrupted state.json chrootPath ("/", "/proc/1/root") would otherwise
    // widen the kill to VMMs OUTSIDE this daemon's jail base (procRoot="/"
    // matches every unjailed process). jailId stays a pure equality key
    // against the VMM's own argv — no path, so no containment needed there.
    const jailBase = jailChrootBase(getFirecrackerEnv().FIRECRACKER_DATA_DIR);
    const resolved = state.chrootPath !== undefined ? resolve(state.chrootPath) : null;
    const chrootPath = resolved !== null && resolved.startsWith(jailBase + sep) ? resolved : null;
    if (resolved !== null && chrootPath === null) {
      logger.warn("Orphan sweep: state.json chrootPath resolves outside the jail base — ignoring", {
        runId: state.runId,
        chrootPath: state.chrootPath,
        jailBase,
      });
    }
    const jailId = state.jailId ?? null;
    if (chrootPath === null && jailId === null) return 0;
    return this.killMatchingVmms(async (pid) => {
      const idMatch = jailId !== null && (await this.procJailArgvId(pid)) === jailId;
      const rootMatch = chrootPath !== null && (await this.procRoot(pid)) === chrootPath;
      return idMatch || rootMatch;
    });
  }

  /**
   * Jail-base sweep for residue with NO state file: any firecracker
   * whose /proc root points under OUR chroot base is positively this
   * host's jailed VMM (the base derives from this daemon's data dir,
   * and the host lock forbids a second daemon on it) — kill it, then
   * reclaim every leftover jail dir. Runs at boot only, when nothing
   * legitimate is live yet. Best-effort throughout.
   */
  private async sweepJailBase(): Promise<number> {
    const base = jailChrootBase(getFirecrackerEnv().FIRECRACKER_DATA_DIR);
    // Kill BEFORE reclaiming: removing a live VMM's chroot files would
    // only leak the process (it holds them open), never stop it.
    const killed = await this.killMatchingVmms(async (pid) => {
      const root = await this.procRoot(pid);
      return root !== null && root.startsWith(base + sep);
    });
    try {
      for (const dirent of await readdir(base, { withFileTypes: true })) {
        await rm(join(base, dirent.name), { recursive: true, force: true }).catch(() => {});
      }
    } catch {
      // Base absent — the jailer never ran on this host; nothing to reclaim.
    }
    return killed;
  }

  private async readConsoleTail(
    consolePath: string,
    bytes: number = EXIT_MARKER_SCAN_BYTES,
  ): Promise<string> {
    // Same byte-tail read as readFileTail, but collapses both the absent
    // (null) and unreadable (throw) cases to "" — callers here never need
    // to distinguish a missing console from an empty one.
    return (await this.readFileTail(consolePath, bytes).catch(() => null)) ?? "";
  }

  /**
   * The absolute path a console tail is archived at (phase 4). Sits beside
   * the runs directory — `<FIRECRACKER_DATA_DIR>/../console-archive` — so it
   * survives the per-run workspace deletion.
   */
  private consoleArchiveDir(): string {
    const fcEnv = getFirecrackerEnv();
    return join(resolve(fcEnv.FIRECRACKER_DATA_DIR), "..", "console-archive");
  }

  /**
   * Persist a console tail to the archive, then prune to the most recent
   * {@link CONSOLE_ARCHIVE_MAX_FILES}. Empty tails (a VM that never wrote a
   * console) are skipped. Caller wraps this so a failure only warns —
   * archiving must never fail a teardown.
   */
  private async archiveConsole(runId: string, tail: string): Promise<void> {
    if (tail.length === 0) return;
    const dir = this.consoleArchiveDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, `${runId}.log`), tail, { mode: 0o600 });
    await this.pruneConsoleArchive(dir);
  }

  /** Keep only the most recent {@link CONSOLE_ARCHIVE_MAX_FILES} `.log` files. */
  private async pruneConsoleArchive(dir: string): Promise<void> {
    let names: string[];
    try {
      const dirents = await readdir(dir, { withFileTypes: true });
      names = dirents.filter((d) => d.isFile() && d.name.endsWith(".log")).map((d) => d.name);
    } catch {
      return;
    }
    if (names.length <= CONSOLE_ARCHIVE_MAX_FILES) return;
    const withMtime = await Promise.all(
      names.map(async (name) => {
        try {
          return { name, mtimeMs: (await stat(join(dir, name))).mtimeMs };
        } catch {
          return { name, mtimeMs: 0 };
        }
      }),
    );
    withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
    for (const { name } of withMtime.slice(CONSOLE_ARCHIVE_MAX_FILES)) {
      await rm(join(dir, name), { force: true }).catch(() => {});
    }
  }

  /**
   * Tail of a file, or `null` when it does not exist (distinct from an
   * existing-but-empty console, which returns `""`). Used by
   * {@link readConsole} to distinguish "no console anywhere" (404) from a
   * freshly booted VM whose console is still empty.
   */
  private async readFileTail(path: string, bytes: number): Promise<string | null> {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    const size = file.size;
    const from = Math.max(0, size - bytes);
    return await file.slice(from, size).text();
  }

  /**
   * Boot-phase liveness probe (phase 4). `running` is true only while the
   * daemon still holds a VMM process that has not exited — the platform's
   * heartbeat pump reads this so it never masks a dead VM.
   */
  workloadStatus(handle: WorkloadHandle): { running: boolean } {
    const vm = this.vms.get(handle.runId);
    // `exitCode === null` while the process is alive; a number once reaped.
    const running = vm?.proc != null && vm.proc.exitCode === null;
    return { running };
  }

  /**
   * Console tail for a run (phase 4). Served from the live workspace while
   * the VM runs, else from the post-teardown archive. `null` when neither
   * exists (→ 404). `id` is the runId; it has already been validated
   * against a run-identifier charset by the route.
   */
  async readConsole(id: string, tailBytes: number): Promise<string | null> {
    // Defense in depth: the daemon route guards `:id` with CONSOLE_ID_RE, but
    // the smoke harness drives this engine directly and `id` reaches the
    // filesystem verbatim (join(archiveDir, `${id}.log`) below). Re-validate
    // against the same run-identifier charset — mirror createIsolationBoundary.
    if (!RUN_ID_RE.test(id)) {
      throw new Error(
        `Firecracker orchestrator: console runId "${id}" is outside the safe ` +
          `run-identifier charset — refusing (it reaches the filesystem verbatim)`,
      );
    }
    const bytes = Math.min(Math.max(tailBytes, 1), CONSOLE_MAX_TAIL_BYTES);
    const vm = this.vms.get(id);
    if (vm) {
      const live = await this.readFileTail(vm.consolePath, bytes).catch(() => null);
      if (live !== null) return live;
    }
    const archivePath = join(this.consoleArchiveDir(), `${id}.log`);
    return this.readFileTail(archivePath, bytes).catch(() => null);
  }

  /**
   * The reason to log for a teardown: an explicit stamp from a kill path
   * wins; otherwise a VMM that exited non-zero without an intentional stop
   * crashed, regardless of the caller's cleanup intent.
   */
  private effectiveTeardownReason(vm: VmRecord, reason: TeardownReason): TeardownReason {
    if (vm.teardownReason) return vm.teardownReason;
    const code = vm.proc?.exitCode;
    if (!vm.stopping && code != null && code !== 0) return "crash";
    return reason;
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

  /**
   * Deterministic root for this daemon's VMM API sockets: a short
   * per-data-dir path under tmpdir. Deterministic (not mkdtemp-random) so a
   * successor daemon can find and reclaim sockets a crashed predecessor
   * left behind (cleanupOrphans). Keyed by a hash of the resolved data dir
   * so two daemons with distinct data dirs never share a socket root; the
   * host lock already forbids two daemons on one data dir. Kept SHORT
   * (tmpdir + 12 hex) to stay under the AF_UNIX SUN_LEN cap.
   */
  private socketRoot(): string {
    const dataDir = resolve(getFirecrackerEnv().FIRECRACKER_DATA_DIR);
    const tag = new Bun.CryptoHasher("sha256").update(dataDir).digest("hex").slice(0, 12);
    return join(tmpdir(), `appstrate-fc-${tag}`);
  }

  /** Lazily create the deterministic 0700 API-socket directory. */
  private ensureSocketDir(): Promise<string> {
    // 0700 — only this uid may traverse it. A rejection must not stay
    // cached (it would permanently fail every future run over one transient
    // tmpdir hiccup) — clear and rethrow so the next boundary retries.
    this.socketDirPromise ??= (async () => {
      const dir = this.socketRoot();
      await mkdir(dir, { recursive: true, mode: 0o700 });
      return dir;
    })().catch((err: unknown) => {
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
        // A runaway console is an abnormal, self-inflicted end — attribute
        // the eventual teardown as a crash, not a clean finalize.
        vm.teardownReason = "crash";
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
        // Jail identity (backward-tolerant: absent on pre-jailer state
        // files — the sweep then falls back to the argv identity).
        ...(typeof obj.jailId === "string" ? { jailId: obj.jailId } : {}),
        ...(typeof obj.jailUid === "number" ? { jailUid: obj.jailUid } : {}),
        ...(typeof obj.chrootPath === "string" ? { chrootPath: obj.chrootPath } : {}),
      };
    } catch {
      return null;
    }
  }
}
