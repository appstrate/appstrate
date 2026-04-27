// SPDX-License-Identifier: Apache-2.0
//
// Workaround for transitive `@mariozechner/pi-coding-agent` crash on Bun
// `--compile`'d binaries.
//
// Pi's `dist/config.js` runs `JSON.parse(readFileSync(getPackageJsonPath()))`
// at module top level. `getPackageJsonPath()` resolves to
// `dirname(process.execPath)/package.json` when pi detects it is running
// inside a Bun-compiled binary (no node_modules layout to walk up). Our
// curl/bash installer drops the binary into `~/.local/bin/` (or wherever
// `APPSTRATE_BIN_DIR` points) — there is no sibling `package.json` there,
// so pi crashes with `ENOENT` before `main()` runs.
//
// Materialise a stub `package.json` under the user's XDG cache directory
// (idempotent — same content every invocation, ~1 ms total) and override
// pi's lookup via the `PI_PACKAGE_DIR` env var pi itself documents.
//
// MUST be the first import in `src/cli.ts`. ESM side effects run in
// import-declaration order, and the shim has to land before any module
// that transitively pulls in `@mariozechner/pi-coding-agent` (notably
// `@appstrate/runner-pi`) and triggers pi's top-level `readFileSync`.
//
// The npm channel (`bun build --target=bun --outdir=dist`) is unaffected:
// the bundled `dist/cli.js` lives next to its own
// `node_modules/.../package.json`, and pi's `__dirname`-walk path resolves
// correctly without this shim.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLI_VERSION } from "./version.ts";

const isBunBinary =
  import.meta.url.includes("$bunfs") ||
  import.meta.url.includes("~BUN") ||
  import.meta.url.includes("%7EBUN");

if (isBunBinary && !process.env.PI_PACKAGE_DIR) {
  const cacheRoot = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const dir = join(cacheRoot, "appstrate", "pi-shim");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "appstrate",
      version: CLI_VERSION,
      // Re-brand pi's config layer under the appstrate namespace so any
      // pi-internal state (sessions, caches) lives at `~/.appstrate/`
      // alongside our own config — not in a stray `~/.pi/`.
      piConfig: { name: "appstrate", configDir: ".appstrate" },
    }),
  );
  process.env.PI_PACKAGE_DIR = dir;
}
