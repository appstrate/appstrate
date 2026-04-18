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
import { openBrowser } from "../lib/install/os.ts";
import { CLI_VERSION } from "../lib/version.ts";

export interface InstallOptions {
  /** Skip the tier prompt (valid values: "0" | "1" | "2" | "3"). */
  tier?: string;
  /** Skip the directory prompt. */
  dir?: string;
}

const DEFAULT_INSTALL_DIR = join(homedir(), "appstrate");
const DEFAULT_APP_URL = "http://localhost:3000";

export async function installCommand(opts: InstallOptions): Promise<void> {
  intro("Appstrate install");

  try {
    const tier = await resolveTier(opts.tier);
    const dir = await resolveDir(opts.dir);

    if (tier === 0) {
      await installTier0(dir);
    } else {
      await installDockerTier(dir, tier);
    }
  } catch (err) {
    exitWithError(err);
  }
}

/**
 * Parse `--tier` or drop into an interactive select. `clack`'s
 * `select` with 4 options reads better than free-form text and avoids
 * the "what did I type?" typo recovery.
 */
async function resolveTier(raw: string | undefined): Promise<Tier> {
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

async function resolveDir(raw: string | undefined): Promise<string> {
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

async function installTier0(dir: string): Promise<void> {
  // Bun — either already present, or install it via the upstream script.
  let bun = detectBun();
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
    bun = detectBun();
  }
  const bunPath = bun.path ?? "bun";

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
  await runBunInstall(dir, bunPath);
  installSpinner.stop("Dependencies installed");

  // `.env`.
  const env = generateEnvForTier(0, DEFAULT_APP_URL);
  await writeTier0Env(dir, renderEnvFile(env));

  // Run dev server?
  const shouldStart = await confirm("Start the dev server now?");
  if (!shouldStart) {
    outro(
      `Ready. Start it later with:\n\n  cd ${dir}\n  ${bunPath} run dev\n\nOpen http://localhost:3000 once it boots.`,
    );
    return;
  }

  const devSpinner = spinner();
  devSpinner.start("Starting dev server");
  const { pid } = await spawnDevServer(dir, bunPath, DEFAULT_APP_URL);
  devSpinner.stop(`Dev server running (pid ${pid})`);

  await openBrowser(DEFAULT_APP_URL);
  outro(
    `Appstrate is running at ${DEFAULT_APP_URL} (pid ${pid}).\nKill it with \`kill ${pid}\` when done.`,
  );
}

async function installDockerTier(dir: string, tier: 1 | 2 | 3): Promise<void> {
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

  // Compose + .env.
  const writeSpinner = spinner();
  writeSpinner.start("Writing compose + .env");
  await writeComposeFile(dir, tier);
  const envVars = generateEnvForTier(tier, DEFAULT_APP_URL);
  await writeComposeEnv(dir, renderEnvFile(envVars));
  writeSpinner.stop(`Wrote ${dir}/docker-compose.yml + .env`);

  // Bring stack up.
  const upSpinner = spinner();
  upSpinner.start("Starting Appstrate (docker compose up -d)");
  await dockerComposeUp(dir);
  upSpinner.stop("Containers up");

  // Healthcheck.
  const healthSpinner = spinner();
  healthSpinner.start("Waiting for Appstrate to become healthy");
  await waitForAppstrate(DEFAULT_APP_URL);
  healthSpinner.stop("Appstrate is healthy");

  await openBrowser(DEFAULT_APP_URL);
  outro(
    `Appstrate is running at ${DEFAULT_APP_URL}.\nManage the stack from ${dir}: \`docker compose logs -f\`, \`docker compose down\`.`,
  );
}
