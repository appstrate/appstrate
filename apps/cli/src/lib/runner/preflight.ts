// SPDX-License-Identifier: Apache-2.0

/**
 * Host preflight for `appstrate runner install` / `runner doctor`.
 *
 * Mirrors the checks the orchestrator performs at `initialize()` (Linux,
 * /dev/kvm read+write, arch) plus the two host binaries the daemon shells
 * out to for its network setup (`nft`, `ip`) — so a host that fails
 * preflight would have crash-looped the daemon anyway. Each failed check
 * carries an actionable remedy: the whole point is to turn "the daemon
 * won't start and I don't know why" into a one-line fix at install time.
 *
 * Pure over injected probes (no direct `process` / `fs` reads) so the full
 * pass/fail matrix is unit-testable without a real KVM host.
 */

import { resolveRunnerArch, type RunnerArch } from "./constants.ts";
import { defaultRunnerExec, defaultRunnerFs } from "./exec.ts";

export interface PreflightCheck {
  id: string;
  label: string;
  ok: boolean;
  /** One-line detail shown after the status glyph. */
  detail: string;
  /** Actionable fix, shown only when `ok` is false. */
  remedy?: string;
}

export interface PreflightResult {
  ok: boolean;
  arch?: RunnerArch;
  checks: PreflightCheck[];
}

export interface PreflightDeps {
  platform?: NodeJS.Platform;
  arch?: string;
  /** `/dev/kvm` open-for-read+write probe. */
  canAccessKvm?: () => Promise<boolean>;
  /** PATH lookup for a host binary. */
  commandExists?: (cmd: string) => boolean;
}

/**
 * Run every host prerequisite check and return a structured, ordered
 * result. Never throws — an unsupported arch is reported as a failed check
 * (not an exception) so `doctor` can render the whole matrix in one pass.
 */
export async function runPreflight(deps: PreflightDeps = {}): Promise<PreflightResult> {
  const platform = deps.platform ?? process.platform;
  const rawArch = deps.arch ?? process.arch;
  const canAccessKvm = deps.canAccessKvm ?? (() => defaultRunnerFs.canReadWrite("/dev/kvm"));
  const commandExists = deps.commandExists ?? ((cmd: string) => defaultRunnerExec.exists(cmd));

  const checks: PreflightCheck[] = [];

  // 1. Operating system — the daemon drives KVM/TAP/nftables, all Linux-only.
  const isLinux = platform === "linux";
  checks.push({
    id: "os",
    label: "Operating system",
    ok: isLinux,
    detail: isLinux ? "Linux" : `${platform} (unsupported)`,
    remedy: isLinux
      ? undefined
      : "The runner daemon requires a Linux KVM host. On macOS, develop inside the Lima VM " +
        "(bun run test:firecracker) — a production runner must be a real Linux host.",
  });

  // 2. Architecture — we publish x86_64 + aarch64 daemon binaries only.
  let arch: RunnerArch | undefined;
  try {
    arch = resolveRunnerArch(rawArch);
    checks.push({ id: "arch", label: "Architecture", ok: true, detail: arch });
  } catch (err) {
    checks.push({
      id: "arch",
      label: "Architecture",
      ok: false,
      detail: `${rawArch} (unsupported)`,
      remedy: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. /dev/kvm — must be present AND openable r/w by this uid (kvm group).
  //    Only meaningful on Linux; skip the probe elsewhere (the OS check
  //    already failed) to avoid a misleading second failure line.
  if (isLinux) {
    const kvmOk = await canAccessKvm();
    checks.push({
      id: "kvm",
      label: "/dev/kvm",
      ok: kvmOk,
      detail: kvmOk ? "present, read+write" : "missing or not writable",
      remedy: kvmOk
        ? undefined
        : "KVM is unavailable or this user cannot open /dev/kvm. Confirm the host exposes " +
          "nested virtualization, load the module (`modprobe kvm_intel` / `kvm_amd`), and " +
          "add the runner user to the `kvm` group (this installer runs as root, which is fine).",
    });
  }

  // 4. nftables — the daemon writes the `appstrate_fc` policy table via `nft`.
  const nftOk = commandExists("nft");
  checks.push({
    id: "nft",
    label: "nft (nftables)",
    ok: nftOk,
    detail: nftOk ? "on PATH" : "not found",
    remedy: nftOk
      ? undefined
      : "Install nftables: `apt install nftables` (Debian/Ubuntu), `dnf install nftables` (RHEL), " +
        "or `apk add nftables` (Alpine).",
  });

  // 5. iproute2 — the daemon creates per-run TAP devices via `ip`.
  const ipOk = commandExists("ip");
  checks.push({
    id: "ip",
    label: "ip (iproute2)",
    ok: ipOk,
    detail: ipOk ? "on PATH" : "not found",
    remedy: ipOk
      ? undefined
      : "Install iproute2: `apt install iproute2` / `dnf install iproute` / `apk add iproute2`.",
  });

  return { ok: checks.every((c) => c.ok), arch, checks };
}
