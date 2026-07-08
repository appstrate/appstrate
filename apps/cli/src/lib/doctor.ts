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

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "./install/os.ts";
import {
  defaultPathScanFs,
  findAppstrateOnPath,
  type PathHit,
  type PathScanFs,
} from "./path-scan.ts";
import { upgradeHint, type InstallSource } from "./install-source.ts";
import { defaultInstallDir, readProjectFile } from "./install/project.ts";
import { analyzeComposeDefaults, type ComposeFinding } from "./compose-defaults.ts";
import { parseEnvFile } from "./install/upgrade.ts";

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
  /**
   * Local Docker-tier install detected at `~/appstrate` (or wherever
   * `--dir` was last installed). When present, the doctor surfaces the
   * lifecycle command hints (`appstrate logs / stop / uninstall`) so
   * the user doesn't have to memorize the derived project hash.
   */
  localInstall?: LocalInstallInfo;
  /**
   * Drift findings against the on-disk `<dir>/docker-compose.yml` of a
   * detected local install (issue #515). Only populated when a local
   * install is present AND its compose file carries stale duplicated
   * env defaults (or an intentional override that no longer matches).
   * Absent/empty for a healthy or freshly-installed compose file.
   *
   * Each finding masks the Zod schema's single source of truth the same
   * way the #513 `MODULES` drift did — `appstrate install
   * --upgrade-compose` strips the safe-to-remove duplicates.
   */
  composeDrift?: ComposeFinding[];
  /**
   * Reachability of the Firecracker runner daemon — only populated when a
   * local install's `.env` selects `RUN_ADAPTER=firecracker` and declares a
   * `FIRECRACKER_RUNNER_URL`. A lightweight `GET /v1/health` probe (with the
   * bearer token) classifies it as ok / unauthorized / unreachable. The
   * deep validation lives in `appstrate runner doctor` (on the KVM host).
   */
  firecracker?: FirecrackerHealth;
}

export interface FirecrackerHealth {
  status: "ok" | "unauthorized" | "unreachable";
  /** The probed base URL (trailing slash stripped). */
  url: string;
  /** Extra context on a non-ok result (HTTP status, connection error). */
  detail?: string;
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
  /**
   * Override the install-directory probe for tests. Returns the parsed
   * sidecar info when an install is detected at `dir`, or `null`.
   * Defaults to reading `<dir>/.appstrate/project.json` from disk.
   */
  probeLocalInstall?: (dir: string) => Promise<LocalInstallInfo | null>;
  /** Override the install dir probed (defaults to `~/appstrate`). */
  installDir?: string;
  /**
   * Read `<dir>/docker-compose.yml` for the compose-drift check (#515).
   * Returns the file content, or `null` when there is no compose file.
   * Defaults to a real `readFile`. Injected by tests to assert drift
   * formatting without touching disk.
   */
  readComposeFile?: (dir: string) => Promise<string | null>;
  /**
   * Read `<dir>/.env` for the Firecracker backend check. Returns the file
   * content, or `null` when absent. Defaults to a real `readFile`. Injected
   * by tests to drive the firecracker probe without touching disk.
   */
  readEnvFile?: (dir: string) => Promise<string | null>;
  /**
   * Probe the runner daemon's `/v1/health`. Injected by tests (fake ok /
   * timeout / 401); production issues a short-timeout authenticated GET.
   */
  probeFirecracker?: (url: string, token: string) => Promise<FirecrackerHealth>;
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

  // Compose-drift check (#515) — only meaningful for a detected local
  // install: the on-disk compose file is what an operator's stack
  // actually boots from, so stale duplicated defaults there silently
  // mask the schema's source of truth. Soft-fails on any read error
  // (unreadable / absent file) so it never perturbs the rest of the
  // report — a missing compose file is the normal state for the common
  // "no local install" case, already gated by `localInstall`.
  let composeDrift: ComposeFinding[] | undefined;
  if (localInstall) {
    const readCompose = opts.readComposeFile ?? defaultReadComposeFile;
    try {
      const content = await readCompose(localInstall.dir);
      if (content !== null) {
        const findings = analyzeComposeDefaults(content);
        if (findings.length > 0) composeDrift = findings;
      }
    } catch {
      // intentional swallow — drift detection is best-effort.
    }
  }

