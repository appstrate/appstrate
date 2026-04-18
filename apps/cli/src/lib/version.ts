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
