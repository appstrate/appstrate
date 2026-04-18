// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate install` — interactive install flow that orchestrates
 * the per-tier bootstrap.
 *
 * The command owns UX only: prompts, spinners, outros. All actual
 * side effects (Docker calls, secret generation, git clone, bun
 * install, dev server spawn) live in `lib/install/*`. The dispatch
 * on `tier` is a single switch — each branch calls into its tier
 * module and returns.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as clack from "@clack/prompts";
import { intro, outro, askText, confirm, spinner, exitWithError } from "../lib/ui.ts";
import { generateEnvForTier, renderEnvFile, type Tier } from "../lib/install/secrets.ts";
import {
  assertDockerAvailable,
  DockerMissingError,
  dockerComposeUp,
  findRunningComposeProject,
  waitForAppstrate,
  writeComposeFile,
  writeEnvFile as writeComposeEnv,
} from "../lib/install/tier123.ts";
import {
  cloneAppstrateSource,
  detectBun,
  installBun,
  runBunInstall,
  spawnDevServer,
  writeEnvFile as writeTier0Env,
} from "../lib/install/tier0.ts";
import { openBrowser, isPortAvailable, describeProcessOnPort } from "../lib/install/os.ts";
import {
  detectInstallMode,
  mergeEnv,
  backupFiles,
  cleanupBackups,
  runWithRollback,
} from "../lib/install/upgrade.ts";
import {
  LEGACY_PROJECT_NAME,
  deriveProjectName,
  readProjectFile,
  writeProjectFile,
} from "../lib/install/project.ts";
import { CLI_VERSION } from "../lib/version.ts";

export interface InstallOptions {
  /** Skip the tier prompt (valid values: "0" | "1" | "2" | "3"). */
  tier?: string;
  /** Skip the directory prompt. */
  dir?: string;
  /** Override the host port the platform binds to (Tier 0/1/2/3). */
  port?: string;
  /** Override the host port the MinIO console binds to (Tier 3 only). */
  minioConsolePort?: string;
  /**
   * Bypass the "another stack is already running under this project
   * name" preflight. Escape hatch for edge cases where the operator
   * knows the running project is the intended one (e.g. recovering
   * from a corrupted `.appstrate/project.json`). Not documented in the
   * common install path — see `#167`.
   */
  force?: boolean;
}

const DEFAULT_INSTALL_DIR = join(homedir(), "appstrate");
const DEFAULT_PORT = 3000;
const DEFAULT_MINIO_CONSOLE_PORT = 9001;

function appUrlForPort(port: number): string {
  return port === 80 ? "http://localhost" : `http://localhost:${port}`;
}

export async function installCommand(opts: InstallOptions): Promise<void> {
  intro("Appstrate install");

  try {
    const tier = await resolveTier(opts.tier);
    const dir = await resolveDir(opts.dir);
    // "Non-interactive" means the caller skipped the tier prompt — in
    // that mode we fail fast on port conflicts rather than blocking on
    // `askText`. A `--tier` invocation is almost always scripted (CI,
    // one-liner installer), so any prompt hangs the pipeline.
    const nonInteractive = opts.tier !== undefined;

    const port = await resolveAppstratePort(opts.port, nonInteractive);
    const minioConsolePort =
      tier === 3 ? await resolveMinioConsolePort(opts.minioConsolePort, nonInteractive) : undefined;

    if (tier === 0) {
      await installTier0(dir, port);
    } else {
      await installDockerTier(dir, tier, port, minioConsolePort, {
        force: opts.force ?? false,
      });
    }
  } catch (err) {
    exitWithError(err);
  }
}

/**
 * Parse / validate a user-supplied port. Accepts `--port` via CLI flag
 * and falls back to `$APPSTRATE_PORT`, then the tier default. Returns
 * the port after preflight: if it's free, we return it as-is; if it
 * conflicts we describe the holder, prompt for an alternative (or
 * fail fast when `nonInteractive`) and recurse on the user's pick.
 */
