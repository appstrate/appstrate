// SPDX-License-Identifier: Apache-2.0

/**
 * Pure renderers + parsers for the two files `runner install` writes: the
 * daemon EnvironmentFile (`/etc/appstrate-runner/env`, 0600) and the
 * hardened systemd unit. Plus token generation and firewall-command
 * synthesis. All pure so unit tests can snapshot the exact bytes.
 */

import { randomBytes } from "node:crypto";
import {
  RUNNER_BIN_PATH,
  RUNNER_ENV_PATH,
  RUNNER_SERVICE_NAME,
  runnerDataPaths,
} from "./constants.ts";

/** Config captured at install time and rendered into the two files. */
export interface RunnerConfig {
  /** Shared bearer secret (48 hex chars). */
  token: string;
  /** Guest-visible platform URL — IPv4 literal (guests have no DNS). */
  platformUrl: string;
  /** Daemon listen port. */
  port: number;
  /** Bind address (default 0.0.0.0). */
  host: string;
  /** State root — kernel/rootfs/runs/firecracker all live under here. */
  dataDir: string;
  /**
   * Guest-artifact release the daemon pins at boot (FIRECRACKER_ARTIFACTS_VERSION).
   * Set to the daemon binary's own version so the kernel/rootfs are fetched from
   * the SAME release — a daemon and its guest artifacts MUST speak one guest
   * protocol. Left undefined for a dev ("latest") install, where the daemon
   * tracks the latest release to match a latest binary.
   */
  artifactsVersion?: string;
}

/**
 * Generate a fresh runner token: 24 random bytes → 48 lowercase hex chars.
 * Comfortably above the daemon's `min(16)` floor and printed exactly once
 * at install time.
 */
export function generateRunnerToken(): string {
  return randomBytes(24).toString("hex");
}

/**
 * Render the daemon EnvironmentFile. Systemd's EnvironmentFile format is
 * `KEY=value`, one per line, no `export`, no quoting needed for our values
 * (hex token, IPv4 URL, integer port, absolute paths — none contain spaces
 * or shell metacharacters).
 *
 * The FIRECRACKER_* paths are pinned to ABSOLUTE paths under the data dir
 * rather than left at their cwd-relative defaults: under systemd the
 * working directory is `/`, so `./data/firecracker/*` would resolve to
 * `/data/firecracker/*`. Pinning them here is what decouples the
 * `bun build --compile`d daemon from its launch cwd.
 */
export function renderRunnerEnvFile(config: RunnerConfig): string {
  const paths = runnerDataPaths(config.dataDir);
  const lines = [
    "# Managed by `appstrate runner install` — edit with care.",
    "# Regenerate with `appstrate runner install` (existing token is preserved).",
    "",
    "# --- Daemon listen/link surface (runner/env.ts) ---",
    `FIRECRACKER_RUNNER_TOKEN=${config.token}`,
    `FIRECRACKER_RUNNER_PLATFORM_URL=${config.platformUrl}`,
    `FIRECRACKER_RUNNER_HOST=${config.host}`,
    `FIRECRACKER_RUNNER_PORT=${config.port}`,
    "",
    "# --- Engine host config (runner/host-env.ts) — absolute paths so the",
    "#     compiled daemon does not depend on its launch working directory. ---",
    `FIRECRACKER_BIN=${paths.firecrackerBin}`,
    `FIRECRACKER_JAILER_BIN=${paths.jailerBin}`,
    `FIRECRACKER_KERNEL_PATH=${paths.kernelPath}`,
    `FIRECRACKER_ROOTFS_PATH=${paths.rootfsPath}`,
    `FIRECRACKER_DATA_DIR=${paths.runsDir}`,
    // Lock the guest kernel/rootfs to the SAME release as the daemon binary so
    // the two always agree on the guest protocol. Omitted for a dev "latest"
    // install (config.artifactsVersion undefined) — the daemon then tracks the
    // latest release, matching a latest binary.
    ...(config.artifactsVersion
      ? [`FIRECRACKER_ARTIFACTS_VERSION=${config.artifactsVersion}`]
      : []),
    "",
  ];
  return lines.join("\n");
}

