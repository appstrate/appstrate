// SPDX-License-Identifier: Apache-2.0

/**
 * Docker-based tier install flow (Tiers 1/2/3).
 *
 * Embeds the three `docker-compose.tier{1,2,3}.yml` templates at
 * compile time via `with { type: "text" }` so the CLI binary is
 * self-contained — no runtime fetch of YAML, works offline once the
 * binary is downloaded. Each function is small and independently
 * testable (no internal state, DI-free — external systems like `docker
 * info` / `open` are called through thin wrappers in `./os.ts`).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import tier1Compose from "../../../../../examples/self-hosting/docker-compose.tier1.yml" with { type: "text" };
import tier2Compose from "../../../../../examples/self-hosting/docker-compose.tier2.yml" with { type: "text" };
import tier3Compose from "../../../../../examples/self-hosting/docker-compose.tier3.yml" with { type: "text" };
import { runCommand, waitForHttp, type CommandResult } from "./os.ts";
import type { Tier } from "./secrets.ts";

/** Only the Docker tiers have an embedded compose template. */
type DockerTier = Exclude<Tier, 0>;

const COMPOSE_TEMPLATES: Record<DockerTier, string> = {
  1: tier1Compose,
  2: tier2Compose,
  3: tier3Compose,
};

export class DockerMissingError extends Error {
  constructor() {
    super(
      "Docker is required for this tier but was not found. Install Docker Desktop (https://www.docker.com/products/docker-desktop) or pick Tier 0 if you want to run Appstrate without containers.",
    );
    this.name = "DockerMissingError";
  }
}

/**
 * `docker info` runs against the daemon, so it exercises both the
 * binary being on PATH AND the daemon being reachable — exactly the
 * two things `docker compose up` will need a moment later.
 */
export async function assertDockerAvailable(): Promise<void> {
  const res = await runCommand("docker", ["info"], { stdio: "ignore" });
  if (!res.ok) throw new DockerMissingError();
}

/**
 * Non-throwing sibling of `assertDockerAvailable()`. Used by the tier
 * prompt to decide which tier to highlight as the default — failure
 * here is informational, not fatal.
 */
export async function isDockerAvailable(): Promise<boolean> {
  const res = await runCommand("docker", ["info"], { stdio: "ignore" });
  return res.ok;
}

/** Copy the embedded YAML for `tier` into `<dir>/docker-compose.yml`. */
export async function writeComposeFile(dir: string, tier: DockerTier): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "docker-compose.yml"), COMPOSE_TEMPLATES[tier]);
}

/** Write the generated `.env` body to `<dir>/.env` with 0600. */
export async function writeEnvFile(dir: string, envFileBody: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".env"), envFileBody, { mode: 0o600 });
}

/**
 * Run `docker compose up -d` in the given directory, pinned to the
 * Compose project name `projectName`. Threading `--project-name` on
 * every invocation (instead of relying on a top-level `name:` in the
 * compose template, as the first cut did) is what keeps two installs
 * under different directories from cannibalizing each other's
 * containers — see `./project.ts` for the full rationale.
 */
export async function dockerComposeUp(dir: string, projectName: string): Promise<CommandResult> {
  const res = await runCommand("docker", ["compose", "--project-name", projectName, "up", "-d"], {
    cwd: dir,
    stdio: "inherit",
  });
  if (!res.ok) {
    throw new Error(`docker compose up failed with exit code ${res.exitCode}`);
  }
  return res;
}

/**
 * Describe a currently-running Compose project discovered via
 * `docker compose ls`. We only consume two fields; the rest of the
 * Compose output is ignored.
 */
export interface RunningComposeProject {
  name: string;
  /** Absolute path(s) to the compose file(s) backing the project. */
  configFiles: string[];
}

/**
 * Look up a single running Compose project by exact name. Returns
 * `null` when no such project is active, a descriptor otherwise.
 *
 * Why exact-name and not `--filter name=<prefix>`: Compose's `name=`
 * filter is a substring match, so filtering on `appstrate` would also
 * match legitimate neighbour projects named `appstrate-<slug>-<hash>`.
 * We pull the full list and match ourselves — it's a single cheap
 * Docker round-trip per install.
 *
 * `docker compose ls` emits one object per line in `--format json`.
 * Corrupt output (truncated JSON, docker CLI crash) is treated as
 * "no project running" rather than crashing the install — the worst
 * case is that we fall through to the live `docker compose up`, which
 * will surface a concrete docker error of its own.
 */
export async function findRunningComposeProject(
  projectName: string,
): Promise<RunningComposeProject | null> {
  const res = await runCommand("docker", ["compose", "ls", "--all", "--format", "json"], {
    stdio: "pipe",
  });
  if (!res.ok) return null;
  // Compose emits either a single JSON array (modern versions) or NDJSON
  // (one object per line on older builds). Handle both shapes so the
  // preflight works on the full supported Compose range.
  const candidates: unknown[] = [];
  const trimmed = res.stdout.trim();
  if (trimmed.length === 0) return null;
  try {
    const first = JSON.parse(trimmed);
    if (Array.isArray(first)) {
      candidates.push(...first);
    } else {
      candidates.push(first);
    }
  } catch {
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        candidates.push(JSON.parse(line));
      } catch {
        // Skip unparseable lines — a stray warning line on stdout (seen
        // occasionally with plugin upgrades) must not brick the install.
      }
    }
  }
  for (const entry of candidates) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const name =
      typeof rec.Name === "string" ? rec.Name : typeof rec.name === "string" ? rec.name : null;
    if (name !== projectName) continue;
    const rawConfig =
      typeof rec.ConfigFiles === "string"
        ? rec.ConfigFiles
        : typeof rec.configFiles === "string"
          ? rec.configFiles
          : "";
    const configFiles = rawConfig.length > 0 ? rawConfig.split(",").map((s) => s.trim()) : [];
    return { name, configFiles };
  }
  return null;
}

/** Poll `<appUrl>/` until it returns 2xx or the timeout elapses. */
export async function waitForAppstrate(appUrl: string, timeoutMs = 120_000): Promise<void> {
  const ok = await waitForHttp(appUrl, timeoutMs);
  if (!ok) {
    throw new Error(
      `Appstrate did not become healthy within ${Math.round(timeoutMs / 1000)}s — check \`docker compose logs\` for details.`,
    );
  }
}