export async function resolveAppstratePort(
  raw: string | undefined,
  nonInteractive: boolean,
): Promise<number> {
  const requested = parsePort(raw, process.env.APPSTRATE_PORT, DEFAULT_PORT, "--port");
  return ensurePortFree(requested, "APPSTRATE_PORT", "--port", "Appstrate", nonInteractive);
}

/** Same as `resolveAppstratePort` but for the MinIO console (Tier 3). */
export async function resolveMinioConsolePort(
  raw: string | undefined,
  nonInteractive: boolean,
): Promise<number> {
  const requested = parsePort(
    raw,
    process.env.APPSTRATE_MINIO_CONSOLE_PORT,
    DEFAULT_MINIO_CONSOLE_PORT,
    "--minio-console-port",
  );
  return ensurePortFree(
    requested,
    "APPSTRATE_MINIO_CONSOLE_PORT",
    "--minio-console-port",
    "MinIO console",
    nonInteractive,
  );
}

/**
 * Pure: resolve a port value from (flag | env | default), rejecting
 * anything outside 1..65535. Exported for tests.
 */
export function parsePort(
  flagValue: string | undefined,
  envValue: string | undefined,
  defaultValue: number,
  flagName: string,
): number {
  const raw = flagValue ?? envValue;
  if (raw === undefined || raw === "") return defaultValue;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(
      `Invalid ${flagName} value "${raw}". Expected an integer in the range 1..65535.`,
    );
  }
  return parsed;
}

/**
 * Probe the port; on conflict, print a best-effort "who's holding it"
 * hint and either prompt the user for a new one (interactive) or
 * throw a helpful error (non-interactive).
 */
async function ensurePortFree(
  port: number,
  envVar: string,
  flagName: string,
  label: string,
  nonInteractive: boolean,
): Promise<number> {
  if (await isPortAvailable(port)) return port;

  const holder = await describeProcessOnPort(port);
  const holderHint = holder ? ` Held by ${holder}.` : "";

  if (nonInteractive) {
    throw new Error(
      `Port ${port} is already in use (${label}).${holderHint} Re-run with ${flagName} <n> or set ${envVar}=<n> to pick a free port.`,
    );
  }

  clack.log.warn(
    `Port ${port} (${label}) is already in use.${holderHint} Free it or pick a different port.`,
  );
  const pick = await askText(`New port for ${label}`, String(port));
  const next = Number(pick);
  if (!Number.isInteger(next) || next < 1 || next > 65535) {
    throw new Error(`Invalid port "${pick}". Expected an integer in the range 1..65535.`);
  }
  // Recurse so the newly-picked port is checked again — cheap, and
  // covers the "user typed the same conflicting port twice" case.
  return ensurePortFree(next, envVar, flagName, label, nonInteractive);
}

/**
 * Parse `--tier` or drop into an interactive select. `clack`'s
 * `select` with 4 options reads better than free-form text and avoids
 * the "what did I type?" typo recovery. Exported so unit tests can
 * lock down the validation contract without invoking the prompt.
 */
export async function resolveTier(raw: string | undefined): Promise<Tier> {
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (parsed === 0 || parsed === 1 || parsed === 2 || parsed === 3) return parsed as Tier;
    throw new Error(`Invalid --tier value "${raw}". Expected 0, 1, 2, or 3.`);
  }
  const chosen = await clack.select<Tier>({
    message: "Which tier do you want to install?",
    options: [
      { value: 0, label: "Tier 0 — Hobby (Bun + local files, no Docker)" },
      { value: 1, label: "Tier 1 — Minimal (PostgreSQL)" },
      { value: 2, label: "Tier 2 — Standard (PostgreSQL + Redis)" },
      { value: 3, label: "Tier 3 — Production (PostgreSQL + Redis + MinIO)" },
    ],
  });
  if (clack.isCancel(chosen)) {
    clack.cancel("Cancelled.");
    process.exit(130);
  }
  return chosen;
}

