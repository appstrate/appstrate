// SPDX-License-Identifier: Apache-2.0

/**
 * Shared "the stack is up — here's how to reach and manage it" report.
 *
 * `appstrate install`, `appstrate start`, and `appstrate restart` all
 * converge on the SAME final output: a healthy-and-verified banner that
 * names the URL, the lifecycle verbs, and the raw Compose escape hatch.
 * Keeping the string in one place means the three entry points can
 * never drift, and — crucially — the banner is only ever printed as a
 * consequence of a verified fact (an HTTP 200 from the platform), never
 * an optimistic `console.log` that races `docker compose up -d`.
 *
 * `install` already health-checks inside its rollback block, so it
 * calls `runningBanner()` directly. `start` / `restart` have no such
 * block, so they go through `reportRunning()`, which health-checks
 * first — otherwise a banner saying "Appstrate is running at …" could
 * print while the containers are still booting (compose `up -d` returns
 * before the app is ready).
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { outro } from "../ui.ts";
import { defaultInstallDir } from "./project.ts";
import { parseEnvFile } from "./upgrade.ts";
import { waitForAppstrate } from "./tier123.ts";

const DEFAULT_PORT = 3000;

/**
 * Local bind URL for a host port. Port 80 drops the `:80` suffix so the
 * printed URL is the canonical `http://localhost`. Shared by the
 * installer and the lifecycle commands so both agree on how a port maps
 * to a loopback URL.
 */
export function appUrlForPort(port: number): string {
  return port === 80 ? "http://localhost" : `http://localhost:${port}`;
}

/**
 * The unified success banner. `appUrl` is the public/display URL (may be
 * a reverse-proxied https origin on a remote deployment); `projectName`
 * and `dir` produce the lifecycle hints and the raw-Compose one-liner.
 *
 * The `--dir` hint is omitted for the default `~/appstrate` install to
 * keep the common-case commands short, and appended otherwise so a
 * non-default install's `logs`/`stop`/`uninstall` target the right dir.
 */
export function runningBanner(a: { appUrl: string; projectName: string; dir: string }): string {
  const dirHint = resolve(a.dir) === resolve(defaultInstallDir()) ? "" : ` --dir ${a.dir}`;
  return (
    `Appstrate is running at ${a.appUrl}.\n` +
    `Manage the stack:\n` +
    `  appstrate logs -f${dirHint}\n` +
    `  appstrate stop${dirHint}\n` +
    `  appstrate uninstall${dirHint}\n` +
    `Raw form (for advanced cases): docker compose --project-name ${a.projectName} <verb> from ${a.dir}.`
  );
}

/**
 * Read the display + healthcheck URLs for an install from its `.env`.
 *
 * `PORT` is the authoritative host bind port (the healthcheck must hit
 * loopback: on a remote deployment the public `APP_URL` only resolves
 * once the operator's reverse proxy is up, which is out of scope for a
 * lifecycle command). `APP_URL` is the display URL, falling back to the
 * loopback URL when absent.
 *
 * Returns `null` when `.env` is missing or unreadable — the caller then
 * skips the banner rather than inventing a `localhost:3000` URL that may
 * not match the real port. A guessed-wrong URL is worse than none.
 */
export async function resolveRunningUrls(
  dir: string,
): Promise<{ appUrl: string; healthUrl: string } | null> {
  let env: Record<string, string>;
  try {
    env = parseEnvFile(await readFile(join(dir, ".env"), "utf8"));
  } catch {
    return null;
  }
  const port = Number(env.PORT) || DEFAULT_PORT;
  const healthUrl = appUrlForPort(port);
  const appUrl = env.APP_URL?.trim() || healthUrl;
  return { appUrl, healthUrl };
}

/**
 * Wait for the platform to answer on `healthUrl`, then print the unified
 * banner with `appUrl`. Used by `start` / `restart`, which — unlike
 * `install` — have no prior healthcheck of their own. Blocks up to
 * `waitForAppstrate`'s timeout (120s); that's the expected shape of a
 * `start` that reports a live URL.
 */
export async function reportRunning(a: {
  dir: string;
  projectName: string;
  appUrl: string;
  healthUrl: string;
}): Promise<void> {
  await waitForAppstrate(a.healthUrl);
  outro(runningBanner({ appUrl: a.appUrl, projectName: a.projectName, dir: a.dir }));
}
