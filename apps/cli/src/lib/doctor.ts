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

export interface DoctorReport {
  /** All discovered installations in PATH order — first one wins resolution. */
  installations: InstallationInfo[];
  /** Index of the running CLI in `installations`, or `-1` if not on PATH. */
  runningIndex: number;
  /** True when more than one distinct installation was found. */
  dualInstall: boolean;
  /** True when more than one DIFFERENT install source was detected. */
  multiSource: boolean;
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
  // absolute path). Match by realpath since the user's PATH entry might
  // be a symlink to the real binary.
  let runningIndex = -1;
  for (let i = 0; i < installations.length; i++) {
    const entry = installations[i]!;
    if (entry.binary === execPath || entry.realPath === execPath) {
      runningIndex = i;
      break;
    }
  }
  const sources = new Set(installations.map((i) => i.source));
  return {
    installations,
    runningIndex,
    dualInstall: installations.length > 1,
    multiSource: sources.size > 1,
  };
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
