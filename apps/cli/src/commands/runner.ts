// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate runner …` — install and manage the Firecracker runner daemon
 * on a KVM host (issue #819, phase 3).
 *
 * The CLI does NOT contain the daemon: `appstrate-runner-<arch>` is a
 * separately-compiled binary published as a GitHub Release asset. These
 * commands download + verify + install it, wire a hardened systemd unit,
 * and provide the day-2 verbs (doctor / update / status / logs). Goal:
 * `appstrate runner install` on a fresh KVM host → daemon active, with
 * zero checkout, zero bun, and zero on-host build.
 *
 * The command file owns UX (prompts, spinners, framed notes) and
 * orchestration; every host-mutating side effect (subprocess, fs, http)
 * goes through the injectable seams in `lib/runner/exec.ts` so the logic is
 * unit-testable without a real KVM host.
 */

import * as clack from "@clack/prompts";
import { intro, outro, askText, exitWithError } from "../lib/ui.ts";
import { CLI_VERSION, DEV_CLI_VERSION } from "../lib/version.ts";
import {
  RUNNER_BIN_PATH,
  RUNNER_ENV_PATH,
  RUNNER_ETC_DIR,
  RUNNER_SERVICE_NAME,
  RUNNER_UNIT_PATH,
  RUNNER_DATA_DIR,
  RUNNER_DEFAULT_PORT,
  FIRECRACKER_VERSION,
  resolveRunnerArch,
  runnerDataPaths,
  type RunnerArch,
} from "../lib/runner/constants.ts";
import {
  defaultRunnerExec,
  defaultRunnerFs,
  defaultRunnerHttp,
  type RunnerExec,
  type RunnerFs,
  type RunnerHttp,
} from "../lib/runner/exec.ts";
import { runPreflight, type PreflightResult } from "../lib/runner/preflight.ts";
import {
  generateRunnerToken,
  renderRunnerEnvFile,
  parseRunnerEnvFile,
  renderRunnerUnit,
  firewallCommands,
  type RunnerConfig,
} from "../lib/runner/config-files.ts";
import { downloadDaemon, installFirecracker } from "../lib/runner/download.ts";
import { parseIpv4HttpUrl } from "../lib/install/os.ts";

/** Shared DI surface for every runner subcommand. */
export interface RunnerDeps {
  exec?: RunnerExec;
  fs?: RunnerFs;
  http?: RunnerHttp;
  /** `process.getuid` — overridable so tests can exercise the root gate. */
  getuid?: () => number;
  /** Preflight override (tests inject a deterministic matrix). */
  preflight?: (deps?: unknown) => Promise<PreflightResult>;
}

interface ResolvedDeps {
  exec: RunnerExec;
  fs: RunnerFs;
  http: RunnerHttp;
  getuid: () => number;
  preflight: () => Promise<PreflightResult>;
}

function resolve(deps: RunnerDeps): ResolvedDeps {
  return {
    exec: deps.exec ?? defaultRunnerExec,
    fs: deps.fs ?? defaultRunnerFs,
    http: deps.http ?? defaultRunnerHttp,
    getuid: deps.getuid ?? (() => (typeof process.getuid === "function" ? process.getuid() : 0)),
    preflight: (deps.preflight as () => Promise<PreflightResult>) ?? (() => runPreflight()),
  };
}

/** Version tag the daemon binary is pulled from (lockstep with the CLI). */
export function resolveDaemonVersion(cliVersion: string = CLI_VERSION): string {
  return cliVersion === DEV_CLI_VERSION ? "latest" : cliVersion;
}

/** Fail early if not root — install/update/logs mutate /etc, /usr, systemd. */
function requireRoot(getuid: () => number, verb: string): void {
  if (getuid() !== 0) {
    throw new Error(
      `\`appstrate runner ${verb}\` must run as root (it writes ${RUNNER_ETC_DIR}, ` +
        `installs a systemd unit, and drives systemctl). Re-run with sudo:\n\n` +
        `  sudo appstrate runner ${verb}`,
    );
  }
}

// ─── install ─────────────────────────────────────────────────────────────

export interface RunnerInstallOptions {
  platformUrl?: string;
  token?: string;
  port?: string;
  dataDir?: string;
  host?: string;
  yes?: boolean;
  deps?: RunnerDeps;
}

export async function runnerInstallCommand(opts: RunnerInstallOptions = {}): Promise<void> {
  intro("Appstrate runner install");
  const d = resolve(opts.deps ?? {});
  try {
    requireRoot(d.getuid, "install");

    // 1. Preflight — actionable per-check messages, abort on any failure.
    const pf = await d.preflight();
    printPreflight(pf);
    if (!pf.ok || !pf.arch) {
      throw new Error(
        "Host preflight failed — fix the checks above and re-run `appstrate runner install`.",
      );
    }
    const arch = pf.arch;

    // 2. Resolve config. Existing token is preserved across re-installs so a
    //    re-run never silently rotates the secret the platform paired with.
    const { config, tokenSource } = await resolveInstallConfig(opts, d);

    // 3. Download + install the daemon binary (lockstep version) + firecracker.
    const version = resolveDaemonVersion();
    await downloadAndInstallBinaries(config, version, arch, d);

    // 4. Provision state dirs + config + unit.
    await writeHostFiles(config, d);

    // 5. Enable + start via systemd, then verify.
    await enableService(d);

    // 6. Health check (the daemon downloads guest artifacts on first boot —
    //    poll patiently, then hand off to `runner doctor` if still warming up).
    const healthy = await pollHealth(config, d, 180_000);

    printPostInstall(config, tokenSource, healthy);
    outro(
      healthy
        ? "Runner daemon is active and healthy."
        : "Runner daemon installed — still warming up (downloading guest artifacts). " +
            "Check progress with `appstrate runner doctor` / `appstrate runner logs -f`.",
    );
  } catch (err) {
    exitWithError(err);
  }
}

type TokenSource = "flag" | "preserved" | "generated";

/**
 * Resolve + validate the install config from flags / prompts / existing env.
 * Exported for unit testing (the --platform-url validation is the interesting
 * bit — it shares one IPv4-URL validator with `install --runner-url`).
 */
export async function resolveInstallConfig(
  opts: RunnerInstallOptions,
  d: ResolvedDeps,
): Promise<{ config: RunnerConfig; tokenSource: TokenSource }> {
  const dataDir = opts.dataDir?.trim() || RUNNER_DATA_DIR;
  const host = opts.host?.trim() || "0.0.0.0";

  const port = parsePort(opts.port);

  // Platform URL: flag > prompt (interactive) > error.
  let platformUrl = opts.platformUrl?.trim();
  if (!platformUrl) {
    if (opts.yes || !process.stdin.isTTY) {
      throw new Error(
        "Missing --platform-url. Pass the IPv4 URL the guests reach the platform on, e.g. " +
          "`--platform-url http://10.0.0.5:3000` (guests have no DNS, so it must be an IPv4 literal).",
      );
    }
    platformUrl = (await askText("Platform URL the daemon reaches (http://<IPv4>[:port])")).trim();
  }
  const parsedPlatformUrl = parseIpv4HttpUrl(platformUrl);
  if (!parsedPlatformUrl) {
    throw new Error(
      `Invalid --platform-url "${platformUrl}" — must be http(s)://<IPv4>[:port]. ` +
        "Firecracker guests have no DNS resolver, so a hostname would fail inside every microVM.",
    );
  }
  platformUrl = parsedPlatformUrl.url;

  // Token: flag > existing env file > freshly generated (printed once).
  let token = opts.token?.trim();
  let tokenSource: TokenSource = "flag";
  if (!token) {
    const existing = await d.fs.readFile(RUNNER_ENV_PATH);
    const preserved = existing ? parseRunnerEnvFile(existing).FIRECRACKER_RUNNER_TOKEN : undefined;
    if (preserved && preserved.length >= 16) {
      token = preserved;
      tokenSource = "preserved";
    } else {
      token = generateRunnerToken();
      tokenSource = "generated";
    }
  }
  if (token.length < 16) {
    throw new Error(
      "--token must be at least 16 characters (it guards the credential-bearing daemon API).",
    );
  }

  return { config: { token, platformUrl, port, host, dataDir }, tokenSource };
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return RUNNER_DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid --port "${raw}". Expected an integer in the range 1..65535.`);
  }
  return n;
}

async function downloadAndInstallBinaries(
  config: RunnerConfig,
  version: string,
  arch: RunnerArch,
  d: ResolvedDeps,
): Promise<void> {
  const paths = runnerDataPaths(config.dataDir);
  await d.fs.mkdirp(paths.binDir);

  const daemonSpin = clack.spinner();
  daemonSpin.start(`Downloading runner daemon ${version} (${arch})`);
  const daemonBytes = await downloadDaemon({
    http: d.http,
    exec: d.exec,
    fs: d.fs,
    version,
    arch,
  });
  await d.fs.installAtomic(RUNNER_BIN_PATH, daemonBytes, 0o755);
  daemonSpin.stop(`Installed daemon → ${RUNNER_BIN_PATH}`);

  const fcSpin = clack.spinner();
  fcSpin.start(`Downloading firecracker + jailer v${FIRECRACKER_VERSION} (${arch})`);
  await installFirecracker({
    http: d.http,
    exec: d.exec,
    fs: d.fs,
    version: FIRECRACKER_VERSION,
    arch,
    destPath: paths.firecrackerBin,
    // Same verified tarball — the daemon requires firecracker + jailer
    // to come from one release (FIRECRACKER_JAILER=on confinement).
    jailerDestPath: paths.jailerBin,
  });
  fcSpin.stop(`Installed firecracker → ${paths.firecrackerBin} (+ jailer → ${paths.jailerBin})`);
}

async function writeHostFiles(config: RunnerConfig, d: ResolvedDeps): Promise<void> {
  const paths = runnerDataPaths(config.dataDir);
  await d.fs.mkdirp(config.dataDir);
  await d.fs.mkdirp(paths.runsDir);
  await d.fs.mkdirp(RUNNER_ETC_DIR);
  await d.fs.chmod(RUNNER_ETC_DIR, 0o700);

  // Env file 0600: it carries the bearer token that guards the daemon's
  // credential-bearing /v1/sidecars surface.
  await d.fs.writeFile(RUNNER_ENV_PATH, renderRunnerEnvFile(config), 0o600);
  await d.fs.chmod(RUNNER_ENV_PATH, 0o600);

  await d.fs.writeFile(RUNNER_UNIT_PATH, renderRunnerUnit(config), 0o644);
}

export async function enableService(d: ResolvedDeps): Promise<void> {
  const spin = clack.spinner();
  spin.start("Enabling systemd unit");
  const reload = await d.exec.run("systemctl", ["daemon-reload"]);
  if (!reload.ok)
    throw new Error(`systemctl daemon-reload failed: ${reload.stderr || reload.exitCode}`);
  // `enable` (persistence) then `restart` — NOT `enable --now`: on a re-install
  // over an already-active unit `enable --now` is a no-op that leaves the OLD
  // binary running, so the health poll would validate the stale daemon. `restart`
  // is idempotent (starts if stopped, restarts if running) → always the new binary.
  const enable = await d.exec.run("systemctl", ["enable", RUNNER_SERVICE_NAME]);
  if (!enable.ok) {
    throw new Error(
      `systemctl enable ${RUNNER_SERVICE_NAME} failed: ${enable.stderr || enable.exitCode}. ` +
        `Inspect with \`journalctl -u ${RUNNER_SERVICE_NAME} -n 50\`.`,
    );
  }
  const restart = await d.exec.run("systemctl", ["restart", RUNNER_SERVICE_NAME]);
  if (!restart.ok) {
    throw new Error(
      `systemctl restart ${RUNNER_SERVICE_NAME} failed: ${restart.stderr || restart.exitCode}. ` +
        `Inspect with \`journalctl -u ${RUNNER_SERVICE_NAME} -n 50\`.`,
    );
  }
  spin.stop("systemd unit enabled + started");
}

