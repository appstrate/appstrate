#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * Build wrapper for the npm channel of the connect helper.
 *
 * Bundles the source into `dist/cli.js`, keeps every npm dependency
 * external (declared in `dependencies` so the consumer's `npm install`
 * resolves them), and emits a Node-compatible target so plain `npx`
 * works without Bun installed.
 */

import { spawn, file } from "bun";

const pkg = (await file("package.json").json()) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const allDeps = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
const externals = allDeps.filter((d) => !d.startsWith("@types/"));
const externalArgs = externals.flatMap((e) => ["--external", e]);

const proc = spawn({
  cmd: ["bun", "build", "--target=node", ...externalArgs, "--outdir=dist", "src/cli.ts"],
  stdout: "inherit",
  stderr: "inherit",
});

const code = await proc.exited;
process.exit(code);