  // Firecracker runner reachability (#819) — only when a local install's
  // `.env` selects the firecracker backend. Soft-fails on any read/probe
  // error: an unreadable/absent `.env` is normal for the "no local install"
  // case (already gated by `localInstall`), and a probe failure surfaces as
  // an `unreachable` status rather than perturbing the rest of the report.
  let firecracker: FirecrackerHealth | undefined;
  if (localInstall) {
    const readEnv = opts.readEnvFile ?? defaultReadEnvFile;
    try {
      const envText = await readEnv(localInstall.dir);
      if (envText !== null) {
        const env = parseEnvFile(envText);
        if (env.RUN_ADAPTER === "firecracker" && env.FIRECRACKER_RUNNER_URL) {
          const probe = opts.probeFirecracker ?? defaultProbeFirecracker;
          firecracker = await probe(env.FIRECRACKER_RUNNER_URL, env.FIRECRACKER_RUNNER_TOKEN ?? "");
        }
      }
    } catch {
      // intentional swallow — the firecracker check is best-effort.
    }
  }

  return {
    installations,
    runningIndex,
    dualInstall: installations.length > 1,
    multiSource: sources.size > 1,
    ...(localInstall ? { localInstall } : {}),
    ...(composeDrift ? { composeDrift } : {}),
    ...(firecracker ? { firecracker } : {}),
  };
}

/**
 * Default `.env` reader — reads `<dir>/.env`. Returns `null` (not a throw)
 * when the file is missing so `runDoctor` skips the firecracker section
 * cleanly; other I/O errors propagate to the caller's soft-fail catch.
 */
