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
import {
  generateBootstrapToken,
  generateEnvForTier,
  isValidBootstrapEmail,
  renderEnvFile,
  type BootstrapOverrides,
  type Tier,
} from "../lib/install/secrets.ts";
import {
  assertDockerAvailable,
  checkDockerNetworkBudget,
  DockerMissingError,
  dockerComposeUp,
  findRunningComposeProject as findRunningComposeProjectImport,
  isDockerAvailable,
  waitForAppstrate,
  writeComposeFile,
  writeEnvFile as writeComposeEnv,
  type RunningComposeProject,
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
  type ExistingInstall,
  type InstallMode,
} from "../lib/install/upgrade.ts";
import type { EnvVars } from "../lib/install/secrets.ts";
import { deriveProjectName, readProjectFile, writeProjectFile } from "../lib/install/project.ts";
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
  /**
   * Skip every interactive prompt and accept the smart defaults:
   *   - tier: Docker-aware default (3 when Docker is reachable, else 0)
   *   - dir: DEFAULT_INSTALL_DIR (~/appstrate)
   *   - port: 3000 (or --port / APPSTRATE_PORT)
   *   - upgrade confirm: proceed
   *   - Bun install confirm (Tier 0): install
   *   - "start dev server now?" (Tier 0): yes
   *
   * Set by `-y/--yes` or `APPSTRATE_YES=1`. Required for the `curl|bash`
   * bootstrap because of the Bun compile + macOS setRawMode regression
   * (#199) — zero clack prompts = zero raw mode = the Bun runtime bug is
   * bypassed by construction, independent of upstream fixes. Also makes
   * the installer usable from CI, Dockerfile `RUN`, cloud-init, Ansible.
   */
  autoConfirm?: boolean;
}

const DEFAULT_INSTALL_DIR = join(homedir(), "appstrate");
const DEFAULT_PORT = 3000;
const DEFAULT_MINIO_CONSOLE_PORT = 9001;

function appUrlForPort(port: number): string {
  return port === 80 ? "http://localhost" : `http://localhost:${port}`;
}

/**
 * Print the closed-mode follow-up note. Two flavors:
 *   - **Named owner** (#228, `APPSTRATE_BOOTSTRAP_OWNER_EMAIL`) — the
 *     dashboard pre-fills + locks the email field, the operator just
 *     picks a password.
 *   - **Bootstrap token** (#344 Layer 2b, unattended installs) — the
 *     operator claims ownership at `<appUrl>/claim` by pasting the
 *     printed token. Single-use, dies on first redemption or as soon
 *     as any organization exists.
 *
 * Renders nothing in true open mode (Tier 0 interactive). Called by
 * both Tier 0 and Docker-tier installers right before `outro()`.
 */
export function printBootstrapFollowup(
  appUrl: string,
  bootstrap: BootstrapOverrides,
  note: (message: string, title?: string) => void = clack.note,
): void {
  const email = bootstrap.bootstrapOwnerEmail;
  if (email) {
    note(
      `Open  ${appUrl}/register\nSign up as  ${email}  (the form is pre-filled and locked)\nPick any password — the org "${bootstrap.bootstrapOrgName ?? "Default"}" is created automatically.`,
      "Next: create your owner account",
    );
    return;
  }
  const token = bootstrap.bootstrapToken;
  if (token) {
    note(
      `Open  ${appUrl}/claim\nPaste the token below + your owner email/password.\n\n  Bootstrap token:\n  ${token}\n\nThe token is single-use, also stored in <dir>/.env\nas AUTH_BOOTSTRAP_TOKEN. Public signup is disabled\nuntil you claim the instance.`,
      "Closed-by-default install — claim ownership",
    );
  }
}

