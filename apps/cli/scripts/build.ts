#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * Build wrapper for the npm channel of the CLI.
 *
 * Wraps `bun build --target=bun --packages external --outdir=dist src/cli.ts`
 * with a `--define` flag that stamps `INSTALL_SOURCE` (see
 * `src/lib/install-source.ts`). `package.json#scripts.build` calls this
 * instead of `bun build` directly so the `prepack` hook (run by `npm pack`
 * during the npm publish workflow) carries the stamp without manual escape
 * hell in `package.json`.
 *
 * Channel selection:
 *   - `APPSTRATE_INSTALL_SOURCE=bun`  — set by `.github/workflows/publish-cli.yml`
 *   - `APPSTRATE_INSTALL_SOURCE=curl` — never used here (release.yml stamps directly
 *     in `bun build --compile`), but accepted for parity / manual smoke tests.
 *   - unset / `unknown`              — local dev tarball (`bun run build`)
 *
 * The release.yml workflow does NOT use this script — it invokes
 * `bun build --compile` directly with its own `--define` for the curl channel.
 */

import { spawn } from "bun";

const VALID = new Set(["curl", "bun", "unknown"]);
const raw = process.env.APPSTRATE_INSTALL_SOURCE?.trim() ?? "unknown";
const source = VALID.has(raw) ? raw : "unknown";

if (raw !== source) {
  console.error(
    `WARN: APPSTRATE_INSTALL_SOURCE="${raw}" is not one of ${[...VALID].join("|")}; falling back to "unknown".`,
  );
}

const proc = spawn({
  cmd: [
    "bun",
    "build",
    "--target=bun",
    "--packages",
    "external",
    "--outdir=dist",
    `--define=__APPSTRATE_INSTALL_SOURCE__="${source}"`,
    "src/cli.ts",
  ],
  stdout: "inherit",
  stderr: "inherit",
});

const code = await proc.exited;
process.exit(code);
