#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * Build wrapper for the npm channel of the CLI.
 *
 * Bundles `@appstrate/*` workspace dependencies into `dist/cli.js` (npm
 * cannot resolve `workspace:*` from a published tarball), keeps every
 * other npm package external (declared in `dependencies` so the consumer
 * `npm install` resolves them). Stamps `INSTALL_SOURCE` via `--define`
 * (see `src/lib/install-source.ts`).
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

import { spawn, file } from "bun";

const VALID = new Set(["curl", "bun", "unknown"]);
const raw = process.env.APPSTRATE_INSTALL_SOURCE?.trim() ?? "unknown";
const source = VALID.has(raw) ? raw : "unknown";

if (raw !== source) {
  console.error(
    `WARN: APPSTRATE_INSTALL_SOURCE="${raw}" is not one of ${[...VALID].join("|")}; falling back to "unknown".`,
  );
}

const pkg = (await file("package.json").json()) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const allDeps = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
const externals = allDeps.filter((d) => !d.startsWith("@appstrate/") && !d.startsWith("@types/"));
const externalArgs = externals.flatMap((e) => ["--external", e]);

const proc = spawn({
  cmd: [
    "bun",
    "build",
    "--target=bun",
    ...externalArgs,
    "--outdir=dist",
    `--define=__APPSTRATE_INSTALL_SOURCE__="${source}"`,
    "src/cli.ts",
  ],
  stdout: "inherit",
  stderr: "inherit",
});

const code = await proc.exited;
process.exit(code);
