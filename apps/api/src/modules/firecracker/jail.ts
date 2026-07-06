// SPDX-License-Identifier: Apache-2.0

/**
 * Per-VM jailer confinement (upstream `jailer` from the Firecracker
 * release): jail-id derivation, per-VM uid allocation, chroot layout +
 * preparation, and the jailer argv builder. Pure path/argv logic plus
 * thin injectable fs ops so everything is unit-testable on macOS
 * without root/KVM.
 *
 * How the jailer runs the VMM (verified against the upstream docs +
 * `src/jailer/src/env.rs`):
 *
 *   - Without `--daemonize` and without `--new-pid-ns` the jailer
 *     `exec()`s firecracker IN-PROCESS after chroot/cgroup/uid setup —
 *     the pid Bun.spawn returns IS the VMM pid, `proc.exited` IS the
 *     VMM exit, and the inherited stdout fd keeps landing in
 *     `console.log`. Both flags are therefore avoided:
 *     `--daemonize` redirects stdio to /dev/null and detaches;
 *     `--new-pid-ns` clone()s a child and the PARENT jailer exits 0
 *     immediately (no waitpid — the child's exit status is never
 *     propagated), which would break `waitForExit` and the crash log.
 *     pid-namespace isolation is deferred until we track the VMM via
 *     the pidfile the jailer writes instead of the spawn handle.
 *
 *   - The jailer creates `<chroot_base>/<exec_name>/<id>/root`, copies
 *     the exec-file into it, mknods /dev/{kvm,net/tun}, creates and
 *     chowns `/`, `/dev`, `/dev/net`, `/run` to uid:gid, then
 *     pivot_root()s and drops to uid/gid. Everything ELSE the VMM
 *     needs (kernel, rootfs, config drive, vmconfig) must be placed
 *     inside `root/` by us BEFORE the spawn — that is what
 *     {@link prepareChrootArtifacts} / {@link placeChrootSecret} /
 *     {@link writeChrootVmConfig} do.
 *
 *   - The jailer does NOT inject a default `--api-sock`; we pass the
 *     conventional chroot-relative `/run/firecracker.socket` after the
 *     `--` separator, and talk to it host-side at
 *     `<root>/run/firecracker.socket`.
 */

