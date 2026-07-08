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

import { closeSync, openSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import * as clack from "@clack/prompts";
import { intro, outro, askText, confirm, spinner, exitWithError } from "../lib/ui.ts";
import {
  generateBootstrapToken,
  generateEnvForTier,
  isRemoteAppUrl,
  isValidBootstrapEmail,
  parseAppUrl,
  renderEnvFile,
  type BootstrapOverrides,
  type RunBackendEnv,
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
import {
  openBrowser,
  isPortAvailable,
  describeProcessOnPort,
  detectLanIpv4,
  isIpv4,
  runCommand,
} from "../lib/install/os.ts";
import { generateRunnerToken } from "../lib/runner/config-files.ts";
import {
  RUNNER_DEFAULT_PORT,
  RUNNER_DEFAULT_SOCKET_PATH,
  RUNNER_RUNTIME_DIR,
  RUNNER_TOKEN_ENV,
} from "../lib/runner/constants.ts";
import {
  detectInstallMode,
  inferInstalledTier,
  mergeEnv,
  backupFiles,
  cleanupBackups,
  runWithRollback,
  type ExistingInstall,
  type InstallMode,
} from "../lib/install/upgrade.ts";
import type { EnvVars } from "../lib/install/secrets.ts";
import {
  defaultInstallDir,
  deriveProjectName,
  readProjectFile,
  writeProjectFile,
} from "../lib/install/project.ts";
import { appUrlForPort, runningBanner } from "../lib/install/report.ts";
import {
  formatComposeUpgradeResult,
  resolveComposeUpgradeDir,
  runComposeUpgrade,
  type ComposeUpgradeDeps,
} from "../lib/install/compose-upgrade.ts";
import { CLI_VERSION } from "../lib/version.ts";

export interface InstallOptions {
  /** Skip the tier prompt (valid values: "0" | "1" | "2" | "3"). */
  tier?: string;
  /** Skip the directory prompt. */
  dir?: string;
  /** Override the host port the platform binds to (Tier 0/1/2/3). */
  port?: string;
  /**
   * Public URL of the platform (issue #822) — what browsers, OAuth
   * redirects, and email links use. Independent of `--port` (the host
   * bind port / reverse-proxy upstream). Origin only, e.g.
   * `https://appstrate.example.com`. Also honored via
   * `APPSTRATE_APP_URL`. Defaults to `http://localhost:<port>`.
   */
  appUrl?: string;
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
   *   - dir: `defaultInstallDir()` (~/appstrate)
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
  /**
   * Agent execution backend: `docker` (default) or `firecracker`. Also
   * honored via `APPSTRATE_RUN_ADAPTER`. Only meaningful on Docker tiers
   * (1/2/3); an explicit `firecracker` request on tier 0 is a hard error
   * (see `assertRunAdapterCompatibleWithTier`). See `resolveRunBackend`.
   */
  runAdapter?: string;
  /** Firecracker/remote: URL of an existing appstrate-runner daemon (http://<ipv4>:3100). */
  runnerUrl?: string;
  /** Firecracker: shared bearer token for the runner daemon. */
  runnerToken?: string;
  /** Firecracker/same-host: this host's LAN IPv4 (overrides auto-detection). */
  hostIp?: string;
}

const DEFAULT_PORT = 3000;

/**
 * Write a single line directly to the controlling terminal, bypassing
 * stdout. Used to print the bootstrap token banner so a piped install
 * (`appstrate install --yes 2>&1 | tee install.log`) doesn't capture
 * the secret into a tee'd log file with default umask.
 *
 * The pattern matches rustup's "[CONFIDENTIAL]" output. Falls back to
 * stderr if `/dev/tty` isn't writable (Windows, detached daemons, CI
 * runners with no TTY) — in those environments the operator has
 * already opted into a non-interactive-output context, and stderr is
 * the safest remaining sink.
 */
function writeToTty(line: string): void {
  const out = line.endsWith("\n") ? line : `${line}\n`;
  try {
    const fd = openSync("/dev/tty", "w");
    try {
      writeSync(fd, out);
    } finally {
      closeSync(fd);
    }
  } catch {
    process.stderr.write(out);
  }
}

/**
 * Post-install browser deep-link. A fresh install has no session and no
 * account yet, so the first thing the operator needs is the signup form —
 * open `/register` directly instead of the bare root (which only bounces
 * there after an extra redirect). One carve-out: the **bootstrap token**
 * flow (unattended closed install) claims ownership at `/claim` by pasting
 * the printed token, NOT at `/register`, so it keeps the root landing and
 * the follow-up note points the operator at `/claim`.
 *
 * `localUrl` (not `appUrl`) because the browser runs on the install host
 * and must hit the local bind port; a remote `appUrl` is unreachable until
 * the operator wires their reverse proxy. The named-owner email is already
 * pre-filled + locked server-side (app config), so no query param is
 * needed on the URL.
 */
export function postInstallBrowserUrl(localUrl: string, bootstrap: BootstrapOverrides): string {
  if (bootstrap.bootstrapToken) return localUrl;
  return `${localUrl}/register`;
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
 *
 * Token-leak hardening: when stdout is NOT a TTY (the install output
 * is being piped/tee'd to a file), the token line is written directly
 * to `/dev/tty` instead of through clack.note. The clack-rendered
 * note still appears with the URL + .env hint, but the secret itself
 * goes only to the operator's terminal — not to disk.
 */
export function printBootstrapFollowup(
  appUrl: string,
  bootstrap: BootstrapOverrides,
  note: (message: string, title?: string) => void = clack.note,
): void {
  const email = bootstrap.bootstrapOwnerEmail;
  if (email) {
    note(
      `Opened  ${appUrl}/register  in your browser.\nSign up as  ${email}  (the form is pre-filled and locked)\nPick any password — the org "${bootstrap.bootstrapOrgName ?? "Default"}" is created automatically.`,
      "Next: create your owner account",
    );
    return;
  }
  const token = bootstrap.bootstrapToken;
  if (token) {
    const stdoutIsTty = process.stdout.isTTY === true;
    if (stdoutIsTty) {
      // Interactive install: stdout IS the operator's terminal, so
      // printing the token inline is fine — and clack.note frames it
      // nicely. No risk of capture into a log file.
      note(
        `Open  ${appUrl}/claim\nPaste the token below + your owner email/password.\n\n  Bootstrap token:\n  ${token}\n\nThe token is single-use, also stored in <dir>/.env\nas AUTH_BOOTSTRAP_TOKEN. Public signup is disabled\nuntil you claim the instance.`,
        "Closed-by-default install — claim ownership",
      );
      return;
    }
    // Piped/tee'd install: render the framing note via clack (which
    // hits stdout — fine, doesn't contain the secret) and write the
    // token itself directly to the TTY.
    note(
      `Open  ${appUrl}/claim\nThe bootstrap token is printed below directly to your\nterminal (and stored in <dir>/.env, mode 0600). It does\nNOT appear in the install log if you tee'd this output.\nPublic signup is disabled until you claim the instance.`,
      "Closed-by-default install — claim ownership",
    );
    writeToTty(`\n[appstrate bootstrap token — keep secret]\n  ${token}\n`);
  }
}

export async function installCommand(opts: InstallOptions): Promise<void> {
  intro("Appstrate install");

  try {
    const autoConfirm = opts.autoConfirm === true;
    // Resolve the directory FIRST: whether this is an upgrade (and which
    // tier is installed) must be known BEFORE the tier prompt, otherwise the
    // prompt would solicit a tier choice on upgrades only to discard it in
    // favor of the inherited one.
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

    // On upgrade, an unexpressed tier inherits the installed stack's tier —
    // and SKIPS the tier prompt entirely (a prompt whose answer would be
    // overridden is worse than no prompt). Re-running `appstrate install
    // --yes` on a Tier 3 deployment must not rewrite the compose file with
    // the Tier 2 default template — that would drop the MinIO service while
    // `mergeEnv` keeps the S3 config, leaving every stored object (packages,
    // uploads, run artifacts) unreachable. Same for a Tier 0 dir silently
    // converted to Docker/Postgres (PGlite data hidden). Same warn-and-
    // inherit contract as ports and APP_URL: the documented way to change
    // tiers on an existing install is an explicit `--tier N`.
    const installedTier = installState.mode === "upgrade" ? await inferInstalledTier(dir) : null;
    let tierArg = opts.tier;
    if (tierArg === undefined && installedTier !== null) {
      tierArg = String(installedTier);
      clack.log.info(
        `Existing Tier ${installedTier} install detected — keeping Tier ${installedTier}. ` +
          `Switching tiers rewrites docker-compose.yml with a different service set ` +
          `(and can change the storage backend, hiding existing files), so it requires ` +
          `an explicit \`--tier N\`.`,
      );
    }
    let tier = await resolveTier(tierArg, { autoConfirm });

    // Defense in depth: reconcile is a no-op when the inheritance above
    // already applied (installed === resolved) and still guards the
    // remaining cells of the matrix.
    if (installState.mode === "upgrade") {
      const reconciled = reconcileUpgradeTier(tier, tierArg, installedTier);
      if (reconciled.note) clack.log.info(reconciled.note);
      tier = reconciled.tier;
    }

    // Fail fast on an EXPLICIT firecracker request on tier 0 — before any
    // install work starts. Absence of the flag stays silent (tier 0 simply
    // never offers the backend choice).
    assertRunAdapterCompatibleWithTier(tier, readRawRunAdapter(opts.runAdapter));

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
    // Closed-mode bootstrap (issue #228) — env var > prompt > undefined.
    // Skipped on upgrades (mergeEnv preserves whatever the user had) and
    // on Tier 0 interactive (local dev — invitation-only is meaningless).
    const bootstrap = await resolveBootstrapEmail({
      tier,
      mode: installState.mode,
      nonInteractive,
    });

    // Public URL (issue #822) — flag/env/prompt, defaults to
    // http://localhost:<port>. Resolved AFTER the port so the local
    // default reflects the (possibly auto-picked) final port.
    const appUrl = await resolveAppUrl(opts.appUrl, port, {
      tier,
      mode: installState.mode,
      existing: installState.existing,
      nonInteractive,
    });

    if (tier === 0) {
      await installTier0(dir, port, appUrl, { autoConfirm, bootstrap });
    } else {
      // Agent execution backend (docker | firecracker) — offered only on
      // Docker tiers. Docker stays the default; firecracker mints a runner
      // token, writes the runner env, and (same-host) drives the daemon
      // install after the stack is up.
      const runBackend = await resolveRunBackend({
        runAdapter: opts.runAdapter,
        runnerUrl: opts.runnerUrl,
        runnerToken: opts.runnerToken,
        hostIp: opts.hostIp,
        appPort: port,
        nonInteractive,
      });
      await installDockerTier(dir, tier, port, appUrl, {
        force: opts.force ?? false,
        mode: installState.mode,
        existing: installState.existing,
        project: project!,
        autoConfirm,
        nonInteractive,
        bootstrap,
        runBackend,
      });
    }
  } catch (err) {
    exitWithError(err);
  }
}

/**
 * Reconcile the resolved tier with the tier of an already-installed stack
 * (upgrade mode only). The primary inheritance now happens BEFORE tier
 * resolution in `installCommand` (the prompt is skipped and the installed
 * tier passed through as the tier argument); this pure function remains as
 * the unit-testable defense-in-depth contract behind it:
 *
 *   - explicit tier argument always wins (scripted tier changes stay
 *     possible; the operator owns the storage migration that comes with
 *     them);
 *   - nothing recognizable installed (hand-rolled deploy) or a Tier 0
 *     resolution → keep the resolved tier;
 *   - otherwise inherit the installed tier (0-3 — a Tier 0 dir must not be
 *     silently converted to Docker/Postgres either, that hides all PGlite
 *     data) and explain why.
 *
 * Without this, changing the smart default (Tier 3 → Tier 2, issue #829)
 * would make every `install --yes` re-run on an existing Tier 3 deployment
 * silently swap its compose template — and the reverse hazard (a Tier 2
 * install silently upgraded to the Tier 3 template, flipping storage from
 * filesystem to S3 and hiding all existing files) predates the default
 * change. Inheritance closes both directions.
 */
export function reconcileUpgradeTier(
  resolved: Tier,
  explicitTier: string | undefined,
  installed: 0 | 1 | 2 | 3 | null,
): { tier: Tier; note?: string } {
  if (explicitTier !== undefined) return { tier: resolved };
  if (installed === null || resolved === 0 || installed === resolved) return { tier: resolved };
  return {
    tier: installed,
    note:
      `Existing Tier ${installed} install detected — keeping Tier ${installed}. ` +
      `Switching tiers rewrites docker-compose.yml with a different service set ` +
      `(and can change the storage backend, hiding existing files), so it requires ` +
      `an explicit \`--tier ${resolved}\`.`,
  };
}

/**
 * `appstrate install --upgrade-compose` (issue #515) — surgically strip
 * stale duplicated env defaults from an existing install's
 * `docker-compose.yml`. Standalone maintenance op: no tier prompt, no
 * `.env` touch, no Docker. The flag short-circuits the normal install
 * flow in `cli.ts` so the heavy interactive path never runs.
 *
 * `deps` is a DI seam for tests — production wires the real filesystem
 * I/O inside `runComposeUpgrade`.
 */
export async function composeUpgradeCommand(
  opts: { dir?: string },
  deps: ComposeUpgradeDeps = {},
): Promise<void> {
  intro("Appstrate compose upgrade");
  try {
    const dir = resolveComposeUpgradeDir(opts.dir);
    const outcome = await runComposeUpgrade(dir, deps);
    clack.note(formatComposeUpgradeResult(outcome), "docker-compose.yml");
    switch (outcome.status) {
      case "no-install":
        // A wrong --dir (or no install) is a user-actionable failure —
        // exit non-zero so scripts notice instead of assuming success.
        throw new Error(`No docker-compose.yml found under ${dir}.`);
      case "clean":
        outro("Already up to date — nothing to upgrade.");
        return;
      case "refused-only":
        outro("No automatic changes made — see the manual edits above.");
        return;
      case "upgraded":
        outro("Compose file upgraded. Restart the stack to apply.");
        return;
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

/**
 * Resolve the public app URL for the install (issue #822).
 *
 * Order of precedence:
 *   1. Upgrade with an existing `APP_URL` in `.env` → inherit it.
 *      `mergeEnv` preserves the existing value anyway (existing wins),
 *      so honoring a divergent `--app-url` here would print banners
 *      pointing at a URL the generated `.env` doesn't contain. Same
 *      warn-and-inherit contract as `resolveAppstratePort`; the
 *      documented way to change the URL is editing `<dir>/.env`.
 *   2. `--app-url` flag / `APPSTRATE_APP_URL` env — the scripted and
 *      `curl | APPSTRATE_APP_URL=… bash` path. Validated strictly
 *      (throws) so a typo surfaces at install time, not as a broken
 *      OAuth callback later.
 *   3. Interactive prompt — Docker tiers only, fresh install. Tier 0
 *      is local dev where a public URL is meaningless noise. Enter
 *      keeps the local default (current behavior preserved).
 *   4. `http://localhost:<port>` — the historical default.
 */
export async function resolveAppUrl(
  raw: string | undefined,
  port: number,
  opts: { tier: Tier; mode: InstallMode; existing: ExistingInstall; nonInteractive: boolean },
): Promise<string> {
  const envValue = process.env.APPSTRATE_APP_URL?.trim();
  const expressed = raw ?? (envValue === "" ? undefined : envValue);
  const requested = expressed === undefined ? undefined : parseAppUrl(expressed);

  if (opts.mode === "upgrade" && opts.existing.hasEnv) {
    const inherited = opts.existing.existingEnv.APP_URL;
    if (inherited) {
      if (requested !== undefined && requested !== inherited) {
        clack.log.warn(
          `app URL ${requested} ignored on upgrade — existing .env pins APP_URL=${inherited}, and config is preserved across upgrades (see mergeEnv). Edit <dir>/.env manually (APP_URL + TRUSTED_ORIGINS + TRUST_PROXY) to change the public URL.`,
        );
      }
      return inherited;
    }
  }

  if (requested !== undefined) {
    assertLoopbackPortMatches(requested, port);
    return requested;
  }

  const fallback = appUrlForPort(port);
  // Tier 0 is local dev; non-interactive keeps the zero-prompt contract
  // of `--yes` / `--tier N` (remote deploys pass --app-url explicitly).
  if (opts.tier === 0 || opts.nonInteractive) return fallback;

  clack.note(
    `Remote deployment (behind a reverse proxy)? Enter the public URL users will\nhit, e.g. https://appstrate.example.com — it drives OAuth redirects, CORS\n(TRUSTED_ORIGINS), and email links. The reverse proxy itself (TLS, forwarding\nto localhost:${port}) is not provisioned by the installer.\nPress Enter to keep the local default.`,
    "Public URL (optional)",
  );
  const answer = (await askText("Public URL", fallback)).trim();
  if (!answer || answer === fallback) return fallback;
  const chosen = parseAppUrl(answer);
  assertLoopbackPortMatches(chosen, port);
  return chosen;
}

/**
 * Reject a plain-http loopback app URL whose port disagrees with the
 * host bind port. Such a URL is accessed directly — on localhost there
 * is no reverse proxy to bridge the two ports — so every derived
 * artifact (TRUSTED_ORIGINS/CORS, the /claim banner, email links) would
 * point at a port nothing listens on, while the install itself looks
 * green (the healthcheck polls the bind port). Fail fast with the fix.
 *
 * https loopback is deliberately allowed: TLS on localhost implies a
 * local terminating proxy (e.g. Caddy on :8443 forwarding to the bind
 * port), where diverging ports are the whole point. Exported for tests.
 */
export function assertLoopbackPortMatches(appUrl: string, port: number): void {
  const url = new URL(appUrl);
  if (url.protocol !== "http:") return;
  const host = url.hostname;
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") return;
  const urlPort = url.port === "" ? 80 : Number(url.port);
  if (urlPort !== port) {
    throw new Error(
      `App URL ${appUrl} doesn't match the platform bind port ${port} — a plain-http localhost URL is accessed directly (no reverse proxy), so the ports must agree. Did you mean \`--port ${urlPort}\` (without --app-url)?`,
    );
  }
}

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
 * Interactive default: Tier 2 (PostgreSQL + Redis, filesystem storage)
 * when Docker is reachable — the happy path for the one-liner installer
 * is `press Enter → working production-grade Appstrate`. Filesystem
 * storage is the single-node default (issue #829): serving is app-domain
 * either way, so bundled MinIO adds a container without adding
 * capability — it stays available as the Tier 3 advanced option (or
 * bring your own S3 via env on any tier). When Docker is missing we
 * silently downgrade the default to Tier 0 and surface a friendly note
 * so the user is not pushed into a tier they cannot actually run; the
 * fatal `DockerMissingError` in `installDockerTier` remains the safety
 * net for the explicit-pick case.
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
    const autoTier: Tier = dockerOk ? 2 : 0;
    note(
      dockerOk
        ? "--yes: Tier 2 selected automatically (Docker detected). Re-run with `--tier N` to override."
        : "--yes: Tier 0 selected automatically (Docker not detected). Install Docker and re-run with `--tier 2` for the production stack.",
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
        "or `curl -fsSL https://get.appstrate.dev | bash -s -- --tier 2`.",
    );
  }
  const dockerOk = await probe();
  const defaultTier: Tier = dockerOk ? 2 : 0;
  if (!dockerOk) {
    note(
      "Docker not detected — Tier 0 selected by default. Install Docker Desktop and re-run for the production stack (Tier 2).",
    );
  }
  const chosen = await select<Tier>({
    message: "Which tier do you want to install?",
    initialValue: defaultTier,
    options: [
      { value: 3, label: "Tier 3 — Advanced (PostgreSQL + Redis + bundled MinIO object storage)" },
      {
        value: 2,
        label: "Tier 2 — Production (PostgreSQL + Redis, filesystem storage) — recommended",
      },
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
  /** When true, accept `defaultInstallDir()` without prompting. */
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
    return resolve(defaultInstallDir());
  }
  if (raw === undefined && !process.stdin.isTTY) {
    throw new Error(
      "Cannot prompt for install directory: stdin is not a TTY. " +
        "Re-run with `--dir <path>` or `--yes` to accept ~/appstrate, " +
        "e.g. `curl -fsSL https://get.appstrate.dev | bash -s -- --yes` " +
        "or `curl -fsSL https://get.appstrate.dev | bash -s -- --tier 2 --dir ~/appstrate`.",
    );
  }
  const chosen = raw ?? (await askText("Install directory", defaultInstallDir()));
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

// ─── Agent execution backend (docker | firecracker) ──────────────────
//
// An execution-backend *option*, NOT a tier. Offered only on Docker tiers
// (1/2/3). `docker` (the default) runs agents in local containers;
// `firecracker` runs them in microVMs on a KVM host running the
// `appstrate-runner` daemon. Two firecracker topologies: the daemon lives
// on THIS host (same-host — we drive `appstrate runner install` via sudo
// after the stack is up) or on a REMOTE KVM host (we print the one-liner
// the operator runs there). Main install stays rootless in both cases.

/** Resolved backend decision threaded into `.env` writing + post-install steps. */
export type RunBackendConfig =
  | { adapter: "docker" }
  | {
      adapter: "firecracker";
      /**
       * FIRECRACKER_RUNNER_URL written to the platform `.env`. Remote:
       * `http(s)://<runner-host>:3100` (TCP). Same-host: `unix://<socket
       * path>` — the platform container dials the daemon's unix socket
       * through a bind-mount of /run/appstrate-runner (the compose templates
       * mount it from the installer-written APPSTRATE_RUNNER_SOCKET_DIR), so
       * no port, no plaintext network wire, and the fail-closed
       * non-loopback-http guard never applies.
       */
      runnerUrl: string;
      /** Shared bearer token between platform and daemon. */
      token: string;
      /** Where the token came from — a flag the operator passed, or freshly minted. */
      tokenSource: "flag" | "generated";
      /** Daemon lives on this host, or a separate KVM host. */
      topology: "same-host" | "remote";
      /**
       * This host's LAN IPv4 — the address the GUESTS reach the platform on.
       * Still required for same-host UDS installs: the socket only carries
       * platform↔daemon traffic; guest→platform egress rides the LAN via
       * `platformUrl`.
       */
      hostIp: string;
      /** Full platform URL for `runner install --platform-url` (http://<hostIp>:<appPort>). */
      platformUrl: string;
    };

export interface RunBackendInputs {
  /** `--run-adapter` flag (env `APPSTRATE_RUN_ADAPTER` applied as fallback here). */
  runAdapter?: string;
  /** `--runner-url` — an existing remote daemon URL (implies the remote topology). */
  runnerUrl?: string;
  /** `--runner-token` — shared bearer token. */
  runnerToken?: string;
  /** `--host-ip` — override this host's LAN IPv4 detection. */
  hostIp?: string;
  /** The resolved platform host port, used to build the platform URL. */
  appPort: number;
  /** No interactive prompts allowed (`--tier`/`--yes`/non-TTY). */
  nonInteractive: boolean;
}

/**
 * DI seam for `resolveRunBackend()` — production wires clack + the real
 * network-interface probe + token minting; tests inject deterministic
 * stubs so no prompt, no `os.networkInterfaces()`, no randomness leaks in.
 */
export interface RunBackendResolverDeps {
  select?: typeof clack.select;
  isCancel?: typeof clack.isCancel;
  askText?: typeof askText;
  detectLanIpv4?: () => string | null;
  generateToken?: () => string;
  /** Loud-warning sink — injectable so tests can assert the plaintext warning. */
  warn?: (message: string) => void;
}

/** Loopback hosts the platform's plaintext-transport gate exempts. */
const LOOPBACK_RUNNER_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Validate a remote runner URL: `http(s)://<host>[:port]`, where host may
 * be a HOSTNAME (the platform→daemon leg runs on the host network with
 * normal DNS — an https:// reverse proxy usually sits behind a name) or an
 * IPv4 literal. A dotted-quad that is NOT a valid IPv4 (`300.0.0.1`) is
 * still rejected — it would never resolve, and the old IPv4-only validator
 * caught exactly that typo. Only `--platform-url` stays IPv4-only (guests
 * have no DNS); the runner URL never reaches a guest.
 */
function parseRunnerHttpUrl(raw: string): { url: string; protocol: string; host: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname;
  if (host === "") return null;
  if (/^\d+(\.\d+){3}$/.test(host) && !isIpv4(host)) return null;
  return { url: raw.replace(/\/+$/, ""), protocol: parsed.protocol, host };
}

/**
 * The platform refuses a plaintext `http://` runner URL to a non-loopback
 * host at boot (fail-closed, see the firecracker module's
 * assertRunnerTransportSecurity). The installer cannot know whether the
 * operator plans the `FIRECRACKER_RUNNER_TLS_REQUIRED=0` escape hatch
 * (VPN/WireGuard link), so it warns loudly instead of refusing — but the
 * warning carries the exact remediation so the boot refusal is never a
 * surprise.
 */
function warnIfPlaintextRunnerUrl(
  parsed: { url: string; protocol: string; host: string },
  warn: (message: string) => void,
): void {
  if (parsed.protocol !== "http:" || LOOPBACK_RUNNER_HOSTNAMES.has(parsed.host)) return;
  warn(
    `FIRECRACKER_RUNNER_URL=${parsed.url} is plaintext http:// to a non-loopback host — ` +
      `the platform REFUSES this at boot (the wire carries run credentials). Use ` +
      `https:// behind a TLS reverse proxy, or — only for a link already encrypted at a ` +
      `lower layer (VPN/WireGuard) — set FIRECRACKER_RUNNER_TLS_REQUIRED=0 in the ` +
      `platform .env.`,
  );
}

/** Resolve + validate the runner token (flag > freshly minted). */
function resolveRunnerToken(
  flagToken: string | undefined,
  mint: () => string,
): { value: string; source: "flag" | "generated" } {
  const t = flagToken?.trim();
  if (t) {
    if (t.length < 16) {
      throw new Error(
        "--runner-token must be at least 16 characters (it guards the credential-bearing runner daemon API).",
      );
    }
    return { value: t, source: "flag" };
  }
  return { value: mint(), source: "generated" };
}

const IPV4_HINT =
  "Firecracker guests have no DNS resolver, so it must be an IPv4 literal — a hostname would fail inside every microVM.";

/**
 * Normalize the explicitly-requested run adapter: `--run-adapter` flag >
 * `APPSTRATE_RUN_ADAPTER` env, trimmed; `undefined` when the operator
 * expressed no choice. Single source shared by the tier-0 conflict guard
 * in `installCommand` and `resolveRunBackend` — both must see the exact
 * same input.
 */
export function readRawRunAdapter(flagValue?: string): string | undefined {
  const raw = (flagValue ?? process.env.APPSTRATE_RUN_ADAPTER)?.trim();
  return raw === undefined || raw === "" ? undefined : raw;
}

/**
 * Tier-0 conflict guard (pure, exported for tests): `firecracker` is a
 * Docker-tier (1/2/3) option, so an EXPLICIT firecracker request on tier 0
 * must fail loudly instead of being silently ignored. No explicit request
 * (`undefined`) stays silent — tier 0 simply never offers the choice.
 */
export function assertRunAdapterCompatibleWithTier(
  tier: Tier,
  rawAdapter: string | undefined,
): void {
  if (tier === 0 && rawAdapter === "firecracker") {
    throw new Error(
      "--run-adapter firecracker requires a Docker tier (1-3); tier 0 runs agents in-process.",
    );
  }
}

/**
 * Resolve the agent execution backend for a Docker-tier install.
 *
 * Precedence for the adapter: `--run-adapter` flag > `APPSTRATE_RUN_ADAPTER`
 * env > interactive select (docker default) > docker (non-interactive).
 * Docker returns immediately. Firecracker then resolves a topology and the
 * runner URL / token / host IP it needs.
 *
 * NOT called for tier 0 (the caller skips it) — firecracker is a Docker-tier
 * option only.
 */
export async function resolveRunBackend(
  inputs: RunBackendInputs,
  deps: RunBackendResolverDeps = {},
): Promise<RunBackendConfig> {
  const select = deps.select ?? clack.select;
  const isCancel = deps.isCancel ?? clack.isCancel;
  const promptText = deps.askText ?? askText;
  const detectIp = deps.detectLanIpv4 ?? detectLanIpv4;
  const mintToken = deps.generateToken ?? generateRunnerToken;
  const warn = deps.warn ?? ((message: string) => clack.log.warn(message));
  const { appPort, nonInteractive } = inputs;

  // 1. Which adapter? Flag > env > prompt (interactive) > docker.
  const rawAdapter = readRawRunAdapter(inputs.runAdapter);
  let adapter: "docker" | "firecracker";
  if (rawAdapter !== undefined) {
    if (rawAdapter !== "docker" && rawAdapter !== "firecracker") {
      throw new Error(
        `Invalid --run-adapter value "${rawAdapter}". Expected "docker" or "firecracker".`,
      );
    }
    adapter = rawAdapter;
  } else if (nonInteractive) {
    adapter = "docker";
  } else {
    const chosen = await select<"docker" | "firecracker">({
      message: "Agent execution backend?",
      initialValue: "docker",
      options: [
        { value: "docker", label: "Docker — run agents in local containers (default)" },
        {
          value: "firecracker",
          label: "Firecracker — microVMs (requires a KVM host running the appstrate-runner daemon)",
        },
      ],
    });
    if (isCancel(chosen)) {
      clack.cancel("Cancelled.");
      process.exit(130);
    }
    adapter = chosen;
  }

  if (adapter === "docker") return { adapter: "docker" };

  // 2. Firecracker — determine the topology.
  const hasRunnerUrl = (inputs.runnerUrl ?? "").trim() !== "";
  const hasHostIp = (inputs.hostIp ?? "").trim() !== "";
  let topology: "same-host" | "remote";
  if (hasRunnerUrl) topology = "remote";
  else if (hasHostIp) topology = "same-host";
  else if (nonInteractive) {
    throw new Error(
      "--run-adapter firecracker in non-interactive mode requires either " +
        "(--runner-url <url> --runner-token <token>) for a remote KVM host, " +
        "or --host-ip <ipv4> to install the runner daemon on this host.",
    );
  } else {
    const chosen = await select<"same-host" | "remote">({
      message: "Where does the Firecracker runner daemon run?",
      initialValue: "same-host",
      options: [
        {
          value: "same-host",
          label: "This host — install the appstrate-runner daemon here (needs KVM + sudo)",
        },
        { value: "remote", label: "A remote KVM host — I'll run the daemon installer there" },
      ],
    });
    if (isCancel(chosen)) {
      clack.cancel("Cancelled.");
      process.exit(130);
    }
    topology = chosen;
  }

  // Non-interactive remote must carry an explicit token (there is no daemon
  // yet to preserve one from, and we can't prompt).
  if (nonInteractive && topology === "remote" && !(inputs.runnerToken ?? "").trim()) {
    throw new Error(
      "--run-adapter firecracker --runner-url also requires --runner-token in non-interactive mode.",
    );
  }

  if (topology === "same-host") {
    // This host's LAN IP: flag > detection (interactive confirm/override).
    let ip = inputs.hostIp?.trim();
    if (!ip) {
      const detected = detectIp();
      if (nonInteractive) {
        // Guarded above (hasHostIp) — defensive only.
        if (!detected) {
          throw new Error("Could not detect a LAN IPv4 for this host — pass --host-ip <ipv4>.");
        }
        ip = detected;
      } else {
        ip = (
          await promptText(
            "Host LAN IPv4 the runner + guests reach the platform on",
            detected ?? "",
          )
        ).trim();
      }
    }
    if (!isIpv4(ip)) {
      throw new Error(
        `Invalid host IP "${ip}" — must be an IPv4 literal (e.g. 10.0.0.5). ${IPV4_HINT}`,
      );
    }
    const token = resolveRunnerToken(inputs.runnerToken, mintToken);
    return {
      adapter: "firecracker",
      // Same-host = UDS transport: the daemon binds the canonical socket
      // (`runner install --socket`, appended in buildRunnerInstallArgs) and
      // the platform dials it — no TCP port, so beta.38's fail-closed
      // "plaintext http to a non-loopback host" guard never trips. The LAN
      // IP is still collected: it feeds platformUrl (guest→platform).
      runnerUrl: `unix://${RUNNER_DEFAULT_SOCKET_PATH}`,
      token: token.value,
      tokenSource: token.source,
      topology: "same-host",
      hostIp: ip,
      platformUrl: `http://${ip}:${appPort}`,
    };
  }

  // topology === "remote"
  // Runner daemon URL: flag (full URL) > interactive prompt (full URL, or a
  // bare IPv4 kept for muscle memory). Hostnames are ACCEPTED — a split-host
  // daemon should sit behind an https:// reverse proxy, which usually means
  // a DNS name; the guests-need-IPv4 rule applies to --platform-url only.
  let runnerUrl = inputs.runnerUrl?.trim();
  if (runnerUrl) {
    const parsed = parseRunnerHttpUrl(runnerUrl);
    if (!parsed) {
      throw new Error(
        `Invalid --runner-url "${runnerUrl}" — must be http(s)://<host>[:port], e.g. ` +
          `https://runner.example.com:${RUNNER_DEFAULT_PORT} (TLS reverse proxy in front ` +
          `of the daemon) or http://10.0.0.9:${RUNNER_DEFAULT_PORT}.`,
      );
    }
    warnIfPlaintextRunnerUrl(parsed, warn);
    runnerUrl = parsed.url;
  } else {
    const answer = (
      await promptText(
        `Runner (KVM host) URL — https://<host>:${RUNNER_DEFAULT_PORT} recommended, or a bare LAN IPv4`,
        "",
      )
    ).trim();
    // A bare IPv4 keeps the pre-UDS ergonomics (`10.0.0.9` → http://…:3100);
    // anything else must be a full http(s) URL.
    const parsed = isIpv4(answer)
      ? parseRunnerHttpUrl(`http://${answer}:${RUNNER_DEFAULT_PORT}`)
      : parseRunnerHttpUrl(answer);
    if (!parsed) {
      throw new Error(
        `Invalid runner URL "${answer}" — must be http(s)://<host>[:port] or a bare ` +
          `IPv4 literal (e.g. 10.0.0.9).`,
      );
    }
    warnIfPlaintextRunnerUrl(parsed, warn);
    runnerUrl = parsed.url;
  }

  const token = resolveRunnerToken(inputs.runnerToken, mintToken);

  // This host's LAN IP for the printed one-liner's --platform-url.
  let hostIp = inputs.hostIp?.trim();
  if (!hostIp) {
    const detected = detectIp();
    hostIp = nonInteractive
      ? (detected ?? "")
      : (
          await promptText(
            "This host's LAN IPv4 (the daemon reaches the platform here)",
            detected ?? "",
          )
        ).trim();
  }
  if (hostIp && !isIpv4(hostIp)) {
    throw new Error(
      `Invalid host IP "${hostIp}" — must be an IPv4 literal (e.g. 10.0.0.5). ${IPV4_HINT}`,
    );
  }
  // A missing this-host IP (non-interactive, undetectable) degrades only the
  // printed hint — the platform `.env` needs just the runner URL + token.
  const platformHost = hostIp || "<this-host-ip>";

  return {
    adapter: "firecracker",
    runnerUrl,
    token: token.value,
    tokenSource: token.source,
    topology: "remote",
    hostIp,
    platformUrl: `http://${platformHost}:${appPort}`,
  };
}

/**
 * Resolve the argv used to re-invoke THIS CLI. For the shipped single-file
 * binary `process.execPath` IS the appstrate binary; when running from
 * source under bun/node it's the runtime and `argv[1]` is the entry script.
 * Callers prefix `sudo` (and append the subcommand).
 */
export function resolveCliInvocation(
  execPath: string = process.execPath,
  argv: string[] = process.argv,
): string[] {
  // Split on BOTH separators: a Windows `execPath` (`C:\…\bun.exe`) uses
  // backslashes, so a `/`-only split would keep the whole path as the
  // basename and the runtime branches below would never match.
  const base = (execPath.split(/[/\\]/).pop() ?? execPath).toLowerCase();
  if (base === "bun" || base === "node" || base === "bun.exe" || base === "node.exe") {
    const script = argv[1];
    return script ? [execPath, script] : [execPath];
  }
  return [execPath];
}

/**
 * Build the argv (excluding the leading `sudo`) for the same-host runner
 * install: `<cli> runner install --platform-url <url> --token <token>
 * --socket <canonical sock> --yes`. The token is a secret but must appear
 * here — it is how the daemon pairs with the platform. `--socket` puts the
 * daemon in UDS mode (same-host transport); the platform side was already
 * written as `FIRECRACKER_RUNNER_URL=unix://…` by `resolveRunBackend`.
 */
export function buildRunnerInstallArgs(
  cliInvocation: string[],
  platformUrl: string,
  token: string,
): string[] {
  return [
    ...cliInvocation,
    "runner",
    "install",
    "--platform-url",
    platformUrl,
    "--token",
    token,
    "--socket",
    RUNNER_DEFAULT_SOCKET_PATH,
    "--yes",
  ];
}

/**
 * Render the Firecracker post-install follow-up note. For the remote
 * topology this includes the exact one-liner to run on the KVM host (which
 * carries the pairing token — intended). Both topologies print the daemon
 * lifecycle hints.
 */
export function firecrackerFollowupNote(
  rb: Extract<RunBackendConfig, { adapter: "firecracker" }>,
): string {
  const lines: string[] = [];
  if (rb.topology === "remote") {
    lines.push(
      "Run this on your KVM host to install + pair the runner daemon:",
      "",
      `  curl -fsSL https://get.appstrate.dev/runner | bash -s -- --platform-url ${rb.platformUrl} --token ${rb.token}`,
      "",
    );
  } else {
    lines.push(
      `The platform reaches the daemon over a unix socket (${rb.runnerUrl}) —`,
      `no network port, no TLS to configure. The platform container bind-mounts`,
      `${RUNNER_RUNTIME_DIR} for it (the compose templates mount it when the`,
      `installer-written APPSTRATE_RUNNER_SOCKET_DIR is set in .env).`,
      "",
    );
  }
  lines.push(
    "Manage the runner daemon on the KVM host:",
    "  appstrate runner status",
    "  appstrate runner logs -f",
    "  appstrate runner doctor",
  );
  return lines.join("\n");
}

/**
 * Same-host firecracker: after the platform stack is healthy, install the
 * runner daemon on THIS host. Interactive → spawn `sudo appstrate runner
 * install …` (sudo prompts on the same TTY). Non-interactive → print the
 * command instead (we can't sudo-prompt). A non-zero exit is a WARNING, not
 * a failure: the platform itself is already installed and running.
 *
 * The spawn goes through an injectable seam so tests never actually sudo.
 */
export async function runSameHostRunnerInstall(
  rb: Extract<RunBackendConfig, { adapter: "firecracker" }>,
  opts: {
    nonInteractive: boolean;
    run?: (cmd: string, args: string[]) => Promise<{ ok: boolean; exitCode: number }>;
    cliInvocation?: string[];
    note?: (message: string, title?: string) => void;
    logInfo?: (message: string) => void;
    logWarn?: (message: string) => void;
  },
): Promise<void> {
  const run = opts.run ?? ((cmd, args) => runCommand(cmd, args, { stdio: "inherit" }));
  // Wrap the clack helpers in arrows — extracting `clack.log.info` as a bare
  // value would drop its `this` binding.
  const note = opts.note ?? ((message: string, title?: string) => clack.note(message, title));
  const logInfo = opts.logInfo ?? ((message: string) => clack.log.info(message));
  const logWarn = opts.logWarn ?? ((message: string) => clack.log.warn(message));
  const cliInvocation = opts.cliInvocation ?? resolveCliInvocation();
  const args = buildRunnerInstallArgs(cliInvocation, rb.platformUrl, rb.token);
  const manualCommand = `sudo ${args.join(" ")}`;

  if (opts.nonInteractive) {
    note(
      "The platform is configured for Firecracker. Install the runner daemon on this host " +
        `(needs root + KVM) with:\n\n  ${manualCommand}`,
      "Next: install the runner daemon",
    );
    return;
  }

  logInfo(
    "Installing the Firecracker runner daemon on this host — sudo is required, " +
      "you may be prompted for your password.",
  );
  // Hand the pairing token to the elevated child through the environment,
  // NOT argv: a `--token <secret>` on the sudo command line is visible to any
  // user via `ps aux`. We set APPSTRATE_RUNNER_TOKEN on our own process env
  // (runCommand inherits it) and tell sudo to preserve it across the
  // privilege boundary; `resolveInstallConfig` reads it as a --token fallback.
  const spawnArgs = [
    `--preserve-env=${RUNNER_TOKEN_ENV}`,
    ...cliInvocation,
    "runner",
    "install",
    "--platform-url",
    rb.platformUrl,
    // Same-host = UDS mode: the daemon binds the canonical socket instead of
    // a TCP port, matching the unix:// runner URL already in the platform .env.
    "--socket",
    RUNNER_DEFAULT_SOCKET_PATH,
    "--yes",
  ];
  const prevToken = process.env[RUNNER_TOKEN_ENV];
  process.env[RUNNER_TOKEN_ENV] = rb.token;
  let res: { ok: boolean; exitCode: number };
  try {
    res = await run("sudo", spawnArgs);
  } finally {
    if (prevToken === undefined) delete process.env[RUNNER_TOKEN_ENV];
    else process.env[RUNNER_TOKEN_ENV] = prevToken;
  }
  if (!res.ok) {
    logWarn(
      `The runner daemon install did not complete (exit ${res.exitCode}). The platform is ` +
        `installed and running; finish the runner setup manually:\n\n  ${manualCommand}`,
    );
  }
}

async function installTier0(
  dir: string,
  port: number,
  appUrl: string,
  opts: { autoConfirm: boolean; bootstrap: BootstrapOverrides },
): Promise<void> {
  // The public URL may sit behind a not-yet-configured reverse proxy;
  // everything that must reach the platform NOW (dev-server readiness
  // poll, browser open) goes through the local bind address instead.
  const localUrl = appUrlForPort(port);
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
  // so the cloned source matches exactly what this binary
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
  const { pid } = await spawnDevServer(dir, localUrl);
  devSpinner.stop(`Dev server running (pid ${pid})`);

  await openBrowser(postInstallBrowserUrl(localUrl, opts.bootstrap));
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

/**
 * On a firecracker UPGRADE, keep the runner token the daemon was already paired
 * with. `resolveRunBackend` freshly MINTS a token when the operator passes no
 * `--runner-token` (tokenSource === "generated"); on a remote-daemon upgrade we
 * only re-print the pairing one-liner (the daemon isn't re-paired here), so
 * writing that minted token to the platform `.env` would rotate the platform to
 * a secret the running daemon never saw → every run 401s until a manual re-pair.
 * Seed the token from the preserved `.env` instead.
 *
 * Two cases deliberately keep the resolved token: an explicit `--runner-token`
 * (tokenSource === "flag" — a deliberate rotation the same-host re-pair / printed
 * one-liner propagates to the daemon), and a first-time firecracker setup on top
 * of an existing docker install (no token to preserve). Returns a new config
 * (never mutates the input) so the caller resolves the final token exactly once.
 */
export function seedUpgradeRunnerToken(
  runBackend: RunBackendConfig,
  mode: InstallMode,
  existing: ExistingInstall,
): RunBackendConfig {
  if (
    mode !== "upgrade" ||
    runBackend.adapter !== "firecracker" ||
    runBackend.tokenSource !== "generated"
  ) {
    return runBackend;
  }
  const preserved = existing.existingEnv.FIRECRACKER_RUNNER_TOKEN;
  if (typeof preserved === "string" && preserved.trim() !== "") {
    return { ...runBackend, token: preserved };
  }
  return runBackend;
}

async function installDockerTier(
  dir: string,
  tier: 1 | 2 | 3,
  port: number,
  appUrl: string,
  opts: {
    force: boolean;
    mode: InstallMode;
    existing: ExistingInstall;
    project: { name: string; origin: "sidecar" | "derived" };
    autoConfirm: boolean;
    nonInteractive: boolean;
    bootstrap: BootstrapOverrides;
    runBackend: RunBackendConfig;
  },
): Promise<void> {
  // Resolve the runner token ONCE, up front, so every downstream consumer
  // (`runBackendEnv`, the post-mergeEnv `.env` override, `runSameHostRunnerInstall`,
  // the follow-up note) reads the same value — no in-place mutation of the
  // passed-in config threaded across the function.
  const runBackend = seedUpgradeRunnerToken(opts.runBackend, opts.mode, opts.existing);
  // Firecracker `.env` keys (RUN_ADAPTER/MODULES/FIRECRACKER_RUNNER_*).
  // FIRECRACKER_RUNNER_URL/_TOKEN are re-applied AFTER `mergeEnv` on upgrade
  // (see below) — the same-host `runner install` step re-pairs the daemon
  // with `runBackend.token`, so letting the OLD platform token win the merge
  // would leave platform and daemon paired on different secrets.
  const runBackendEnv: RunBackendEnv =
    runBackend.adapter === "firecracker"
      ? { adapter: "firecracker", runnerUrl: runBackend.runnerUrl, runnerToken: runBackend.token }
      : { adapter: "docker" };
  // Healthcheck + browser go through the local bind address: on a
  // remote deployment the public URL only resolves once the operator's
  // reverse proxy is configured, which happens AFTER the install.
  const localUrl = appUrlForPort(port);
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
      const fresh = generateEnvForTier(tier, appUrl, { port }, opts.bootstrap, runBackendEnv);
      let envVars = mode === "upgrade" ? mergeEnv(existing.existingEnv, fresh) : fresh;
      // Firecracker pairing token/URL must track the CURRENT install, not
      // whatever `mergeEnv` happened to keep: `runSameHostRunnerInstall` below
      // (and the remote one-liner) pair the daemon with `runBackend.token`, so
      // the platform `.env` must carry that exact token. `runBackend.token` was
      // already resolved by `seedUpgradeRunnerToken` above — on a remote/generated
      // upgrade it holds the PRESERVED token so we don't rotate the platform away
      // from the daemon; otherwise it's the flag/minted token being (re-)paired.
      if (mode === "upgrade" && runBackend.adapter === "firecracker") {
        envVars = {
          ...envVars,
          FIRECRACKER_RUNNER_URL: runBackend.runnerUrl,
          FIRECRACKER_RUNNER_TOKEN: runBackend.token,
        };
      }
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
      await waitForAppstrate(localUrl);
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

  // Firecracker post-install (runs AFTER the platform is committed — a
  // runner-install hiccup must never roll back the healthy stack). Same-host
  // drives `sudo appstrate runner install` (or prints it in non-interactive
  // mode); both topologies then print the daemon lifecycle hints + (remote)
  // the pairing one-liner.
  if (runBackend.adapter === "firecracker") {
    if (runBackend.topology === "same-host") {
      await runSameHostRunnerInstall(runBackend, { nonInteractive: opts.nonInteractive });
    }
    clack.note(
      firecrackerFollowupNote(runBackend),
      runBackend.topology === "remote"
        ? "Firecracker — install the runner on your KVM host"
        : "Firecracker runner",
    );
  }

  await openBrowser(postInstallBrowserUrl(localUrl, opts.bootstrap));
  // Remote deployment: the installer wired APP_URL / TRUSTED_ORIGINS /
  // TRUST_PROXY, but provisioning the reverse proxy (TLS, forwarding
  // the public domain to the host port) is the operator's job — say so
  // explicitly instead of letting a dead public URL look like a failed
  // install.
  if (isRemoteAppUrl(appUrl)) {
    clack.note(
      `The platform listens on ${localUrl} (host port ${port}).\nPoint your reverse proxy (Caddy, nginx, Traefik) at it so that\n${appUrl} → ${localUrl}. TLS termination happens at the proxy;\nTRUST_PROXY=true is already set in .env. Until the proxy is up,\nthe platform is reachable at ${localUrl} only.`,
      "Reverse proxy required",
    );
  }
  printBootstrapFollowup(appUrl, opts.bootstrap);
  // The lifecycle commands (#343) read `<dir>/.appstrate/project.json`
  // to find the right `--project-name`, so the user never has to type
  // (or remember) the derived hash. The banner is health-verified
  // above (waitForAppstrate inside the rollback block), so we print it
  // directly rather than through `reportRunning` (which re-checks) —
  // start/restart use that path since they have no prior healthcheck.
  outro(runningBanner({ appUrl, projectName: project.name, dir }));
}
