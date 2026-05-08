// SPDX-License-Identifier: Apache-2.0

/**
 * Docker-based lifecycle commands — `appstrate start / stop / restart /
 * logs / status / uninstall`.
 *
 * Each command is a ~10-line wrapper around `docker compose
 * --project-name <name> <verb>`, where the project name is read from
 * `<dir>/.appstrate/project.json` via `resolveInstall`. We never
 * re-derive the name at this layer: the sidecar is the source of
 * truth, so a user who renamed `~/appstrate` to `~/work` still hits
 * the containers their original install registered.
 *
 * The Compose CLI surface for `up / stop / restart / logs / ps / down`
 * has been stable for years — see #343 for the tradeoff analysis. We
 * pin `--project-name` on every invocation so an unrelated host that
 * happens to have a similarly-named running project never collides
 * with our stack.
 *
 * `--purge` on `uninstall` is the only destructive verb; everything
 * else is reversible. The two-tier flow (`uninstall` → containers off,
 * data preserved; `uninstall --purge` → volumes + dir gone) mirrors
 * what most operators expect from a CLI: the safe verb is the default,
 * the dangerous one needs a flag, and the dangerous one prompts unless
 * `--yes` / `APPSTRATE_YES=1` is set.
 */

import { rm } from "node:fs/promises";
import * as clack from "@clack/prompts";
import { runCommand } from "../lib/install/os.ts";
import { resolveInstall } from "../lib/install/project.ts";

export interface LifecycleOptions {
  /**
   * Override the install directory. Defaults to `~/appstrate` via
   * `resolveInstall`, which then reads the recorded project name from
   * `<dir>/.appstrate/project.json`.
   */
  dir?: string;
}

export interface LogsOptions extends LifecycleOptions {
  /** Stream new lines as they arrive (`docker compose logs -f`). */
  follow?: boolean;
  /** Optional service-name filter (e.g. `postgres` or `appstrate`). */
  service?: string;
}

export interface UninstallOptions extends LifecycleOptions {
  /**
   * When true: `docker compose down -v` (volumes removed) + `rm -rf
   * <dir>` after confirmation. When false (the default): `docker
   * compose down` only — containers gone, named volumes preserved,
   * install dir untouched. The destructive verb is opt-in by
   * construction.
   */
  purge?: boolean;
  /**
   * Skip the destructive-action confirmation prompt. Required for
   * `--purge` to proceed in non-interactive contexts (CI, Dockerfile
   * `RUN`, cloud-init). Honoured via `APPSTRATE_YES=1` so the prompt
   * can also be skipped without threading a CLI flag through wrapper
   * scripts.
   */
  yes?: boolean;
}

/**
 * Run `docker compose --project-name <name> <verb...>` against the
 * resolved install dir. Pulls stdout/stderr through the parent's stdio
 * so the user sees Compose's normal output (progress bars, logs,
 * errors) inline. Throws on non-zero so commander's error handler
 * turns it into the standard cancel banner instead of swallowing the
 * exit code.
 */
async function runCompose(
  dir: string,
  projectName: string,
  args: string[],
  // `inherit` is the default — what every interactive verb needs.
  // `pipe` is rare (only when a follow-up command needs to inspect
  // Compose's output); the option exists so `runCompose` can stay the
  // single docker invocation site without callers reaching for `runCommand` again.
  stdio: "inherit" | "pipe" = "inherit",
): Promise<void> {
  const res = await runCommand("docker", ["compose", "--project-name", projectName, ...args], {
    cwd: dir,
    stdio,
  });
  if (res.ok) return;
  // SIGINT (130) / SIGTERM (143) are graceful Ctrl-C exits — surface
  // them as a clean process exit with the same code rather than as a
  // thrown error. Without this, `appstrate logs -f` followed by Ctrl-C
  // would render "docker compose logs failed with exit code 130" via
  // `exitWithError`, masking the fact that the user intentionally
  // ended the stream. The CLI's own shutdown coordinator (lib/shutdown.ts)
  // also calls `process.exit(130)` on SIGINT, so picking the same code
  // here keeps shell pipelines coherent.
  if (res.exitCode === 130 || res.exitCode === 143) {
    process.exit(res.exitCode);
  }
  throw new Error(
    `docker compose ${args.join(" ")} failed with exit code ${res.exitCode}` +
      (stdio === "pipe" && res.stderr ? `\n${res.stderr.trim()}` : ""),
  );
}