export async function installCommand(opts: InstallOptions): Promise<void> {
  intro("Appstrate install");

  try {
    const autoConfirm = opts.autoConfirm === true;
    const tier = await resolveTier(opts.tier, { autoConfirm });
    const dir = await resolveDir(opts.dir, { autoConfirm });
    // "Non-interactive" means the caller has opted out of every prompt —
    // either via `--tier` (scripted installs) or `--yes` (curl|bash, CI,
    // Docker). In that mode we fail fast on port conflicts rather than
    // blocking on `askText`, and every confirm() returns its default.
    const nonInteractive = opts.tier !== undefined || autoConfirm;

    // Detect install mode BEFORE port resolution. On upgrade the ports
    // we'll actually use are inherited from the existing `.env` (see
    // `mergeEnv` — existing wins by default), and the existing stack
    // is already bound to those ports, so a bind-based preflight would
    // always false-positive against our own running containers. We
    // pass the install mode + parsed env through to the port resolvers
    // so they can skip the preflight on the inherited path.
    const installState = await detectInstallMode(dir);

    // For docker tiers, resolve the compose project name BEFORE port
    // resolution so the resolver can cross-check with `docker compose ls`:
    // a port bound by OUR running stack is safe to skip-preflight, a
    // port bound by anyone else is not. Tier 0 has no compose project.
    const project = tier === 0 ? undefined : await resolveProjectName(dir);

    // Under --yes, soften port conflicts by auto-picking the next free
    // port instead of failing fast. Rationale: the one-liner installer's
    // user contract is "paste into terminal, get a working Appstrate"
    // — and the single most common snag is a stale dev server still
    // bound to :3000 from an earlier session. A strict --tier N script
    // keeps the fail-fast semantics so CI/automation surfaces the drift.
    const port = await resolveAppstratePort(
      opts.port,
      nonInteractive,
      installState.mode,
      installState.existing,
      dir,
      project?.name,
      { autoPick: autoConfirm },
    );
    const minioConsolePort =
      tier === 3
        ? await resolveMinioConsolePort(
            opts.minioConsolePort,
            nonInteractive,
            installState.mode,
            installState.existing,
            dir,
            project?.name,
            { autoPick: autoConfirm },
          )
        : undefined;

    // Closed-mode bootstrap (issue #228) — env var > prompt > undefined.
    // Skipped on upgrades (mergeEnv preserves whatever the user had) and
    // on Tier 0 interactive (local dev — invitation-only is meaningless).
    const bootstrap = await resolveBootstrapEmail({
      tier,
      mode: installState.mode,
      nonInteractive,
    });

    if (tier === 0) {
      await installTier0(dir, port, { autoConfirm, bootstrap });
    } else {
      await installDockerTier(dir, tier, port, minioConsolePort, {
        force: opts.force ?? false,
        mode: installState.mode,
        existing: installState.existing,
        project: project!,
        autoConfirm,
        bootstrap,
      });
    }
  } catch (err) {
    exitWithError(err);
  }
}

/**
 * Resolve the closed-mode bootstrap inputs for a fresh install (issue #228).
 *
 * Order of precedence:
 *   1. `APPSTRATE_BOOTSTRAP_OWNER_EMAIL` env var — the IaC / `curl|bash`
 *      path. Always wins, on every tier and mode. Invalid email throws
 *      so the misconfiguration surfaces at install time, not at first
 *      signup.
 *   2. Interactive prompt — fired only on a Tier ≥ 1 fresh install when
 *      no env var is set and the install is interactive. Empty input
 *      means "skip" (open mode + footer pointer in the generated `.env`).
 *   3. Otherwise → undefined (open mode).
 *
 * Upgrades short-circuit to undefined: `mergeEnv` preserves whatever
 * `AUTH_*` keys the user already has in their `.env`, so re-running
 * `appstrate install` on a closed-mode instance never silently flips
 * the policy.
 */
export async function resolveBootstrapEmail(opts: {
  tier: Tier;
  mode: InstallMode;
  nonInteractive: boolean;
}): Promise<BootstrapOverrides> {
  const fromEnv = process.env.APPSTRATE_BOOTSTRAP_OWNER_EMAIL?.trim();
  if (fromEnv) {
    if (!isValidBootstrapEmail(fromEnv)) {
      throw new Error(
        `APPSTRATE_BOOTSTRAP_OWNER_EMAIL="${fromEnv}" is not a valid email — aborting install.`,
      );
    }
    const orgName = process.env.APPSTRATE_BOOTSTRAP_ORG_NAME?.trim();
    return { bootstrapOwnerEmail: fromEnv, bootstrapOrgName: orgName || undefined };
  }
  if (opts.mode === "upgrade") return {};
  // Tier 0 (local dev) stays open — invitation-only is meaningless when
  // the platform binds to localhost and survives only as long as the
  // dev shell.
  if (opts.tier === 0) return {};
  // Non-interactive Docker tier on a fresh install: no named owner and
  // no env override means the historical default was a silently-public
  // VPS (#344). Generate a single-use bootstrap token instead — the
  // operator claims ownership at `<appUrl>/claim` after the install
  // banner. Dominant `curl|bash -s -- --yes` path.
  if (opts.nonInteractive) {
    return { bootstrapToken: generateBootstrapToken() };
  }

  // Interactive Docker tier, fresh install, no env override → ask once.
  // Empty input is the documented "skip" path; clack returns "" on Enter
  // with no `placeholder`. The note explains *why* this prompt exists so
  // the user understands the trade-off before answering.
  clack.note(
    "Closed mode locks down public signup so only invited users can join.\nLeave empty to keep the default open mode (anyone with the URL can sign up).",
    "Invitation-only mode (optional)",
  );
  const answer = (await askText("Bootstrap admin email (or empty to skip):", "")).trim();
  if (!answer) return {};
  if (!isValidBootstrapEmail(answer)) {
    clack.log.warn(
      `"${answer}" doesn't look like an email — keeping open mode. Edit .env manually to enable closed mode later.`,
    );
    return {};
  }
  return { bootstrapOwnerEmail: answer };
}

