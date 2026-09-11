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
import { confirm, exitWithError, logWarn, EXIT_CANCELLED } from "../lib/ui.ts";
import { runCommand } from "../lib/install/os.ts";
import { resolveInstall } from "../lib/install/project.ts";
import { reportRunning, resolveRunningUrls } from "../lib/install/report.ts";

interface LifecycleOptions {
  /**
   * Override the install directory. Defaults to `~/appstrate` via
   * `resolveInstall`, which then reads the recorded project name from
   * `<dir>/.appstrate/project.json`.
   */
  dir?: string;
}

interface LogsOptions extends LifecycleOptions {
  /** Stream new lines as they arrive (`docker compose logs -f`). */
  follow?: boolean;
  /** Optional service-name filter (e.g. `postgres` or `appstrate`). */
  service?: string;
}

interface UninstallOptions extends LifecycleOptions {
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
 * resolved install dir with stdio inherited, so the user sees
 * Compose's normal output (progress bars, logs, errors) inline.
 * Throws on non-zero so commander's error handler renders the
 * standard cancel banner instead of swallowing the exit code.
 */
async function runCompose(dir: string, projectName: string, args: string[]): Promise<void> {
  const res = await runCommand("docker", ["compose", "--project-name", projectName, ...args], {
    cwd: dir,
    stdio: "inherit",
  });
  if (res.ok) return;
  // SIGINT (130) / SIGTERM (143) are graceful Ctrl-C exits — surface
  // them as a clean process exit with the same code rather than a
  // thrown error. Without this, `appstrate logs -f` followed by Ctrl-C
  // would render "docker compose logs failed with exit code 130" via
  // `exitWithError`, masking the fact that the user intentionally
  // ended the stream. The CLI's own shutdown coordinator
  // (lib/shutdown.ts) also calls `process.exit(130)` on SIGINT, so
  // picking the same code here keeps shell pipelines coherent.
  if (res.exitCode === 130 || res.exitCode === 143) {
    process.exit(res.exitCode);
  }
  throw new Error(`docker compose ${args.join(" ")} failed with exit code ${res.exitCode}`);
}

/**
 * Print the unified "running at … / manage the stack" banner after a
 * start/restart, once the platform answers on its healthcheck URL — the
 * same banner `appstrate install` ends on, so all three entry points
 * report an identical, health-verified result instead of `start`
 * silently handing back a bare shell.
 *
 * The URLs come from `<dir>/.env`; if that file is unreadable we skip
 * the banner (a guessed URL that doesn't match the real port would be
 * worse than none) but leave the successful `up`/`restart` untouched.
 */
async function reportRunningStack(dir: string, projectName: string): Promise<void> {
  const urls = await resolveRunningUrls(dir);
  if (!urls) {
    logWarn(
      `Stack is up, but ${dir}/.env is missing or unreadable — skipping the status banner.\n` +
        `Manage the stack with \`appstrate logs -f\` / \`appstrate stop\`.`,
    );
    return;
  }
  await reportRunning({ dir, projectName, appUrl: urls.appUrl, healthUrl: urls.healthUrl });
}

/** `appstrate start` → `docker compose up -d` (idempotent), then the banner. */
export async function startCommand(opts: LifecycleOptions = {}): Promise<void> {
  const { dir, projectName } = await resolveInstall(opts);
  await runCompose(dir, projectName, ["up", "-d"]);
  await reportRunningStack(dir, projectName);
}

/** `appstrate stop` → `docker compose stop` (containers off, volumes intact). */
export async function stopCommand(opts: LifecycleOptions = {}): Promise<void> {
  const { dir, projectName } = await resolveInstall(opts);
  await runCompose(dir, projectName, ["stop"]);
}

/** `appstrate restart` → `docker compose restart`, then the banner. */
export async function restartCommand(opts: LifecycleOptions = {}): Promise<void> {
  const { dir, projectName } = await resolveInstall(opts);
  await runCompose(dir, projectName, ["restart"]);
  await reportRunningStack(dir, projectName);
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
      // Refuse before prompting when there is no terminal to prompt on:
      // `confirm` would throw the generic "stdin is not a TTY" message, and
      // an operator piping this command deserves to be told about `--yes`
      // instead.
      if (!process.stdin.isTTY) {
        throw new Error(
          `\`appstrate uninstall --purge\` is destructive and requires confirmation.\n` +
            `Re-run with --yes (or APPSTRATE_YES=1) to proceed non-interactively.`,
        );
      }
      // `confirm` (lib/ui.ts) owns the Ctrl-C branch: it renders "Cancelled."
      // and exits 130 without returning. What is left here is the explicit
      // "no" answer, which gets its own wording on the same exit code —
      // matching every other prompt in this CLI keeps shell-script wrappers
      // (`if appstrate uninstall --purge; then …`) coherent.
      const ok = await confirm(
        `Permanently destroy this Appstrate install?\n` +
          `  • dir: ${dir} (compose file, .env, .appstrate/)\n` +
          `  • named volumes: Postgres data, Redis data, MinIO data\n` +
          `  • project: ${projectName}\n` +
          `This cannot be undone.`,
        false,
      );
      if (!ok) {
        exitWithError("Uninstall cancelled.", undefined, EXIT_CANCELLED);
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