/**
 * Parse `--dir` or prompt for it, then reject newlines / NUL bytes and
 * normalize to an absolute path. Exported for unit testing.
 */
export async function resolveDir(raw: string | undefined): Promise<string> {
  const chosen = raw ?? (await askText("Install directory", DEFAULT_INSTALL_DIR));
  // `tier0.ts` passes `dir` as an argv positional to `tar`, `curl`,
  // `git`, etc. without a shell wrapper, so interpolation injection is
  // already ruled out at the spawn layer. But newlines + NUL bytes in
  // paths are a long-standing source of surprising behaviour in shell
  // tools that DO iterate paths (bash glob expansion in hand-written
  // recovery scripts, log aggregators, etc.) — reject them up-front so
  // the user sees a clear error instead of a mysterious truncation.
  if (/[\r\n\0]/.test(chosen)) {
    throw new Error("Install directory must not contain newlines or NUL bytes.");
  }
  return resolve(chosen);
}

async function installTier0(dir: string, port: number): Promise<void> {
  const appUrl = appUrlForPort(port);
  // Bun — either already present, or install it via the upstream script.
  // We only care whether a working Bun is reachable; the actual path
  // resolution happens inside `runBunInstall` / `spawnDevServer` via
  // `bunEnv()`, which prepends `~/.bun/bin` to PATH so the just-installed
  // copy is picked up by a bare `spawn("bun", ...)`.
  const bun = detectBun();
  if (!bun.found) {
    const proceed = await confirm(
      "Bun is not installed. Install it now via `curl https://bun.sh/install | bash`?",
    );
    if (!proceed) {
      throw new Error("Tier 0 needs Bun. Install it manually from https://bun.sh and re-run.");
    }
    const bunSpinner = spinner();
    bunSpinner.start("Installing Bun");
    await installBun();
    bunSpinner.stop("Bun installed");
    // No re-probe: `installBun()` placed the binary at `~/.bun/bin/bun`
    // and verified it via `access()`. Downstream spawns PATH-resolve
    // through `bunEnv()`, which includes BUN_BIN.
  }

  // Source. Use the CLI's own version as the tag — lockstep-versioned
  // per ADR-006, so the cloned source matches exactly what this binary
  // was built against. `CLI_VERSION` is inlined at bundle time via the
  // static package.json import in `lib/version.ts`; falling back to
  // `undefined` when the value is a dev placeholder lets `main` be
  // checked out instead of a bogus tag.
  const cloneSpinner = spinner();
  cloneSpinner.start("Cloning Appstrate source");
  const versionTag = CLI_VERSION === "0.0.0" ? undefined : `v${CLI_VERSION}`;
  await cloneAppstrateSource(dir, { version: versionTag });
  cloneSpinner.stop("Source cloned");

  // Dependencies.
  const installSpinner = spinner();
  installSpinner.start("Installing dependencies");
  await runBunInstall(dir);
  installSpinner.stop("Dependencies installed");

  // `.env`.
  const env = generateEnvForTier(0, appUrl, { port });
  await writeTier0Env(dir, renderEnvFile(env));

  // Run dev server?
  const shouldStart = await confirm("Start the dev server now?");
  if (!shouldStart) {
    outro(
      `Ready. Start it later with:\n\n  cd ${dir}\n  bun run dev\n\nOpen ${appUrl} once it boots.`,
    );
    return;
  }

  const devSpinner = spinner();
  devSpinner.start("Starting dev server");
  const { pid } = await spawnDevServer(dir, appUrl);
  devSpinner.stop(`Dev server running (pid ${pid})`);

  await openBrowser(appUrl);
  outro(`Appstrate is running at ${appUrl} (pid ${pid}).\nKill it with \`kill ${pid}\` when done.`);
}