/** Default-shaped `ExistingInstall` used when the resolver is called without upgrade context. */
const NO_EXISTING_INSTALL: ExistingInstall = { hasEnv: false, hasCompose: false, existingEnv: {} };

/** DI seam for the cross-check with `docker compose ls` — tests inject a fake, production uses the real helper. */
export interface PortResolverDeps {
  findRunningComposeProject?: (name: string) => Promise<RunningComposeProject | null>;
  /**
   * When the preferred port is busy under non-interactive mode, probe
   * upward (port+1, port+2, …) and use the first free one instead of
   * failing fast. Wired to `--yes` by `installCommand` so `curl | bash`
   * re-runs that hit a stale process on :3000 just pick :3001 — matches
   * the "it just works" contract of the bootstrap installer. Defaulting
   * to false keeps explicit `--tier N` scripted installs strict: they
   * surface the conflict instead of silently drifting the port.
   *
   * Bounded scan (`AUTO_PICK_MAX_ATTEMPTS`) so a host with dense port
   * usage can't take us on an O(65k) walk before failing — we'd rather
   * error cleanly and let the user pass `--port <n>` explicitly.
   */
  autoPick?: boolean;
}

/**
 * Upper bound on the auto-pick scan window. 20 is deliberately small:
 * the goal is to tolerate "a stale dev server is still on :3000",
 * not to gracefully handle a host where the next 200 ports are busy.
 * If 20 probes come back busy it's almost always a broader problem
 * (port-scanning tool, misconfigured firewall, thousands of containers)
 * that the user should see as an error rather than a silent drift.
 */
const AUTO_PICK_MAX_ATTEMPTS = 20;

/**
 * Decide whether the inherited port belongs to OUR running stack. Only
 * a positive match (a live compose project whose configFiles point at
 * `<dir>/docker-compose.yml`) lets us skip the preflight safely —
 * otherwise a third-party process may have squatted the port after a
 * `docker compose down` and we want the early, friendly preflight error
 * rather than the late failure from `docker compose up`.
 *
 * Tier 0 has no compose project, so `projectName === undefined` keeps
 * the legacy behaviour (skip preflight on hasEnv alone — there's no
 * cross-check we can perform).
 */
async function ourStackOwnsPort(
  dir: string | undefined,
  projectName: string | undefined,
  findRunning: (name: string) => Promise<RunningComposeProject | null>,
): Promise<boolean> {
  if (projectName === undefined) return true;
  if (dir === undefined) return true;
  const running = await findRunning(projectName);
  if (!running) return false;
  const expected = join(dir, "docker-compose.yml");
  return running.configFiles.some((p) => p === expected);
}

