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

/** `CLI_VERSION` carries this literal only in a non-released workspace build. */
export const DEV_CLI_VERSION = "0.0.0";

/**
 * Resolve the Docker image tag to inject into generated `.env` files
 * for tiers 1/2/3.
 *
 * ADR-006 §Lockstep versioning makes this a hard invariant: the image
 * tag MUST equal `CLI_VERSION`. There is no sensible fallback — a dev
 * CLI (`CLI_VERSION === "0.0.0"`) has no matching release on GHCR, so
 * any tag we guess at would either 404 or point at a version the CLI
 * was never tested against. We fail fast instead and let the caller
 * decide: release the CLI, use a released binary, or opt into an
 * explicit pin via the `APPSTRATE_VERSION` env var.
 */
export function resolveDockerImageTag(): string {
  const override = process.env.APPSTRATE_VERSION?.trim();
  if (override) return override;
  if (CLI_VERSION === DEV_CLI_VERSION) {
    throw new Error(
      [
        "Cannot pin Appstrate Docker images: this is a dev build of the CLI",
        `(version "${DEV_CLI_VERSION}"), which has no lockstep release on GHCR.`,
        "",
        "Options:",
        "  • Run a released CLI:   curl -fsSL https://get.appstrate.dev | bash",
        "  • Or pin explicitly:    APPSTRATE_VERSION=1.2.3 appstrate install …",
        "",
        "Tier 0 (`appstrate install --tier 0`) does not need a published image",
        "and works from a dev CLI against the current repo.",
      ].join("\n"),
    );
  }
  return CLI_VERSION;
}
