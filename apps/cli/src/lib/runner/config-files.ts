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
  RUNNER_DATA_DIR,
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
    `FIRECRACKER_KERNEL_PATH=${paths.kernelPath}`,
    `FIRECRACKER_ROOTFS_PATH=${paths.rootfsPath}`,
    `FIRECRACKER_DATA_DIR=${paths.runsDir}`,
    "",
  ];
  return lines.join("\n");
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
    "",
    "[Service]",
    "Type=simple",
    "User=root",
    `ExecStart=${RUNNER_BIN_PATH}`,
    `EnvironmentFile=${RUNNER_ENV_PATH}`,
    // sbin dirs + the data-dir bin (pinned firecracker) so bare-name spawns resolve.
    `Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${config.dataDir}/bin`,
    `WorkingDirectory=${config.dataDir}`,
    "Restart=always",
    "RestartSec=2",
    "TimeoutStopSec=30",
    "LimitNOFILE=65536",
    "",
    "# --- Hardening (see renderRunnerUnit doc-comment for why the aggressive",
    "#     device/network knobs are intentionally omitted) ---",
    "ProtectSystem=strict",
    `ReadWritePaths=${config.dataDir}`,
    "ProtectHome=true",
    "ProtectClock=true",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

/** A firewall's toolset was detected; render the exact allow commands. */
export interface FirewallCommands {
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

/** Default install config skeleton (token filled in by the caller). */
export function defaultRunnerConfig(overrides: Partial<RunnerConfig>): RunnerConfig {
  return {
    token: overrides.token ?? "",
    platformUrl: overrides.platformUrl ?? "",
    port: overrides.port ?? 3100,
    host: overrides.host ?? "0.0.0.0",
    dataDir: overrides.dataDir ?? RUNNER_DATA_DIR,
  };
}

/** Re-export for callers that only need the service name string. */
export { RUNNER_SERVICE_NAME };