async function defaultReadEnvFile(dir: string): Promise<string | null> {
  try {
    return await readFile(join(dir, ".env"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Default runner health probe — a short-timeout authenticated
 * `GET <url>/v1/health`. Classifies 200 → ok, 401/403 → unauthorized,
 * any other status or connection error → unreachable. Never throws (a
 * connection failure is the common "daemon down" case, reported as
 * `unreachable`). The deep check is `appstrate runner doctor`.
 *
 * `unix://<abs path>` URLs (same-host UDS transport) are dialed through
 * Bun's `fetch(…, { unix })` — the CLI runs on the host, so it can open the
 * daemon's socket directly, with the same token/status interpretation as
 * TCP. The socket path is the URL's pathname (three-slash form:
 * `unix:///run/appstrate-runner/runner.sock`), matching how the platform
 * parses FIRECRACKER_RUNNER_URL. `fetchImpl` is injectable for tests only.
 */
export async function defaultProbeFirecracker(
  url: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FirecrackerHealth> {
  // A unix:// URL stays VERBATIM (its path names a filesystem node —
  // stripping a trailing slash would change which node we dial); the
  // trailing-slash normalization is an http(s)-only concern.
  const isUnix = url.startsWith("unix://");
  const base = isUnix ? url : url.replace(/\/+$/, "");
  let socketPath: string | undefined;
  if (isUnix) {
    // Same policy as the platform's parseRunnerTransport: the two-slash
    // typo (`unix://var/run/x.sock`) parses "var" as a hostname and would
    // silently probe the WRONG socket — refuse instead. (The platform
    // refuses the same URL at boot; the doctor must not contradict it.)
    let parsed: URL;
    try {
      parsed = new URL(base);
    } catch {
      return { status: "unreachable", url: base, detail: "not a valid unix:// URL" };
    }
    if (parsed.hostname !== "") {
      return {
        status: "unreachable",
        url: base,
        detail:
          `unix:// URL has a host component ("${parsed.hostname}") — a socket path ` +
          `needs THREE slashes: unix:///${parsed.hostname}${parsed.pathname}`,
      };
    }
    socketPath = decodeURIComponent(parsed.pathname);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    // UDS: the http:// authority is a placeholder (feeds only the Host
    // header); Bun dials the socket instead of the network.
    const target = isUnix ? "http://appstrate-runner/v1/health" : `${base}/v1/health`;
    const res = await fetchImpl(target, {
      ...(isUnix ? { unix: socketPath } : {}),
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { status: "unauthorized", url: base, detail: `HTTP ${res.status}` };
    }
    if (res.ok) return { status: "ok", url: base };
    return { status: "unreachable", url: base, detail: `HTTP ${res.status}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A permission error on the socket is the rootless-doctor false
    // negative: the daemon is likely fine, this process just cannot open
    // a 0660 root:root node — say so instead of reporting "daemon down".
    const detail =
      isUnix && /EACCES|permission denied/i.test(message)
        ? `${message} — the socket is root-owned (mode 0660 by default); re-run with sudo`
        : message;
    return { status: "unreachable", url: base, detail };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Default compose reader — reads `<dir>/docker-compose.yml`. Returns
 * `null` (not a throw) when the file is missing so `runDoctor` can
 * skip the drift section cleanly; other I/O errors propagate to the
 * caller's soft-fail catch.
 */
async function defaultReadComposeFile(dir: string): Promise<string | null> {
  try {
    return await readFile(join(dir, "docker-compose.yml"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
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

  if (report.composeDrift && report.composeDrift.length > 0) {
    lines.push(...formatComposeDrift(report.composeDrift));
  }

  if (report.firecracker) {
    lines.push(...formatFirecrackerHealth(report.firecracker));
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
 * Render the compose-drift section (#515). Splits the findings into the
 * two classes so the operator sees which lines are safe to auto-strip
 * (`appstrate install --upgrade-compose`) versus which need a human eye
 * (an intentional override whose recorded default drifted).
 */
function formatComposeDrift(findings: ComposeFinding[]): string[] {
  const lines: string[] = [];
  const duplicates = findings.filter((f) => f.kind === "duplicate");
  const drifts = findings.filter((f) => f.kind === "allowlist-drift");

  lines.push(``);
  lines.push(
    `Compose drift: ${findings.length} env default(s) in your on-disk docker-compose.yml ` +
      `mirror or diverge from the platform schema.`,
  );

  if (duplicates.length > 0) {
    lines.push(``);
    lines.push(
      `  Stale duplicated defaults (safe to remove — they mask schema updates, the #513 class):`,
    );
    for (const f of duplicates) {
      lines.push(`    • line ${f.line}: ${f.varName}=${JSON.stringify(f.yamlDefault)}`);
    }
    lines.push(``);
    lines.push(`  Fix automatically (backs up the file first, preserves your edits):`);
    lines.push(`    • appstrate install --upgrade-compose`);
  }

  if (drifts.length > 0) {
    lines.push(``);
    lines.push(`  Intentional overrides whose value diverged from the shipped template:`);
    for (const f of drifts) {
      lines.push(
        `    • line ${f.line}: ${f.varName}=${JSON.stringify(f.yamlDefault)} ` +
          `(template default ${JSON.stringify(f.expectedYamlDefault)})`,
      );
    }
    lines.push(`  Left untouched by --upgrade-compose — review by hand if unexpected.`);
  }

  return lines;
}

/**
 * Render the Firecracker runner reachability line (#819). Lightweight by
 * design — a red line points the operator at `appstrate runner doctor` on
 * the KVM host for the deep diagnosis.
 */
function formatFirecrackerHealth(health: FirecrackerHealth): string[] {
  const lines: string[] = [""];
  if (health.status === "ok") {
    lines.push(`Firecracker runner (${health.url}): ✓ reachable and authorized.`);
    return lines;
  }
  const label =
    health.status === "unauthorized"
      ? "unauthorized — FIRECRACKER_RUNNER_TOKEN does not match the daemon"
      : "unreachable";
  lines.push(
    `Firecracker runner (${health.url}): ✗ ${label}${health.detail ? ` (${health.detail})` : ""}.`,
    `  Diagnose on the KVM host: appstrate runner doctor`,
  );
  return lines;
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