/**
 * Surgically upsert (or, for a dev "latest" install, remove) the
 * FIRECRACKER_ARTIFACTS_VERSION pin in an existing EnvironmentFile, preserving
 * every other line — comments, blank lines, and any host-specific tuning an
 * operator added — verbatim. `runner update` uses this after swapping the
 * daemon binary so the guest-artifact release stays locked to the newly
 * installed daemon version across a guest-protocol bump, without re-rendering
 * (and thereby wiping) the whole file. `version` undefined strips the pin.
 */
export function withArtifactsVersionPin(envText: string, version: string | undefined): string {
  const KEY = "FIRECRACKER_ARTIFACTS_VERSION";
  const lines = envText.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.trim().startsWith(`${KEY}=`));
  if (version) {
    const line = `${KEY}=${version}`;
    if (idx >= 0) {
      lines[idx] = line;
    } else {
      // Append after the last non-blank line so the pin never lands in a
      // trailing run of blank lines.
      let end = lines.length;
      while (end > 0 && lines[end - 1]!.trim() === "") end--;
      lines.splice(end, 0, line);
    }
  } else if (idx >= 0) {
    lines.splice(idx, 1);
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/**
 * Parse an EnvironmentFile back into a key/value map. Tolerant of comments
 * and blank lines. Used by `doctor` / `update` to recover the token and
 * port from a prior install without re-prompting.
 */
export function parseRunnerEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    out[key] = value;
  }
  return out;
}

/**
 * Render the hardened systemd unit.
 *
 * Privilege model: the unit runs as root because the DAEMON needs it —
 * jailer chroot/uid-drop, TAP creation, nftables, sysctl, /dev/kvm. The
 * VMMs themselves do NOT run as root: with FIRECRACKER_JAILER=on (the
 * default) each firecracker process is chrooted and dropped to an
 * unprivileged per-VM uid (FIRECRACKER_JAIL_UID_BASE + subnet index)
 * with cgroup bounds, so a VMM escape lands on a uid that owns nothing
 * but its own jail.
 *
 * Hardening is deliberately CONSERVATIVE: the daemon is a privileged
 * process by necessity (it opens /dev/kvm, creates TAP devices, writes
 * nftables, and toggles net.ipv4.ip_forward), so the aggressive sandbox
 * knobs that would break those (PrivateDevices, ProtectKernelTunables,
 * RestrictAddressFamilies, PrivateNetwork) are intentionally NOT set —
 * each is called out below. What we DO apply is the read-only-root +
 * scoped-writable-state posture, which is safe for a KVM host daemon:
 *
 *   - ProtectSystem=strict     → the whole FS is read-only except /dev,
 *                                /proc, /sys and ReadWritePaths. sysctl
 *                                writes go to /proc/sys (NOT covered by
 *                                ProtectSystem — that's ProtectKernelTunables,
 *                                left at its writable default), and /dev/kvm
 *                                + /dev/net/tun stay writable.
 *   - ReadWritePaths=<dataDir> → the only writable tree: kernel, rootfs,
 *                                per-run dirs, the firecracker binary.
 *   - ProtectHome=true         → the daemon never touches /home.
 *   - Restart=always           → survive a crash-loop while a host operator
 *                                fixes config; RestartSec bounds the churn.
 *   - Environment=PATH=…sbin…  → `ip`/`nft`/`sysctl`/`mkfs.ext4`/`debugfs`
 *                                are invoked by BARE NAME and usually live
 *                                in /usr/sbin://sbin, which systemd's default
 *                                unit PATH omits. Without this the daemon
 *                                spawns fail with ENOENT at first run.
 */
