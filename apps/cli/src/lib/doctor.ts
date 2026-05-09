// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate doctor` — list every `appstrate` binary on `$PATH` and report
 * each one's stamped install source, version, and PATH-resolution role.
 *
 * Issue #249, phase 3. Used to:
 *   - Help users debug "why is my upgrade not taking effect" (PATH order).
 *   - Identify dual-install state (curl + bun on the same machine).
 *   - Feed actionable uninstall hints for the channel that's NOT winning.
 *
 * Pure logic with injectable I/O — tests stub `findAppstrateOnPath` +
 * `probeBinary` to assert the rendered output without spawning anything.
 */

import { runCommand } from "./install/os.ts";
import {
  defaultPathScanFs,
  findAppstrateOnPath,
  type PathHit,
  type PathScanFs,
} from "./path-scan.ts";
import { upgradeHint, type InstallSource } from "./install-source.ts";
import { defaultInstallDir, readProjectFile } from "./install/project.ts";

export interface InstallationInfo {
  /** PATH directory containing the binary. */
  pathEntry: string;
  /** Absolute path to the binary in `pathEntry`. */
  binary: string;
  /** Real path after `realpath(2)`, used for dedupe. */
  realPath: string;
  /** Reported version, or `null` if the binary did not respond. */
  version: string | null;
  /** Stamped install source, or `"unknown"` if the binary predates phase 1. */
  source: InstallSource;
  /** Probe error if the binary failed to introspect. */
  probeError?: string;
}

export interface ConnectionProfileCheck {
  /** Profile UUID pinned in the active CLI profile (`connectionProfileId` in config.toml). */
  connectionProfileId: string;
  /** Result status: ok = exists, missing = 404 (warn), unknown = the check could not run (no token / offline / 5xx). */
  status: "ok" | "missing" | "unknown";
  /** Free-form remediation hint surfaced in the rendered report. */
  hint?: string;
}

export interface LocalInstallInfo {
  /** Absolute path to the install directory (defaults to `~/appstrate`). */
  dir: string;
  /** Compose project name read from `<dir>/.appstrate/project.json`. */
  projectName: string;
}

export interface DoctorReport {
  /** All discovered installations in PATH order — first one wins resolution. */
  installations: InstallationInfo[];
  /** Index of the running CLI in `installations`, or `-1` if not on PATH. */
  runningIndex: number;
  /** True when more than one distinct installation was found. */
  dualInstall: boolean;
  /** True when more than one DIFFERENT install source was detected. */
  multiSource: boolean;
  /** Connection-profile health for the active CLI profile, when one is pinned. */
  connectionProfile?: ConnectionProfileCheck;
  /**
   * Local Docker-tier install detected at `~/appstrate` (or wherever
   * `--dir` was last installed). When present, the doctor surfaces the
   * lifecycle command hints (`appstrate logs / stop / uninstall`) so
   * the user doesn't have to memorize the derived project hash.
   */
  localInstall?: LocalInstallInfo;
}

export interface ProbeBinary {
  (
    binary: string,
    timeoutMs: number,
  ): Promise<{ ok: true; version: string; source: InstallSource } | { ok: false; error: string }>;
}

/**
 * Default probe — fork-execs `<binary> __install-source` (a hidden subcommand
 * added in phase 3, see `commands/internal.ts`). Old binaries will fail with
 * "unknown command" → we fall back to `<binary> --version` so we can at least
 * report the version, with `source: "unknown"`.
 */
export const defaultProbeBinary: ProbeBinary = async (binary, timeoutMs) => {
  const probe = await runCommand(binary, ["__install-source"], { timeoutMs });
  if (probe.ok) {
    try {
      const parsed = JSON.parse(probe.stdout) as {
        version?: unknown;
        source?: unknown;
        schema?: unknown;
      };
      const version = typeof parsed.version === "string" ? parsed.version : "";
      const source =
        parsed.source === "curl" || parsed.source === "bun" || parsed.source === "unknown"
          ? parsed.source
          : "unknown";
      if (version) return { ok: true, version, source };
    } catch {
      // fall through to --version probe
    }
  }
  // Older / non-stamped builds: fall back to --version, source unknown.
  const fallback = await runCommand(binary, ["--version"], { timeoutMs });
  if (fallback.ok) {
    return { ok: true, version: fallback.stdout.trim(), source: "unknown" };
  }
  return { ok: false, error: fallback.stderr.trim() || `exit ${fallback.exitCode}` };
};

export interface CheckConnectionProfile {
  (): Promise<ConnectionProfileCheck | null>;
}