/** Resolve the Appstrate host port: inherit-on-upgrade (when our stack owns it) or parse-and-preflight. */
export async function resolveAppstratePort(
  raw: string | undefined,
  nonInteractive: boolean,
  mode: InstallMode = "fresh",
  existing: ExistingInstall = NO_EXISTING_INSTALL,
  dir?: string,
  projectName?: string,
  deps: PortResolverDeps = {},
): Promise<number> {
  const envValue = process.env.APPSTRATE_PORT;
  const requested = parsePort(raw, envValue, DEFAULT_PORT, "--port");
  // Gated on `hasEnv`: a dir with only a stray compose file reaches
  // mode="upgrade" too, but has no port to inherit — mergeEnv would
  // produce fresh ports in that case, so we need the real preflight.
  if (mode === "upgrade" && existing.hasEnv) {
    const findRunning = deps.findRunningComposeProject ?? findRunningComposeProjectImport;
    if (await ourStackOwnsPort(dir, projectName, findRunning)) {
      const inherited = readExistingPort(existing.existingEnv, "PORT", DEFAULT_PORT);
      // Warn only when the user actually expressed a divergent choice
      // (either `--port` or `$APPSTRATE_PORT`); `requested === DEFAULT_PORT`
      // via pure fallback is not a user intent we need to flag.
      const userExpressed = (raw ?? envValue ?? "") !== "";
      if (userExpressed && requested !== inherited) {
        clack.log.warn(
          `port ${requested} ignored on upgrade — existing .env pins PORT=${inherited}, and secrets/config are preserved across upgrades (see mergeEnv). Edit <dir>/.env manually to change the port.`,
        );
      }
      return inherited;
    }
  }
  return ensurePortFree(
    requested,
    "APPSTRATE_PORT",
    "--port",
    "Appstrate",
    nonInteractive,
    deps.autoPick ?? false,
  );
}

/** Resolve the MinIO console port (Tier 3); preflight-skip additionally gated on MINIO_ROOT_PASSWORD so a Tier 1/2 → 3 upgrade still probes the net-new port. */
export async function resolveMinioConsolePort(
  raw: string | undefined,
  nonInteractive: boolean,
  mode: InstallMode = "fresh",
  existing: ExistingInstall = NO_EXISTING_INSTALL,
  dir?: string,
  projectName?: string,
  deps: PortResolverDeps = {},
): Promise<number> {
  const envValue = process.env.APPSTRATE_MINIO_CONSOLE_PORT;
  const requested = parsePort(raw, envValue, DEFAULT_MINIO_CONSOLE_PORT, "--minio-console-port");
  // MINIO_ROOT_PASSWORD presence is the unambiguous signal that the
  // previous install actually ran MinIO — absence means MinIO is
  // net-new on this upgrade and its port must genuinely be free.
  const minioWasPresent =
    existing.hasEnv && typeof existing.existingEnv.MINIO_ROOT_PASSWORD === "string";
  if (mode === "upgrade" && minioWasPresent) {
    const findRunning = deps.findRunningComposeProject ?? findRunningComposeProjectImport;
    if (await ourStackOwnsPort(dir, projectName, findRunning)) {
      const inherited = readExistingPort(
        existing.existingEnv,
        "MINIO_CONSOLE_PORT",
        DEFAULT_MINIO_CONSOLE_PORT,
      );
      const userExpressed = (raw ?? envValue ?? "") !== "";
      if (userExpressed && requested !== inherited) {
        clack.log.warn(
          `port ${requested} ignored on upgrade — existing .env pins MINIO_CONSOLE_PORT=${inherited}. Edit <dir>/.env manually to change the port.`,
        );
      }
      return inherited;
    }
  }
  return ensurePortFree(
    requested,
    "APPSTRATE_MINIO_CONSOLE_PORT",
    "--minio-console-port",
    "MinIO console",
    nonInteractive,
    deps.autoPick ?? false,
  );
}

