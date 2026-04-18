// SPDX-License-Identifier: Apache-2.0

/**
 * Single source of truth for the CLI version string at runtime.
 *
 * Inlined at bundle time by `bun build` (and resolved from disk during
 * `bun run dev`). Using a static JSON import keeps the version honest
 * across every invocation path — `process.env.npm_package_version` is
 * only populated by `bun run <script>` and goes missing for the bundled
 * binary that ships to users.
 */

import pkg from "../../package.json" with { type: "json" };

export const CLI_VERSION: string = (pkg as { version: string }).version;

export const CLI_USER_AGENT = `appstrate-cli/${CLI_VERSION}`;

/**
 * Fallback Docker image tag used when the CLI runs from a dev build
 * (`CLI_VERSION === "0.0.0"`) and therefore has no lockstep release to
 * point at. Bumped in the same commit as each CLI release until the
 * first stable `v1.0.0` ships a floating `latest` tag on GHCR (see
 * `.github/workflows/release.yml` `flavor: latest=auto`). Production
 * CLIs (non-dev `CLI_VERSION`) ignore this and use their own version.
 */
export const FALLBACK_DOCKER_VERSION = "1.0.0-alpha.50";

/**
 * Resolve the Docker image tag to inject into generated `.env` files
 * for tiers 1/2/3. Production CLI → its own version (lockstep per
 * ADR-006 §Lockstep versioning). Dev CLI → `FALLBACK_DOCKER_VERSION`
 * so the compose templates don't resolve to `:latest` (which isn't
 * guaranteed to exist on GHCR during the alpha train).
 */
export function resolveDockerImageTag(): string {
  return CLI_VERSION === "0.0.0" ? FALLBACK_DOCKER_VERSION : CLI_VERSION;
}