export interface RunDoctorOptions {
  pathEnv?: string;
  pathSeparator?: string;
  binaryName?: string;
  pathScanFs?: PathScanFs;
  probeBinary?: ProbeBinary;
  /** Timeout per binary probe — issue #249 specifies 500ms. */
  probeTimeoutMs?: number;
  /** `process.execPath` — used to highlight which entry is the running CLI. */
  execPath?: string;
  /**
   * Optional check for the pinned connection profile. Returns `null` when the
   * active CLI profile has no `connectionProfileId` set (nothing to validate),
   * or a `ConnectionProfileCheck` describing the result. Defaults to a real
   * implementation that reads config + hits `/api/connection-profiles/{id}`.
   * Tests inject a stub.
   */
  checkConnectionProfile?: CheckConnectionProfile;
  /**
   * Override the install-directory probe for tests. Returns the parsed
   * sidecar info when an install is detected at `dir`, or `null`.
   * Defaults to reading `<dir>/.appstrate/project.json` from disk.
   */
  probeLocalInstall?: (dir: string) => Promise<LocalInstallInfo | null>;
  /** Override the install dir probed (defaults to `~/appstrate`). */
  installDir?: string;
}

/**
 * Walk `$PATH`, probe each `appstrate` binary, and return a structured
 * report. Pure with respect to the injected deps — production callers
 * pass `process.env.PATH` + `process.execPath` + the default fs/probe.
 */
export async function runDoctor(opts: RunDoctorOptions = {}): Promise<DoctorReport> {
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const sep = opts.pathSeparator ?? (process.platform === "win32" ? ";" : ":");
  const binaryName = opts.binaryName ?? "appstrate";
  const fs = opts.pathScanFs ?? defaultPathScanFs;
  const probe = opts.probeBinary ?? defaultProbeBinary;
  const timeout = opts.probeTimeoutMs ?? 500;
  const execPath = opts.execPath ?? process.execPath;

  const hits = await findAppstrateOnPath(pathEnv, binaryName, fs, sep);
  const installations: InstallationInfo[] = await Promise.all(
    hits.map(async (h: PathHit) => {
      const result = await probe(h.binary, timeout);
      if (result.ok) {
        return {
          pathEntry: h.pathEntry,
          binary: h.binary,
          realPath: h.realPath,
          version: result.version,
          source: result.source,
        };
      }
      return {
        pathEntry: h.pathEntry,
        binary: h.binary,
        realPath: h.realPath,
        version: null,
        source: "unknown" as const,
        probeError: result.error,
      };
    }),
  );

  // The running CLI may not be on $PATH (e.g. the user invoked it via
  // absolute path). Resolve realpath on BOTH sides: the PATH entry can
  // be a symlink to the real binary, and `execPath` itself can also be
  // a symlink (e.g. a wrapper script in `~/.local/bin` pointing into a
  // brewed cellar). Comparing only one side misses the case where the
  // symlink lives at the running binary path.
  const execRealPath = await fs.realpath(execPath);
  let runningIndex = -1;
  for (let i = 0; i < installations.length; i++) {
    const entry = installations[i]!;
    if (
      entry.binary === execPath ||
      entry.realPath === execPath ||
      entry.realPath === execRealPath
    ) {
      runningIndex = i;
      break;
    }
  }
  const sources = new Set(installations.map((i) => i.source));

  // Connection-profile sanity check — fail soft so an offline doctor still
  // renders the PATH-walk results. The check is opt-in (returns null when
  // nothing is pinned) and isolated from the rest of the report.
  let connectionProfile: ConnectionProfileCheck | undefined;
  const probeProfile = opts.checkConnectionProfile ?? defaultCheckConnectionProfile;
  try {
    const result = await probeProfile();
    if (result) connectionProfile = result;
  } catch {
    // intentional swallow — see ConnectionProfileCheck.status="unknown"
  }

  // Local-install probe (#343) — surfaces the lifecycle command hints
  // when a Docker-tier install exists. Soft-fails on any error: a
  // missing or unreadable sidecar is the normal state for users who
  // never ran `appstrate install`, and must not perturb the rest of
  // the report.
  const installDir = opts.installDir ?? defaultInstallDir();
  const probeLocal = opts.probeLocalInstall ?? defaultProbeLocalInstall;
  let localInstall: LocalInstallInfo | undefined;
  try {
    const found = await probeLocal(installDir);
    if (found) localInstall = found;
  } catch {
    // intentional swallow — sidecar absence is not a doctor finding.
  }

  return {
    installations,
    runningIndex,
    dualInstall: installations.length > 1,
    multiSource: sources.size > 1,
    ...(connectionProfile ? { connectionProfile } : {}),
    ...(localInstall ? { localInstall } : {}),
  };
}

/**
 * Default local-install probe — reads `<dir>/.appstrate/project.json`.
 * Returns `null` for the common "no install at this path" case so the
 * doctor can soft-skip the section.
 */
async function defaultProbeLocalInstall(dir: string): Promise<LocalInstallInfo | null> {
  const file = await readProjectFile(dir);
  if (!file) return null;
  return { dir, projectName: file.projectName };
}

/**
 * Render a `DoctorReport` as plain-text lines. Returns the text rather than
 * printing so the command file can mix it with `@clack/prompts` framing
 * without coupling the formatter to the prompt library.
 */