/**
 * Resolve the Compose project name for this install directory.
 *
 * Three cases:
 *   1. `.appstrate/project.json` exists → use the recorded name
 *      (authoritative; never re-derive, never drift).
 *   2. No sidecar but a compose file is already present → legacy
 *      pre-#167 install. Use the fixed `appstrate` name so the upgrade
 *      targets the same containers the user's stack is currently
 *      running under.
 *   3. Fresh install → derive from the absolute dir path (stable +
 *      unique + readable). The caller writes the sidecar on success
 *      so subsequent runs hit case (1).
 *
 * Exported for unit testing.
 */
export async function resolveProjectName(
  dir: string,
  hasLegacyCompose: boolean,
): Promise<{ name: string; origin: "sidecar" | "legacy" | "derived" }> {
  const recorded = await readProjectFile(dir);
  if (recorded) return { name: recorded.projectName, origin: "sidecar" };
  if (hasLegacyCompose) return { name: LEGACY_PROJECT_NAME, origin: "legacy" };
  return { name: deriveProjectName(dir), origin: "derived" };
}

/**
 * Refuse to proceed when an unrelated stack is already running under
 * the same project name from a different directory — the pre-fix case
 * that turned `appstrate install` into a stack-cannibal (#167). The
 * docker daemon keys a project by name, not by working directory, so
 * two installs that resolve to the same name would silently adopt
 * each other's containers. Better to abort, loudly.
 *
 * `--force` bypasses this guard.
 */
async function preflightProjectCollision(
  dir: string,
  projectName: string,
  force: boolean,
): Promise<void> {
  if (force) return;
  const running = await findRunningComposeProject(projectName);
  if (!running) return;
  const configPaths = running.configFiles;
  const belongsToThisDir = configPaths.some((p) => p === join(dir, "docker-compose.yml"));
  if (belongsToThisDir) return;
  const pretty =
    configPaths.length > 0
      ? `\n  Running stack: ${configPaths.join(", ")}`
      : `\n  Running stack: (compose config path unavailable)`;
  const stopHint =
    configPaths.length > 0 && configPaths[0]
      ? `cd "${join(configPaths[0], "..")}" && docker compose down`
      : `docker compose --project-name ${projectName} down`;
  throw new Error(
    `A Docker Compose project named "${projectName}" is already running from another directory.${pretty}\n\n` +
      `  Refusing to continue — re-running \`appstrate install\` now would adopt and recreate\n` +
      `  those containers against fresh secrets, breaking the other stack (and potentially\n` +
      `  corrupting its data). See https://github.com/appstrate/appstrate/issues/167.\n\n` +
      `  Fixes:\n` +
      `    • Stop the other stack first:  ${stopHint}\n` +
      `    • Or install into a different directory — the CLI derives an isolated\n` +
      `      project name per install dir, so two installs can coexist on the same host.\n` +
      `    • Or pass \`--force\` if you're sure this is the install you intend to\n` +
      `      recreate (requires you to have already backed up any data).\n`,
  );
}