export function renderRunnerUnit(config: RunnerConfig): string {
  return [
    "[Unit]",
    "Description=Appstrate Firecracker runner daemon",
    "Documentation=https://github.com/appstrate/appstrate/blob/main/docs/architecture/FIRECRACKER.md",
    "After=network-online.target",
    "Wants=network-online.target",
    // Bound the Restart=always loop (RestartSec=2): up to 30 starts / 300s, then
    // systemd parks the unit in `failed` — long enough to ride out a transient
    // first-boot network blip (~10 min of 2s-spaced retries) but not an endless
    // spin on a FatalArtifactsError (bad/missing guest artifacts, exit 1).
    // StartLimit* live in [Unit] on modern systemd (moved out of [Service] in v230).
    "StartLimitIntervalSec=300",
    "StartLimitBurst=30",
    "",
    "[Service]",
    "Type=simple",
    "User=root",
    // `+` runs OUTSIDE the sandbox (privileged, ignores ProtectSystem): pre-create
    // /run/netns so the boot net-probe's `ip netns add` has a writable parent on a
    // host where `ip netns` has never run (ReadWritePaths on a missing dir is a no-op).
    "ExecStartPre=+/bin/mkdir -p /run/netns",
    `ExecStart=${RUNNER_BIN_PATH}`,
    `EnvironmentFile=${RUNNER_ENV_PATH}`,
    // sbin dirs + the data-dir bin (pinned firecracker) so bare-name spawns resolve.
    `Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${config.dataDir}/bin`,
    `WorkingDirectory=${config.dataDir}`,
    "Restart=always",
    "RestartSec=2",
    "TimeoutStopSec=30",
    "LimitNOFILE=65536",
    // cgroup-v2 delegation: the jailer creates one slice per VM under
    // /sys/fs/cgroup/appstrate-fc/<jailId> (memory.max / pids.max) —
    // without Delegate systemd may fight the daemon over that subtree.
    "Delegate=yes",
    "",
    "# --- Hardening (see renderRunnerUnit doc-comment for why the aggressive",
    "#     device/network knobs are intentionally omitted) ---",
    "ProtectSystem=strict",
    // ProtectSystem=strict leaves /tmp read-only, but the daemon's deterministic
    // VMM API-socket root lives under tmpdir() — a private writable /tmp is what
    // keeps boundary creation from failing EROFS on socket-root mkdir.
    "PrivateTmp=true",
    `ReadWritePaths=${config.dataDir}`,
    // ProtectSystem=strict also makes /run read-only, but the boot net-probe's
    // `ip netns add` writes under /run/netns — carve just that path writable
    // (paired with the ExecStartPre above that guarantees the dir exists).
    "ReadWritePaths=/run/netns",
    "ProtectHome=true",
    "ProtectClock=true",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

/** A firewall's toolset was detected; render the exact allow commands. */
interface FirewallCommands {
  tool: "ufw" | "firewalld" | "none";
  commands: string[];
}

/**
 * Synthesize the exact firewall commands to open the daemon port for the
 * platform, given which firewall is installed. Guest→host traffic stays on
 * the host's own TAP/nft path (set up by the daemon) and never crosses ufw
 * / firewalld, so the only inbound rule an operator needs is the daemon
 * port itself — that is the single most common "the platform can't reach my
 * runner" cause.
 */
export function firewallCommands(
  tool: "ufw" | "firewalld" | "none",
  port: number,
): FirewallCommands {
  if (tool === "ufw") {
    return { tool, commands: [`ufw allow ${port}/tcp comment 'appstrate-runner'`] };
  }
  if (tool === "firewalld") {
    return {
      tool,
      commands: [`firewall-cmd --permanent --add-port=${port}/tcp`, "firewall-cmd --reload"],
    };
  }
  return {
    tool: "none",
    commands: [
      `# No ufw/firewalld detected. If a firewall is active, open TCP ${port} to the platform host.`,
    ],
  };
}

/** Re-export for callers that only need the service name string. */
export { RUNNER_SERVICE_NAME };