export function formatDoctorReport(report: DoctorReport, runningExecPath: string): string {
  const lines: string[] = [];
  if (report.installations.length === 0) {
    lines.push(`No \`appstrate\` binary found on $PATH.`);
    lines.push(``);
    lines.push(`Running binary: ${runningExecPath}`);
    return lines.join("\n");
  }

  const count = report.installations.length;
  lines.push(
    count === 1
      ? `Found 1 installation of \`appstrate\` on $PATH:`
      : `Found ${count} installations of \`appstrate\` on $PATH:`,
  );
  lines.push(``);

  // Compute column widths for tidy alignment.
  const maxBin = report.installations.reduce((n, i) => Math.max(n, i.binary.length), 0);
  const maxSrc = report.installations.reduce((n, i) => Math.max(n, i.source.length), 0);

  report.installations.forEach((entry, idx) => {
    const winnerMarker = idx === 0 ? "←" : " ";
    const runningMarker = idx === report.runningIndex ? "★" : " ";
    const versionStr = entry.version ?? "(probe failed)";
    const sourceStr = `[${entry.source}]`;
    lines.push(
      `  ${runningMarker}${winnerMarker} ${entry.binary.padEnd(maxBin)}  ${sourceStr.padEnd(maxSrc + 2)}  ${versionStr}`,
    );
    if (entry.probeError) {
      lines.push(`        probe error: ${entry.probeError}`);
    }
  });

  lines.push(``);
  lines.push(`  ★ = running CLI`);
  lines.push(`  ← = first on $PATH (resolved when you type 'appstrate')`);

  if (report.connectionProfile) {
    lines.push(``);
    const cp = report.connectionProfile;
    if (cp.status === "missing") {
      lines.push(`⚠ Connection profile ${cp.connectionProfileId} is pinned but no longer exists.`);
      if (cp.hint) lines.push(`  ${cp.hint}`);
    } else if (cp.status === "unknown") {
      lines.push(
        `Connection profile ${cp.connectionProfileId} could not be verified (offline or not logged in).`,
      );
    } else {
      lines.push(`Connection profile ${cp.connectionProfileId} is healthy.`);
    }
  }

  if (report.localInstall) {
    lines.push(``);
    lines.push(
      `Local Docker-tier install detected at ${report.localInstall.dir} (project: ${report.localInstall.projectName}).`,
    );
    lines.push(`Manage the stack via:`);
    lines.push(`  • appstrate logs -f         (stream container logs)`);
    lines.push(`  • appstrate status          (compose ps)`);
    lines.push(`  • appstrate stop / start    (containers off / on, volumes intact)`);
    lines.push(`  • appstrate uninstall       (down — data preserved)`);
    lines.push(`  • appstrate uninstall --purge   (down -v + rm <dir>, destructive)`);
  }

  if (report.dualInstall) {
    lines.push(``);
    lines.push(`Multiple installations detected.`);
    if (report.multiSource) {
      lines.push(
        `Different channels are present. To remove the channel that is NOT winning resolution:`,
      );
      const winner = report.installations[0]!;
      const losers = report.installations.slice(1);
      const seen = new Set<string>();
      for (const loser of losers) {
        if (loser.source === winner.source) continue;
        if (seen.has(loser.source)) continue;
        seen.add(loser.source);
        lines.push(`  • ${loser.source} channel → ${upgradeHintRemoval(loser.source)}`);
      }
    } else {
      lines.push(`All installations report the same channel — clean up by hand or via:`);
      lines.push(`  • ${upgradeHintRemoval(report.installations[0]!.source)}`);
    }
  }

  return lines.join("\n");
}

/**
 * Production check: read the active CLI profile from config.toml, return
 * `null` when no `connectionProfileId` is pinned, otherwise look it up via
 * `GET /api/connection-profiles` and surface a remediation hint if it has
 * been deleted server-side. Network/auth errors degrade to `unknown` so an
 * offline machine still gets a complete doctor report.
 */
export const defaultCheckConnectionProfile: CheckConnectionProfile = async () => {
  const { readConfig, resolveProfileName, getProfile } = await import("./config.ts");
  const config = await readConfig();
  const profileName = resolveProfileName(undefined, config);
  const profile = await getProfile(profileName);
  if (!profile?.connectionProfileId) return null;
  const connectionProfileId = profile.connectionProfileId;

  try {
    const { listConnectionProfiles } = await import("./connection-profiles.ts");
    const profiles = await listConnectionProfiles(profileName);
    const found = profiles.some((p) => p.id === connectionProfileId);
    if (found) return { connectionProfileId, status: "ok" };
    return {
      connectionProfileId,
      status: "missing",
      hint: "Run `appstrate connections profile switch <name>` to repin a valid profile.",
    };
  } catch {
    return { connectionProfileId, status: "unknown" };
  }
};

function upgradeHintRemoval(source: InstallSource): string {
  switch (source) {
    case "curl":
      return "rm <path-from-doctor> (the bootstrap installer copies one binary to one path).";
    case "bun":
      return "bun remove -g appstrate";
    case "unknown":
      return `unknown channel — see ${upgradeHint("unknown")}`;
  }
}