/** Read a port from parsed `.env`, falling back to `fallback` when absent (secrets.ts elides defaults) or malformed. */
function readExistingPort(existingEnv: EnvVars, key: string, fallback: number): number {
  const raw = existingEnv[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    clack.log.warn(
      `Ignoring invalid ${key}="${raw}" in existing .env — using default ${fallback}. Fix the .env manually to silence this warning.`,
    );
    return fallback;
  }
  return parsed;
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
 * Probe `port` upward (port+1, port+2, …) until a free one is found or
 * the attempt budget is exhausted. Skips the input `port` itself (the
 * caller already proved it's busy). Returns `null` when the whole
 * window is busy or the scan walks past 65535 — the caller decides
 * whether that's fatal or just a fallback to the strict error.
 */
async function findNextFreePort(startExclusive: number): Promise<number | null> {
  for (let offset = 1; offset <= AUTO_PICK_MAX_ATTEMPTS; offset++) {
    const candidate = startExclusive + offset;
    if (candidate > 65535) return null;
    if (await isPortAvailable(candidate)) return candidate;
  }
  return null;
}

/**
 * Probe the port; on conflict, print a best-effort "who's holding it"
 * hint and either
 *   - pick the next free port silently-ish (non-interactive + autoPick,
 *     i.e. the `curl|bash --yes` path — the user explicitly asked for
 *     zero prompts, and a stale :3000 is the common failure mode),
 *   - fail fast with a message naming both flag and env-var escape
 *     hatches (non-interactive without autoPick — scripted installs
 *     that want strict semantics), or
 *   - prompt the user for a new port (interactive).
 */
async function ensurePortFree(
  port: number,
  envVar: string,
  flagName: string,
  label: string,
  nonInteractive: boolean,
  autoPick = false,
): Promise<number> {
  if (await isPortAvailable(port)) return port;

  const holder = await describeProcessOnPort(port);
  const holderHint = holder ? ` Held by ${holder}.` : "";

  if (nonInteractive && autoPick) {
    const next = await findNextFreePort(port);
    if (next !== null) {
      // log.info (not warn) because this is the designed happy path of
      // --yes — "just pick a free port". The message still names the
      // override knobs so a user who does care can redirect on re-run.
      clack.log.info(
        `Port ${port} (${label}) in use.${holderHint} Auto-picked ${next} instead — pass ${flagName} <n> or pipe via \`curl … | ${envVar}=<n> bash\` to override.`,
      );
      return next;
    }
    // Fall through to the strict error below. The scan window was
    // bounded (AUTO_PICK_MAX_ATTEMPTS), and a host with that many
    // contiguous busy ports is almost never something the installer
    // should be papering over silently.
  }

  if (nonInteractive) {
    // Shell gotcha: `${envVar}=<n> curl -fsSL … | bash` sets the env var
    // for `curl` only, not for the piped `bash` that exec's this CLI.
    // We call it out explicitly because `curl | bash` is the documented
    // one-liner and this mistake is common enough to merit a hint in
    // the error itself rather than buried in a support thread.
    throw new Error(
      `Port ${port} is already in use (${label}).${holderHint} ` +
        `Re-run with ${flagName} <n>, or pipe via \`curl -fsSL https://get.appstrate.dev | ${envVar}=<n> bash\` ` +
        `(note: \`${envVar}=<n> curl … | bash\` sets the var for curl, not bash — use the syntax above instead).`,
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
 * DI seam for `resolveTier()` — production wires `clack` + the real
 * Docker probe; tests inject deterministic stubs.
 */
export interface TierResolverDeps {
  select?: typeof clack.select;
  isCancel?: typeof clack.isCancel;
  note?: typeof clack.note;
  isDockerAvailable?: () => Promise<boolean>;
  /**
   * When true, skip the `clack.select` prompt entirely and return the
   * Docker-aware default (3 if Docker reachable, else 0). See `#199`:
   * clack calls `setRawMode` which trips a Bun macOS regression inside
   * the `bun build --compile` binary — bypassing the prompt sidesteps
   * the bug regardless of upstream Bun fix status.
   */
  autoConfirm?: boolean;
}

/**
 * Parse `--tier` or drop into an interactive select. `clack`'s
 * `select` with 4 options reads better than free-form text and avoids
 * the "what did I type?" typo recovery. Exported so unit tests can
 * lock down the validation contract without invoking the prompt.
 *
 * Interactive default: Tier 3 (full production stack) when Docker is
 * reachable — the happy path for the one-liner installer is
 * `press Enter → working production-grade Appstrate`. When Docker is
 * missing we silently downgrade the default to Tier 0 and surface a
 * friendly note so the user is not pushed into a tier they cannot
 * actually run; the fatal `DockerMissingError` in `installDockerTier`
 * remains the safety net for the explicit-pick case.
 */
export async function resolveTier(
  raw: string | undefined,
  deps: TierResolverDeps = {},
): Promise<Tier> {
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (parsed === 0 || parsed === 1 || parsed === 2 || parsed === 3) return parsed as Tier;
    throw new Error(`Invalid --tier value "${raw}". Expected 0, 1, 2, or 3.`);
  }
  const select = deps.select ?? clack.select;
  const isCancel = deps.isCancel ?? clack.isCancel;
  const note = deps.note ?? clack.note;
  const probe = deps.isDockerAvailable ?? isDockerAvailable;

  // --yes path: bypass the clack.select call entirely (never enters raw
  // mode → never trips the Bun macOS keypress regression from #199) and
  // accept the Docker-aware default #180 already set for interactive
  // picks. The note() call is still informative so the user sees which
  // tier was chosen and how to override it on the next run.
  if (deps.autoConfirm === true) {
    const dockerOk = await probe();
    const autoTier: Tier = dockerOk ? 3 : 0;
    note(
      dockerOk
        ? "--yes: Tier 3 selected automatically (Docker detected). Re-run with `--tier N` to override."
        : "--yes: Tier 0 selected automatically (Docker not detected). Install Docker and re-run with `--tier 3` for the production stack.",
    );
    return autoTier;
  }

  // Prompting requires a TTY. If stdin isn't a TTY (CI, `curl | bash`
  // inside a Dockerfile, cron) clack would crash with no readable
  // error — surface a clear message pointing at the `--tier` escape
  // hatch instead. See `scripts/bootstrap.sh` for the matching branch.
  // Gated on the real `clack.select` so tests injecting `deps.select`
  // bypass this and exercise the interactive branch deterministically.
  if (select === clack.select && !process.stdin.isTTY) {
    throw new Error(
      "Cannot prompt for tier: stdin is not a TTY. " +
        "Re-run with `--tier N` (0, 1, 2, or 3), or pass `--yes` to accept the Docker-aware default, " +
        "e.g. `curl -fsSL https://get.appstrate.dev | bash -s -- --yes` " +
        "or `curl -fsSL https://get.appstrate.dev | bash -s -- --tier 3`.",
    );
  }
  const dockerOk = await probe();
  const defaultTier: Tier = dockerOk ? 3 : 0;
  if (!dockerOk) {
    note(
      "Docker not detected — Tier 0 selected by default. Install Docker Desktop and re-run for the production stack (Tier 3).",
    );
  }
  const chosen = await select<Tier>({
    message: "Which tier do you want to install?",
    initialValue: defaultTier,
    options: [
      { value: 3, label: "Tier 3 — Production (PostgreSQL + Redis + MinIO) — recommended" },
      { value: 2, label: "Tier 2 — Standard (PostgreSQL + Redis, no object storage)" },
      { value: 1, label: "Tier 1 — Minimal (PostgreSQL only, dev/testing)" },
      { value: 0, label: "Tier 0 — Hobby (no Docker, evaluation only)" },
    ],
  });
  if (isCancel(chosen)) {
    clack.cancel("Cancelled.");
    process.exit(130);
  }
  return chosen;
}

/**
 * DI seam for `resolveDir()` — lets tests exercise the `--yes` short
 * circuit without spawning a real askText prompt.
 */
export interface DirResolverDeps {
  /** When true, accept `DEFAULT_INSTALL_DIR` without prompting. */
  autoConfirm?: boolean;
}

/**
 * Parse `--dir` or prompt for it, then reject newlines / NUL bytes and
 * normalize to an absolute path. Exported for unit testing.
 */
export async function resolveDir(
  raw: string | undefined,
  deps: DirResolverDeps = {},
): Promise<string> {
  // --yes path: skip askText (no raw mode, no Bun bug, works in CI).
  if (raw === undefined && deps.autoConfirm === true) {
    return resolve(DEFAULT_INSTALL_DIR);
  }
  if (raw === undefined && !process.stdin.isTTY) {
    throw new Error(
      "Cannot prompt for install directory: stdin is not a TTY. " +
        "Re-run with `--dir <path>` or `--yes` to accept ~/appstrate, " +
        "e.g. `curl -fsSL https://get.appstrate.dev | bash -s -- --yes` " +
        "or `curl -fsSL https://get.appstrate.dev | bash -s -- --tier 3 --dir ~/appstrate`.",
    );
  }
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

async function installTier0(
  dir: string,
  port: number,
  opts: { autoConfirm: boolean; bootstrap: BootstrapOverrides },
): Promise<void> {
  const appUrl = appUrlForPort(port);
  // Bun — either already present, or install it via the upstream script.
  // We only care whether a working Bun is reachable; the actual path
  // resolution happens inside `runBunInstall` / `spawnDevServer` via
  // `bunEnv()`, which prepends `~/.bun/bin` to PATH so the just-installed
  // copy is picked up by a bare `spawn("bun", ...)`.
  const bun = detectBun();
  if (!bun.found) {
    // --yes: accept the install. Matches rustup/uv behaviour — both
    // install their bundled toolchain without prompting under `-y`.
    const proceed =
      opts.autoConfirm ||
      (await confirm(
        "Bun is not installed. Install it now via `curl https://bun.sh/install | bash`?",
      ));
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
  const env = generateEnvForTier(0, appUrl, { port }, opts.bootstrap);
  await writeTier0Env(dir, renderEnvFile(env));

  // Run dev server? Under --yes, auto-start matches the "curl|bash and
  // it just works" expectation — equivalent to how Bun's installer prints
  // `bun --help` without asking and uv's drop-in leaves the binary
  // immediately usable.
  const shouldStart = opts.autoConfirm ? true : await confirm("Start the dev server now?");
  if (!shouldStart) {
    printBootstrapFollowup(appUrl, opts.bootstrap);
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
  printBootstrapFollowup(appUrl, opts.bootstrap);
  outro(`Appstrate is running at ${appUrl} (pid ${pid}).\nKill it with \`kill ${pid}\` when done.`);
}

/**
 * Resolve the Compose project name for this install directory.
 *
 * Two cases:
 *   1. `.appstrate/project.json` exists → use the recorded name
 *      (authoritative; never re-derive, never drift).
 *   2. Fresh install → derive from the absolute dir path (stable +
 *      unique + readable). The caller writes the sidecar on success
 *      so subsequent runs hit case (1).
 *
 * Exported for unit testing.
 */
export async function resolveProjectName(
  dir: string,
): Promise<{ name: string; origin: "sidecar" | "derived" }> {
  const recorded = await readProjectFile(dir);
  if (recorded) return { name: recorded.projectName, origin: "sidecar" };
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
  const running = await findRunningComposeProjectImport(projectName);
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
  opts: {
    force: boolean;
    mode: InstallMode;
    existing: ExistingInstall;
    project: { name: string; origin: "sidecar" | "derived" };
    autoConfirm: boolean;
    bootstrap: BootstrapOverrides;
  },
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

  // Informational pre-flight: Docker's default address pool (~31 user-defined
  // networks) is easy to exhaust once Appstrate's stack plus per-run networks
  // land on top of existing projects. Warn early so the user can prune or tune
  // `daemon.json` before the first run fails with the opaque `ErrNoMoreSubnets`.
  const budget = await checkDockerNetworkBudget();
  if (budget) {
    clack.note(
      [
        `Detected ${budget.used} Docker networks on this host (default ceiling ≈ 31).`,
        "Appstrate consumes several networks at boot + 1 per agent run, so you may",
        "run out of subnets shortly after install.",
        "",
        "  Quick fix:   docker network prune",
        "  Permanent:   tune `default-address-pools` in daemon.json — see",
        "               https://github.com/appstrate/appstrate/blob/main/examples/self-hosting/README.md#docker-network-pool-tuning",
      ].join("\n"),
      "Docker network pool near capacity",
    );
  }

  // Upgrade detection already ran in `installCommand` (it's needed
  // earlier to skip the port preflight against our own running stack
  // on re-runs — see `resolveAppstratePort`). Reuse the result rather
  // than re-probing the filesystem.
  const { mode, existing, project } = opts;
  if (mode === "upgrade") {
    // Under --yes, proceed with the upgrade: secrets are preserved via
    // `mergeEnv` and files are backed up (`backupFiles` below), so the
    // operation is fully reversible even without the confirm. The note()
    // makes the decision visible so a user re-running `curl|bash --yes`
    // on a live stack isn't surprised.
    if (opts.autoConfirm) {
      clack.log.info(
        `--yes: upgrading existing install at ${dir} (secrets preserved, backups written to <file>.backup).`,
      );
    } else {
      const proceed = await confirm(
        `An existing install was detected at ${dir}. Existing secrets (BETTER_AUTH_SECRET, CONNECTION_ENCRYPTION_KEY, POSTGRES_PASSWORD, …) will be preserved; the compose file will be replaced with the Tier ${tier} template. Continue?`,
      );
      if (!proceed) throw new Error("Upgrade cancelled.");
    }
  }

  // Preflight: does another install already claim this project name?
  // Only meaningful on the derived path — a sidecar-recorded name IS
  // the running project by definition, so the collision check would
  // just reject the user's own running stack.
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
      const fresh = generateEnvForTier(tier, appUrl, { port, minioConsolePort }, opts.bootstrap);
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
  printBootstrapFollowup(appUrl, opts.bootstrap);
  outro(
    `Appstrate is running at ${appUrl}.\n` +
      `Manage the stack from ${dir}:\n` +
      `  docker compose --project-name ${project.name} logs -f\n` +
      `  docker compose --project-name ${project.name} down`,
  );
}
