// SPDX-License-Identifier: Apache-2.0

/**
 * Boot-time host-hygiene advisory for the `appstrate-runner` daemon.
 *
 * Firecracker's production host-setup guidance (mirrored in
 * docs/architecture/FIRECRACKER.md § Requirements & privileges → "Host
 * hygiene") asks multi-tenant hosts to disable SMT, KSM, and swap. None
 * of these can be fixed from inside the daemon — they are kernel/boot
 * configuration — so violations are surfaced as ONE structured warn log
 * each at boot and never block startup.
 *
 * Every probe is a single sysfs/procfs read through the injectable
 * {@link ReadHostFile} seam (unit-testable without sysfs). A missing or
 * unreadable file — macOS dev, containers without /sys — silently skips
 * that check: absence of the knob is not a violation.
 */

/** Minimal logger shape — matches the runner/platform pino logger call sites. */
export interface HygieneLogger {
  warn(msg: string, data?: Record<string, unknown>): void;
}

/**
 * Reads a host file and returns its text content. Expected to throw on
 * missing/unreadable paths (the checker treats any throw as "skip").
 */
export type ReadHostFile = (path: string) => Promise<string>;

const SMT_CONTROL_PATH = "/sys/devices/system/cpu/smt/control";
const KSM_RUN_PATH = "/sys/kernel/mm/ksm/run";
const PROC_SWAPS_PATH = "/proc/swaps";

const defaultReadHostFile: ReadHostFile = (path) => Bun.file(path).text();

/**
 * Runs the three host-hygiene probes and emits one warn per violation.
 * Never throws; a probe that cannot read its file is silently skipped.
 */
export async function checkHostHygiene(deps: {
  logger: HygieneLogger;
  readHostFile?: ReadHostFile;
}): Promise<void> {
  const { logger, readHostFile = defaultReadHostFile } = deps;

  // SMT: values are on/off/forceoff/notsupported/notimplemented — only a
  // literal "on" means sibling hyperthreads are schedulable (the
  // cross-thread side-channel Firecracker's guide warns about).
  await probe(readHostFile, SMT_CONTROL_PATH, (content) => {
    if (content.trim() === "on") {
      logger.warn(
        "host hygiene: SMT is enabled — guests on sibling hyperthreads can mount cross-thread side-channel attacks. Boot the host with the `nosmt` kernel parameter (or `echo off > /sys/devices/system/cpu/smt/control`). See docs/architecture/FIRECRACKER.md § Host hygiene.",
        { check: "smt", path: SMT_CONTROL_PATH, value: "on" },
      );
    }
  });

  // KSM: "1" (or "2") means same-content page merging is active, which
  // enables cross-VM memory-dedup timing attacks. Only "1" is probed for
  // — that is the documented "run" value; "0" and "2" ("stop and unmerge")
  // are both non-merging states going forward.
  await probe(readHostFile, KSM_RUN_PATH, (content) => {
    if (content.trim() === "1") {
      logger.warn(
        "host hygiene: KSM is enabled — kernel same-page merging leaks guest memory contents across VMs via dedup timing. Disable it: `echo 0 > /sys/kernel/mm/ksm/run`. See docs/architecture/FIRECRACKER.md § Host hygiene.",
        { check: "ksm", path: KSM_RUN_PATH, value: "1" },
      );
    }
  });

  // Swap: /proc/swaps always carries a header line; any further non-empty
  // line is an active swap device, meaning guest memory can hit
  // persistent storage.
  await probe(readHostFile, PROC_SWAPS_PATH, (content) => {
    const devices = content
      .split("\n")
      .slice(1)
      .filter((line) => line.trim().length > 0);
    if (devices.length > 0) {
      logger.warn(
        "host hygiene: swap is active — guest memory (including run credentials) can be written to persistent storage. Disable it: `swapoff -a` and remove swap entries from /etc/fstab. See docs/architecture/FIRECRACKER.md § Host hygiene.",
        { check: "swap", path: PROC_SWAPS_PATH, devices: devices.length },
      );
    }
  });
}

/** Reads `path` and applies `evaluate`; any read failure = silent skip. */
async function probe(
  read: ReadHostFile,
  path: string,
  evaluate: (content: string) => void,
): Promise<void> {
  let content: string;
  try {
    content = await read(path);
  } catch {
    return; // macOS dev, containers, exotic kernels — knob absent, nothing to judge.
  }
  evaluate(content);
}