import { chmod, chown, copyFile, link, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

/**
 * `--parent-cgroup` for every jailed VMM — one host-visible slice
 * (`/sys/fs/cgroup/appstrate-fc/<jailId>`) grouping all appstrate VMs.
 */
export const JAIL_PARENT_CGROUP = "appstrate-fc";

/**
 * VMM process memory allowance ON TOP of the guest RAM budget
 * (`memSizeMib`): VMM anon memory, virtio queues, jailed exec copy. The
 * cgroup `memory.max` is guest + this slack — an OOM-killed VMM reads as
 * a crash, so the bound is a host-protection ceiling, not workload QoS.
 */
export const JAIL_MEMORY_SLACK_MIB = 256;

/** cgroup `pids.max` for one VMM (vcpu threads + api + vmm ≈ 10; generous). */
export const JAIL_PIDS_MAX = 1000;

/**
 * Chroot-relative paths the VM config references (Firecracker resolves
 * `--config-file` paths inside its pivot_root'ed chroot). Fixed names —
 * whatever the host artifacts are called, they are linked in as these.
 */
export const CHROOT_KERNEL_PATH = "/vmlinux";
export const CHROOT_ROOTFS_PATH = "/rootfs.ext4";
export const CHROOT_CONFIG_DRIVE_PATH = "/config.img";
export const CHROOT_VMCONFIG_PATH = "/vmconfig.json";
/** Conventional in-chroot API socket (`/run` is created + chowned by the jailer). */
export const CHROOT_API_SOCKET_PATH = "/run/firecracker.socket";

/**
 * AF_UNIX sun_path is capped at ~108 bytes; refuse well below it so the
 * error is ours (actionable) rather than Firecracker dying at startup
 * with FailedToBindAndRunHttpServer.
 */
export const MAX_API_SOCKET_PATH_BYTES = 100;

/** Everything a jailed VM needs to know about its confinement. */
export interface JailPaths {
  /** Jailer `--id` — sanitized runId + subnet-index suffix (see {@link deriveJailId}). */
  jailId: string;
  /** Per-VM uid = FIRECRACKER_JAIL_UID_BASE + subnet index. */
  uid: number;
  /** Per-VM gid — same value as {@link uid}. */
  gid: number;
  /** `<chrootBase>` — the jailer `--chroot-base-dir` argument. */
  chrootBaseDir: string;
  /** `<chrootBase>/<execName>/<jailId>` — removed wholesale at teardown. */
  jailDir: string;
  /** `<jailDir>/root` — becomes the VMM's pivot_root. */
  rootDir: string;
  /** Host-side path of the VMM API socket (`<rootDir>/run/firecracker.socket`). */
  apiSocketHostPath: string;
}

/**
 * Chroot base for every jail on this host: a SIBLING of the runs dir
 * (`<FIRECRACKER_DATA_DIR>/../jail`) so it lives on the same filesystem
 * as the runs — and, in the default layout, as the kernel/rootfs
 * artifacts, which MUST share a filesystem with the jail (they are
 * hardlinked in, never copied — the rootfs is >1 GiB).
 */
export function jailChrootBase(dataDir: string): string {
  return join(resolve(dataDir), "..", "jail");
}

/**
 * Jailer ids must match `^[a-zA-Z0-9-]{1,64}$` (stricter than our
 * RUN_ID_RE, which also admits `_` and `.`). The id is a SHORT digest of
 * the runId, not the runId itself: the jailId rides the host-side API
 * socket path (`<base>/<exec>/<jailId>/root/run/firecracker.socket`),
 * which AF_UNIX caps at ~108 bytes — a real `run_<uuid>` id (40 chars)
 * under the production data dir (`/var/lib/appstrate-runner/runs`)
 * blows the cap and would refuse 100% of jailed runs. The digest also
 * collision-proofs runs whose ids only differ outside the jailer
 * charset (`run_1` / `run.1`); the subnet index — unique among this
 * host's live VMs — is appended as a second guarantee. The runId →
 * jailId mapping is persisted in the run's state.json.
 */
export function deriveJailId(runId: string, subnetIndex: number): string {
  const digest = new Bun.CryptoHasher("sha256").update(runId).digest("hex").slice(0, 12);
  return `fc-${digest}-${subnetIndex}`;
}

/**
 * Guard the host-side API socket path against the AF_UNIX sun_path cap.
 * Called at boundary creation so a too-deep FIRECRACKER_DATA_DIR fails
 * the run with a clear operator error before any VMM spawns.
 */
export function assertApiSocketPathLength(hostPath: string): void {
  const bytes = Buffer.byteLength(hostPath);
  if (bytes >= MAX_API_SOCKET_PATH_BYTES) {
    throw new Error(
      `Firecracker jail: the VMM API socket host path is ${bytes} bytes ` +
        `(>= ${MAX_API_SOCKET_PATH_BYTES}; AF_UNIX caps sun_path at ~108) — ` +
        `"${hostPath}". Point FIRECRACKER_DATA_DIR at a shorter path (the jail ` +
        `lives at <FIRECRACKER_DATA_DIR>/../jail/<vmm-name>/<jailId>/root/run/…).`,
    );
  }
}

export interface ComputeJailPathsInput {
  dataDir: string;
  /**
   * Basename of the firecracker binary — the jailer nests chroots under
   * `<base>/<exec_file_name>/`, so the layout must be computed with the
   * SAME name the `--exec-file` argument will carry.
   */
  fcExecName: string;
  runId: string;
  subnetIndex: number;
  uidBase: number;
}

/**
 * Resolve one run's complete jail layout. Pure; throws only on the API
 * socket length guard (see {@link assertApiSocketPathLength}).
 */
export function computeJailPaths(input: ComputeJailPathsInput): JailPaths {
  const jailId = deriveJailId(input.runId, input.subnetIndex);
  const chrootBaseDir = jailChrootBase(input.dataDir);
  const jailDir = join(chrootBaseDir, input.fcExecName, jailId);
  const rootDir = join(jailDir, "root");
  const apiSocketHostPath = join(rootDir, CHROOT_API_SOCKET_PATH);
  assertApiSocketPathLength(apiSocketHostPath);
  const uid = input.uidBase + input.subnetIndex;
  return { jailId, uid, gid: uid, chrootBaseDir, jailDir, rootDir, apiSocketHostPath };
}

export interface BuildJailerArgvInput {
  jailerBin: string;
  /** ABSOLUTE path to the firecracker binary (`--exec-file`). */
  fcBin: string;
  jail: Pick<JailPaths, "jailId" | "uid" | "gid" | "chrootBaseDir">;
  /**
   * cgroup-v2 bounds, or undefined when FIRECRACKER_JAIL_CGROUPS=off
   * (the jailer fails HARD when the cgroup files cannot be written —
   * hosts without cgroup-v2 delegation need the escape hatch without
   * losing the jail itself).
   */
  cgroups?: { memoryMaxBytes: number; pidsMax: number };
  /**
   * Extra flags forwarded to the exec'd firecracker (after the `--`
   * separator, before the fixed api-sock/config-file pair) — e.g. the
   * MMDS store-size overrides when a run's brokered payload exceeds the
   * 50 KiB Firecracker default.
   */
  extraFcArgs?: string[];
}

/**
 * Full jailer argv. Everything after `--` is forwarded verbatim to the
 * exec'd firecracker (which also receives a jailer-injected `--id`);
 * paths there are chroot-relative.
 *
 * No `--daemonize` / `--new-pid-ns` — see the module doc-comment: both
 * detach the VMM from the Bun.spawn handle (`--new-pid-ns`'s parent
 * exits 0 without waitpid), breaking exit propagation + console capture.
 *
 * No `--netns` either: the TAP stays on the host and the nft model is
 * unchanged in this pass — per-VM netns is deferred until the
 * snapshot-clone work needs it, and the unprivileged jail uid cannot
 * touch host network config anyway.
 */
export function buildJailerArgv(input: BuildJailerArgvInput): string[] {
  const argv = [
    input.jailerBin,
    "--id",
    input.jail.jailId,
    "--exec-file",
    input.fcBin,
    "--uid",
    String(input.jail.uid),
    "--gid",
    String(input.jail.gid),
    "--chroot-base-dir",
    input.jail.chrootBaseDir,
  ];
  if (input.cgroups) {
    argv.push(
      "--parent-cgroup",
      JAIL_PARENT_CGROUP,
      "--cgroup-version",
      "2",
      "--cgroup",
      `memory.max=${input.cgroups.memoryMaxBytes}`,
      "--cgroup",
      `pids.max=${input.cgroups.pidsMax}`,
    );
  }
  return [
    ...argv,
    "--",
    ...(input.extraFcArgs ?? []),
    "--api-sock",
    CHROOT_API_SOCKET_PATH,
    "--config-file",
    CHROOT_VMCONFIG_PATH,
  ];
}

/**
 * Enforce upstream's hard requirement that `jailer` and `firecracker`
 * come from the SAME release: compare the semver each `--version` line
 * reports and throw when they differ. An env override pointing at a
 * mismatched pair (bypassing the installer's lockstep) would otherwise
 * only surface as an opaque first-run failure. Lines whose version
 * cannot be parsed are rejected too — an unparseable probe is not proof
 * of parity.
 */
export function assertJailerVersionParity(fcVersionLine: string, jailerVersionLine: string): void {
  const fc = /v?(\d+\.\d+\.\d+)/.exec(fcVersionLine)?.[1];
  const jailer = /v?(\d+\.\d+\.\d+)/.exec(jailerVersionLine)?.[1];
  if (!fc || !jailer || fc !== jailer) {
    throw new Error(
      `Firecracker jailer: version parity check failed — firecracker reports ` +
        `"${fcVersionLine}" and jailer reports "${jailerVersionLine}". The two binaries ` +
        `MUST come from the same upstream release; reinstall them together ` +
        `(\`appstrate runner install\` keeps them in lockstep).`,
    );
  }
}

/**
 * Thin injectable fs surface for the chroot prep — production is
 * node:fs/promises verbatim; unit tests fake it (chown to an
 * unallocated uid needs root, hardlinks need same-fs fixtures).
 */
export interface JailFs {
  mkdir(path: string, opts: { recursive: boolean; mode: number }): Promise<unknown>;
  link(existing: string, dest: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  chown(path: string, uid: number, gid: number): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rm(path: string, opts: { recursive?: boolean; force: boolean }): Promise<void>;
  writeFile(path: string, data: string, opts: { mode: number }): Promise<void>;
}

export const defaultJailFs: JailFs = { mkdir, link, rename, copyFile, chown, chmod, rm, writeFile };

/** Rethrow a hardlink EXDEV as the actionable same-filesystem operator error. */
function rethrowLinkError(err: unknown, from: string, to: string): never {
  if ((err as NodeJS.ErrnoException).code === "EXDEV") {
    throw new Error(
      `Firecracker jail: cannot hardlink "${from}" into the chroot ("${to}") — ` +
        `the jail directory and the guest artifacts live on DIFFERENT filesystems ` +
        `(link(2) EXDEV). The jail root (<FIRECRACKER_DATA_DIR>/../jail) must share ` +
        `a filesystem with FIRECRACKER_KERNEL_PATH / FIRECRACKER_ROOTFS_PATH: keep ` +
        `the artifacts beside the data dir, or move FIRECRACKER_DATA_DIR onto the ` +
        `artifacts' filesystem (a >1 GiB rootfs is never copied per run).`,
    );
  }
  throw err;
}

/**
 * Create the chroot root and hardlink the SHARED read-only artifacts
 * into it under their fixed chroot names. Never copies: the artifacts
 * are root:root 0644 (enforced at initialize()) — world-readable, not
 * secret — and shared by every concurrent VM's chroot via link count.
 */
export async function prepareChrootArtifacts(
  opts: { rootDir: string; kernelPath: string; rootfsPath: string },
  fs: JailFs = defaultJailFs,
): Promise<void> {
  await fs.mkdir(opts.rootDir, { recursive: true, mode: 0o700 });
  const links: Array<[string, string]> = [
    [opts.kernelPath, join(opts.rootDir, CHROOT_KERNEL_PATH)],
    [opts.rootfsPath, join(opts.rootDir, CHROOT_ROOTFS_PATH)],
  ];
  for (const [from, to] of links) {
    // Stale link from a crashed predecessor sharing the jailId — replace.
    await fs.rm(to, { force: true });
    try {
      await fs.link(from, to);
    } catch (err) {
      rethrowLinkError(err, from, to);
    }
  }
}

/**
 * Move the per-run SECRET config drive from the run dir into the chroot
 * and hand it to the jail uid, mode 0400 (only the VMM reads it).
 * rename(2) first (no second copy of the secrets); when the run dir is
 * on a different filesystem (tmpfs FIRECRACKER_DATA_DIR) fall back to
 * copy+delete — the image is small (~1-2 MiB), unlike the artifacts.
 */
export async function placeChrootSecret(
  opts: { from: string; to: string; uid: number; gid: number },
  fs: JailFs = defaultJailFs,
): Promise<void> {
  await fs.rm(opts.to, { force: true });
  try {
    await fs.rename(opts.from, opts.to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await fs.copyFile(opts.from, opts.to);
    await fs.rm(opts.from, { force: true });
  }
  await fs.chown(opts.to, opts.uid, opts.gid);
  await fs.chmod(opts.to, 0o400);
}

/**
 * Write the per-run Firecracker `--config-file` JSON inside the chroot,
 * owned by the jail uid (firecracker parses it AFTER the privilege
 * drop). Not secret (paths, boot args, TAP name) but scoped anyway.
 */
export async function writeChrootVmConfig(
  opts: { rootDir: string; vmConfig: Record<string, unknown>; uid: number; gid: number },
  fs: JailFs = defaultJailFs,
): Promise<void> {
  const path = join(opts.rootDir, CHROOT_VMCONFIG_PATH);
  await fs.writeFile(path, JSON.stringify(opts.vmConfig, null, 2), { mode: 0o600 });
  await fs.chown(path, opts.uid, opts.gid);
  await fs.chmod(path, 0o400);
}

/**
 * Reclaim one run's jail tree (`<base>/<exec>/<jailId>`): hardlinks drop
 * a link count (artifacts untouched), the exec copy / config drive /
 * socket die with the tree. Idempotent, force.
 */
export async function removeJailDir(jailDir: string, fs: JailFs = defaultJailFs): Promise<void> {
  await fs.rm(jailDir, { recursive: true, force: true });
}

/** Basename helper — the exec name the jailer nests chroots under. */
export function fcExecName(fcBin: string): string {
  return basename(fcBin);
}