async function installDockerTier(
  dir: string,
  tier: 1 | 2 | 3,
  port: number,
  minioConsolePort: number | undefined,
  opts: { force: boolean },
): Promise<void> {
  const appUrl = appUrlForPort(port);
  // Docker.
  const dockerSpinner = spinner();
  dockerSpinner.start("Checking Docker");
  try {
    await assertDockerAvailable();
    dockerSpinner.stop("Docker OK");
  } catch (err) {
    dockerSpinner.stop("Docker not found");
    if (err instanceof DockerMissingError) throw err;
    throw err;
  }

  // Upgrade detection: if `dir` already has a `.env` or
  // `docker-compose.yml` we're overwriting an existing deployment.
  // Rotating BETTER_AUTH_SECRET or CONNECTION_ENCRYPTION_KEY silently
  // would invalidate every session and brick every stored OAuth
  // credential — see `lib/install/upgrade.ts` for the threat model.
  const { mode, existing } = await detectInstallMode(dir);
  if (mode === "upgrade") {
    const proceed = await confirm(
      `An existing install was detected at ${dir}. Existing secrets (BETTER_AUTH_SECRET, CONNECTION_ENCRYPTION_KEY, POSTGRES_PASSWORD, …) will be preserved; the compose file will be replaced with the Tier ${tier} template. Continue?`,
    );
    if (!proceed) throw new Error("Upgrade cancelled.");
  }

  // Resolve the Compose project name BEFORE any mutating step — it
  // feeds both the preflight and `dockerComposeUp`. On a fresh install
  // `origin === "derived"` and we must persist the name on success so
  // subsequent upgrades pin to the exact same value.
  const project = await resolveProjectName(dir, existing.hasCompose);

  // Preflight: does another install already claim this project name?
  // Only meaningful on the derived / legacy paths — a sidecar-recorded
  // name IS the running project by definition, so the collision check
  // would just reject the user's own running stack.
  await preflightProjectCollision(dir, project.name, opts.force);

  // Backup BEFORE writing so a rollback is possible all the way back
  // to "user's last-known-good config". The list we backup is exactly
  // the set of files we're about to overwrite — backupFiles skips any
  // that aren't present so a half-installed dir (only `.env`, no
  // compose) works too.
  const backedUp = mode === "upgrade" ? await backupFiles(dir, [".env", "docker-compose.yml"]) : [];

  // `runWithRollback` centralizes the "on failure, restore backups
  // before rethrowing" contract. Keeping the rollback inside a shared
  // helper (rather than a hand-rolled try/catch here) means the
  // regression where someone drops the catch block is caught by the
  // helper's own unit test rather than needing a full install E2E to
  // notice the silent coverage loss.
  await runWithRollback(
    dir,
    backedUp,
    async () => {
      // Compose + .env.
      const writeSpinner = spinner();
      writeSpinner.start(
        mode === "upgrade" ? "Rewriting compose + merging .env" : "Writing compose + .env",
      );
      await writeComposeFile(dir, tier);
      const fresh = generateEnvForTier(tier, appUrl, { port, minioConsolePort });
      const envVars = mode === "upgrade" ? mergeEnv(existing.existingEnv, fresh) : fresh;
      await writeComposeEnv(dir, renderEnvFile(envVars));
      writeSpinner.stop(
        mode === "upgrade"
          ? `Rewrote ${dir}/docker-compose.yml (secrets preserved)`
          : `Wrote ${dir}/docker-compose.yml + .env`,
      );

      // Bring stack up. The project name is pinned via `--project-name`
      // rather than baked into the compose template, so two installs
      // under different dirs get isolated namespaces.
      const upSpinner = spinner();
      upSpinner.start(`Starting Appstrate (docker compose --project-name ${project.name} up -d)`);
      await dockerComposeUp(dir, project.name);
      upSpinner.stop("Containers up");

      // Healthcheck.
      const healthSpinner = spinner();
      healthSpinner.start("Waiting for Appstrate to become healthy");
      await waitForAppstrate(appUrl);
      healthSpinner.stop("Appstrate is healthy");

      // Persist the project-name binding on success. Written AFTER the
      // healthcheck so a stack that never came up doesn't leave a
      // sidecar file behind — the next attempt would then skip the
      // preflight check and potentially collide with a different
      // running install.
      if (project.origin !== "sidecar") {
        await writeProjectFile(dir, project.name);
      }
    },
    // Success-only cleanup: drop the backup copies once the upgrade
    // reached the healthy state. Kept out of the rollback path so a
    // failed upgrade leaves the `.backup` files on disk for manual
    // recovery.
    async () => {
      if (backedUp.length > 0) await cleanupBackups(dir, backedUp);
    },
  );

  await openBrowser(appUrl);
  outro(
    `Appstrate is running at ${appUrl}.\n` +
      `Manage the stack from ${dir}:\n` +
      `  docker compose --project-name ${project.name} logs -f\n` +
      `  docker compose --project-name ${project.name} down`,
  );
}
