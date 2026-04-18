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

/** Run `docker compose up -d` in the given directory. Throws on non-zero exit. */
export async function dockerComposeUp(dir: string): Promise<CommandResult> {
  const res = await runCommand("docker", ["compose", "up", "-d"], { cwd: dir, stdio: "inherit" });
  if (!res.ok) {
    throw new Error(`docker compose up failed with exit code ${res.exitCode}`);
  }
  return res;
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