/**
 * Poll the daemon health endpoint until healthy or the deadline elapses.
 *
 * The daemon may legitimately be warming up on first boot (it downloads the
 * guest kernel/rootfs before it serves 200) — but it may instead have
 * crash-looped past its systemd start limit and parked in `failed` (e.g. a
 * `FatalArtifactsError` on bad/undownloadable artifacts, exit 1). Reporting
 * "warming up" for the full timeout in that case hides the real failure, so
 * each iteration also checks the unit state and bails early with the last
 * journal lines when the unit is parked (`failed`/`inactive`).
 *
 * Exported for unit testing (the poll loop is the interesting bit). Takes the
 * exec + http seams only.
 */
export async function pollHealth(
  config: { port: number; token: string },
  d: { exec: RunnerExec; http: RunnerHttp },
  timeoutMs: number,
): Promise<boolean> {
  const url = `http://127.0.0.1:${config.port}/v1/health`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await d.http.getJson(url, config.token);
    if (res.reachable && res.status === 200) return true;

    const parked = await unitParkedState(d.exec);
    if (parked) {
      const tail = await journalTail(d.exec, 20);
      throw new Error(
        `The ${RUNNER_SERVICE_NAME} unit is ${parked} — the daemon did not stay running. ` +
          `It likely failed at boot; common causes are undownloadable/unbuildable guest ` +
          `artifacts, a missing or unreadable /dev/kvm, or an unreachable platform URL.` +
          (tail ? `\n\nLast journal lines:\n${tail}` : "") +
          `\n\nDiagnose with \`appstrate runner doctor\` / \`appstrate runner logs\`, fix the ` +
          `cause, then \`systemctl restart ${RUNNER_SERVICE_NAME}\` (or re-run install).`,
      );
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

/**
 * Is the unit parked (not coming back on its own)? Returns the terminal state
 * string (`failed` / `inactive`) or null while it is still up/activating.
 * `systemctl is-failed` exits 0 and prints `failed` for a failed unit;
 * `is-active` prints `inactive` for a stopped one. A warming-up daemon is
 * `active` (or `activating`), so both probes return non-terminal — the poll
 * keeps waiting.
 */
async function unitParkedState(exec: RunnerExec): Promise<"failed" | "inactive" | null> {
  const failed = await exec.run("systemctl", ["is-failed", RUNNER_SERVICE_NAME]);
  if (failed.stdout.trim() === "failed") return "failed";
  const active = await exec.run("systemctl", ["is-active", RUNNER_SERVICE_NAME]);
  if (active.stdout.trim() === "inactive") return "inactive";
  return null;
}

/** Best-effort last N journal lines for the unit (empty string on failure). */
async function journalTail(exec: RunnerExec, lines: number): Promise<string> {
  const res = await exec.run("journalctl", [
    "-u",
    RUNNER_SERVICE_NAME,
    "-n",
    String(lines),
    "--no-pager",
  ]);
  return res.ok ? res.stdout.trim() : "";
}

function printPreflight(pf: PreflightResult): void {
  const lines = pf.checks.map((c) => {
    const glyph = c.ok ? "✓" : "✗";
    const base = `${glyph} ${c.label}: ${c.detail}`;
    return c.ok || !c.remedy ? base : `${base}\n    → ${c.remedy}`;
  });
  clack.note(lines.join("\n"), "Host preflight");
}

function printPostInstall(config: RunnerConfig, source: TokenSource, healthy: boolean): void {
  const fw = detectFirewallCommands(config.port);
  const tokenBlock =
    source === "generated"
      ? `\n\nRunner token (shown once — also in ${RUNNER_ENV_PATH}, mode 0600):\n  ${config.token}\n` +
        `Set it on the platform as FIRECRACKER_RUNNER_TOKEN.`
      : source === "preserved"
        ? `\n\nExisting runner token preserved (see ${RUNNER_ENV_PATH}).`
        : "";

  clack.note(
    [
      `Platform config (set on the containerized platform):`,
      `  RUN_ADAPTER=firecracker`,
      `  FIRECRACKER_RUNNER_URL=http://<this-host>:${config.port}`,
      `  FIRECRACKER_RUNNER_TOKEN=<token above>`,
      ``,
      `Open the daemon port for the platform:`,
      ...fw.commands.map((c) => `  ${c}`),
      ``,
      `Platform on a DIFFERENT host? Put TLS in front of this daemon (reverse proxy)`,
      `and use https:// in FIRECRACKER_RUNNER_URL — the wire carries run credentials.`,
      ``,
      `Guest egress uses the host's own TAP/nft path (set up by the daemon) —`,
      `no extra ufw/firewalld rule is needed for guest→platform traffic.`,
      tokenBlock,
    ]
      .filter(Boolean)
      .join("\n"),
    healthy ? "Runner ready" : "Runner installed (warming up)",
  );
}

/** Detect ufw/firewalld on PATH and render the exact allow commands. */
function detectFirewallCommands(port: number): ReturnType<typeof firewallCommands> {
  if (defaultRunnerExec.exists("ufw")) return firewallCommands("ufw", port);
  if (defaultRunnerExec.exists("firewall-cmd")) return firewallCommands("firewalld", port);
  return firewallCommands("none", port);
}

// ─── doctor ──────────────────────────────────────────────────────────────

export interface RunnerDoctorOptions {
  json?: boolean;
  deps?: RunnerDeps;
}

export interface RunnerDoctorReport {
  preflight: PreflightResult;
  service: { installed: boolean; active: boolean; enabled: boolean; state: string };
  health: {
    reachable: boolean;
    status?: number;
    protocol?: number;
    initialized?: boolean;
    error?: string;
  };
  artifacts: { version?: string; guestProtocol?: number };
  /** Jailer binary presence (FIRECRACKER_JAILER=on needs it at boot). */
  jailer: { installed: boolean; path: string };
  ok: boolean;
}

export async function runnerDoctor(opts: RunnerDoctorOptions = {}): Promise<RunnerDoctorReport> {
  const d = resolve(opts.deps ?? {});
  const preflight = await d.preflight();

  // systemd state.
  const active = await d.exec.run("systemctl", ["is-active", RUNNER_SERVICE_NAME]);
  const enabled = await d.exec.run("systemctl", ["is-enabled", RUNNER_SERVICE_NAME]);
  const unitPresent = await d.fs.exists(RUNNER_UNIT_PATH);
  const service = {
    installed: unitPresent,
    active: active.stdout.trim() === "active",
    enabled: enabled.stdout.trim() === "enabled",
    state: active.stdout.trim() || active.stderr.trim() || "unknown",
  };

  // Health probe using the token from the env file.
  const envText = await d.fs.readFile(RUNNER_ENV_PATH);
  const env = envText ? parseRunnerEnvFile(envText) : {};
  const token = env.FIRECRACKER_RUNNER_TOKEN ?? "";
  const port = Number(env.FIRECRACKER_RUNNER_PORT ?? RUNNER_DEFAULT_PORT) || RUNNER_DEFAULT_PORT;
  const dataDir = env.FIRECRACKER_ROOTFS_PATH
    ? env.FIRECRACKER_ROOTFS_PATH.replace(/\/rootfs\.ext4$/, "")
    : RUNNER_DATA_DIR;

  let health: RunnerDoctorReport["health"];
  if (token) {
    const res = await d.http.getJson(`http://127.0.0.1:${port}/v1/health`, token);
    if (res.reachable) {
      const body = (res.body ?? {}) as { protocol?: number; initialized?: boolean };
      health = {
        reachable: true,
        status: res.status,
        protocol: body.protocol,
        initialized: body.initialized,
      };
    } else {
      health = { reachable: false, error: res.error };
    }
  } else {
    health = { reachable: false, error: `no token found in ${RUNNER_ENV_PATH}` };
  }

  // Artifact marker (written by runner/artifacts.ts next to the rootfs).
  const markerText = await d.fs.readFile(runnerDataPaths(dataDir).artifactsMarker);
  let artifacts: RunnerDoctorReport["artifacts"] = {};
  if (markerText) {
    try {
      const parsed = JSON.parse(markerText) as { version?: string; guest_protocol?: number };
      artifacts = { version: parsed.version, guestProtocol: parsed.guest_protocol };
    } catch {
      artifacts = {};
    }
  }

  // Jailer presence. Counted in `ok` whenever the jailer is required
  // (FIRECRACKER_JAILER unset or "on"): the daemon refuses to boot without
  // it in that mode, so a green doctor next to a missing jailer would lie
  // about the next restart.
  const jailerPath = runnerDataPaths(dataDir).jailerBin;
  const jailer = { installed: await d.fs.exists(jailerPath), path: jailerPath };
  const jailerRequired = (env.FIRECRACKER_JAILER ?? "on") !== "off";

  const ok =
    preflight.ok &&
    service.active &&
    health.reachable &&
    health.status === 200 &&
    (!jailerRequired || jailer.installed);
  return { preflight, service, health, artifacts, jailer, ok };
}

export async function runnerDoctorCommand(opts: RunnerDoctorOptions = {}): Promise<void> {
  const report = await runnerDoctor(opts);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  intro("Appstrate runner doctor");
  const pfLines = report.preflight.checks.map(
    (c) =>
      `${c.ok ? "✓" : "✗"} ${c.label}: ${c.detail}${!c.ok && c.remedy ? `\n    → ${c.remedy}` : ""}`,
  );
  const svc = report.service;
  const svcLine = `${svc.active ? "✓" : "✗"} systemd: ${svc.state}${svc.enabled ? " (enabled)" : svc.installed ? " (not enabled)" : " (unit not installed)"}`;
  const health = report.health;
  const healthLine = health.reachable
    ? `${health.status === 200 ? "✓" : "✗"} daemon /v1/health: HTTP ${health.status}` +
      (health.protocol !== undefined ? `, protocol ${health.protocol}` : "") +
      (health.initialized ? ", initialized" : "")
    : `✗ daemon /v1/health: unreachable${health.error ? ` (${health.error})` : ""}`;
  const artLine = report.artifacts.version
    ? `✓ guest artifacts: ${report.artifacts.version} (protocol ${report.artifacts.guestProtocol ?? "?"})`
    : "• guest artifacts: not yet installed (daemon downloads them on first boot)";
  const jailerLine = report.jailer.installed
    ? `✓ jailer: ${report.jailer.path}`
    : `✗ jailer: missing at ${report.jailer.path} — the daemon refuses to boot with ` +
      `FIRECRACKER_JAILER=on (the default); re-run \`appstrate runner install\` to fetch it`;

  clack.note(
    [...pfLines, "", svcLine, healthLine, artLine, jailerLine].join("\n"),
    "Runner diagnostics",
  );
  if (report.ok) {
    outro("Runner is healthy.");
  } else {
    clack.cancel("Runner has issues — see the diagnostics above.");
    process.exitCode = 1;
  }
}

// ─── update ──────────────────────────────────────────────────────────────

export interface RunnerUpdateOptions {
  deps?: RunnerDeps;
}

export async function runnerUpdateCommand(opts: RunnerUpdateOptions = {}): Promise<void> {
  intro("Appstrate runner update");
  const d = resolve(opts.deps ?? {});
  try {
    requireRoot(d.getuid, "update");
    const arch = resolveRunnerArch();
    const version = resolveDaemonVersion();

    const spin = clack.spinner();
    spin.start(`Downloading runner daemon ${version} (${arch})`);
    const bytes = await downloadDaemon({ http: d.http, exec: d.exec, fs: d.fs, version, arch });
    // Atomic swap over the live binary — rename(2) keeps the running
    // process's fd valid; the restart below picks up the new inode.
    await d.fs.installAtomic(RUNNER_BIN_PATH, bytes, 0o755);
    spin.stop(`Installed daemon → ${RUNNER_BIN_PATH}`);

    const restart = await d.exec.run("systemctl", ["restart", RUNNER_SERVICE_NAME]);
    if (!restart.ok) {
      throw new Error(
        `systemctl restart ${RUNNER_SERVICE_NAME} failed: ${restart.stderr || restart.exitCode}.`,
      );
    }
    outro(`Runner daemon updated to ${version} and restarted.`);
  } catch (err) {
    exitWithError(err);
  }
}

// ─── status / logs ─────────────────────────────────────────────────────────

export interface RunnerStatusOptions {
  deps?: RunnerDeps;
}

export async function runnerStatusCommand(opts: RunnerStatusOptions = {}): Promise<void> {
  const d = resolve(opts.deps ?? {});
  const res = await d.exec.run("systemctl", ["status", RUNNER_SERVICE_NAME, "--no-pager"], {
    stdio: "inherit",
  });
  // `systemctl status` exits 3 when the unit is inactive — surface the code
  // but do not treat "stopped" as a CLI crash.
  if (!res.ok && res.exitCode !== 3) process.exitCode = res.exitCode === -1 ? 1 : res.exitCode;
}

export interface RunnerLogsOptions {
  follow?: boolean;
  deps?: RunnerDeps;
}

export async function runnerLogsCommand(opts: RunnerLogsOptions = {}): Promise<void> {
  const d = resolve(opts.deps ?? {});
  const args = ["-u", RUNNER_SERVICE_NAME, "-n", "200"];
  if (opts.follow) args.push("-f");
  const res = await d.exec.run("journalctl", args, { stdio: "inherit" });
  // Ctrl-C on `-f` exits 130 — a clean user stop, not an error.
  if (!res.ok && res.exitCode !== 130) process.exitCode = res.exitCode === -1 ? 1 : res.exitCode;
}