/** `appstrate start` → `docker compose up -d` (idempotent). */
export async function startCommand(opts: LifecycleOptions = {}): Promise<void> {
  const { dir, projectName } = await resolveInstall(opts);
  await runCompose(dir, projectName, ["up", "-d"]);
}

/** `appstrate stop` → `docker compose stop` (containers off, volumes intact). */
export async function stopCommand(opts: LifecycleOptions = {}): Promise<void> {
  const { dir, projectName } = await resolveInstall(opts);
  await runCompose(dir, projectName, ["stop"]);
}

/** `appstrate restart` → `docker compose restart`. */
export async function restartCommand(opts: LifecycleOptions = {}): Promise<void> {
  const { dir, projectName } = await resolveInstall(opts);
  await runCompose(dir, projectName, ["restart"]);
}

/**
 * `appstrate logs [-f] [service]` → `docker compose logs [...]`.
 * Service name is positional and forwarded verbatim — Compose handles
 * unknown service names with a helpful error of its own, no need to
 * pre-validate here.
 */
export async function logsCommand(opts: LogsOptions = {}): Promise<void> {
  const { dir, projectName } = await resolveInstall(opts);
  const args = ["logs"];
  if (opts.follow) args.push("-f");
  if (opts.service) args.push(opts.service);
  await runCompose(dir, projectName, args);
}

/** `appstrate status` → `docker compose ps`. */
export async function statusCommand(opts: LifecycleOptions = {}): Promise<void> {
  const { dir, projectName } = await resolveInstall(opts);
  await runCompose(dir, projectName, ["ps"]);
}

/**
 * `appstrate uninstall [--purge]`:
 *
 *   - default → `docker compose down` (containers gone, named volumes
 *     preserved). Reversible by `appstrate start` from the same dir.
 *   - `--purge` → `docker compose down -v` + `rm -rf <dir>`. Destroys
 *     Postgres, Redis, MinIO data plus every file the installer wrote.
 *     Prompts unless `--yes` / `APPSTRATE_YES=1` is set; the prompt
 *     enumerates exactly what gets destroyed so the user can't claim
 *     surprise.
 */
export async function uninstallCommand(opts: UninstallOptions = {}): Promise<void> {
  const { dir, projectName } = await resolveInstall(opts);
  const purge = opts.purge === true;
  const autoConfirm = opts.yes === true || process.env.APPSTRATE_YES === "1";

  if (purge) {
    if (!autoConfirm) {
      // The non-TTY case is handled by clack itself (Ctrl-C → exit 130);
      // we re-frame stdout-piped scripts with a dedicated guard so the
      // operator gets an actionable hint instead of a frozen prompt.
      if (!process.stdin.isTTY) {
        throw new Error(
          `\`appstrate uninstall --purge\` is destructive and requires confirmation.\n` +
            `Re-run with --yes (or APPSTRATE_YES=1) to proceed non-interactively.`,
        );
      }
      const ok = await clack.confirm({
        message:
          `Permanently destroy this Appstrate install?\n` +
          `  • dir: ${dir} (compose file, .env, .appstrate/)\n` +
          `  • named volumes: Postgres data, Redis data, MinIO data\n` +
          `  • project: ${projectName}\n` +
          `This cannot be undone.`,
        initialValue: false,
      });
      if (clack.isCancel(ok) || ok !== true) {
        clack.cancel("Uninstall cancelled.");
        // `process.exit(130)` matches the Ctrl-C exit code used by every
        // other prompt in this CLI — keeps shell-script wrappers (`if
        // appstrate uninstall --purge; then …`) coherent.
        process.exit(130);
      }
    }
    await runCompose(dir, projectName, ["down", "-v"]);
    // `rm -rf` AFTER `down -v` so we never strand orphan containers
    // pointing at a deleted bind-mount source. Only the install dir
    // itself is removed — the user's home directory is never touched.
    await rm(dir, { recursive: true, force: true });
    return;
  }

  // Safe verb: containers off, data preserved. No prompt — this is
  // the same blast radius as `appstrate stop` plus container removal,
  // which the user can reverse with `appstrate start` (Compose
  // re-creates from the persisted volumes).
  await runCompose(dir, projectName, ["down"]);
}
