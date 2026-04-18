// SPDX-License-Identifier: Apache-2.0

/**
 * Bundle integrity test.
 *
 * `apps/cli/src/lib/install/tier123.ts` imports three docker-compose
 * templates via Bun's `with { type: "text" }` attribute from
 * `../../../../../examples/self-hosting/` — a path OUTSIDE the package
 * directory. That works for the source `.ts` run (dev) AND the compiled
 * binary (`bun build --compile` in `release.yml`) because the YAML is
 * resolved at build time in both cases.
 *
 * It does NOT work for the npm tarball: `files` in `package.json` is
 * restricted to the package directory, so the out-of-package YAML never
 * makes it into the shipped artefact. `package.json::prepack` covers
 * this by running `bun build --target=bun --packages external` to
 * produce a bundled `dist/cli.js` with every YAML inlined as a string
 * literal.
 *
 * The 0.0.0 release on npm was broken because it shipped raw `src/` and
 * `bunx appstrate --help` exploded with:
 *
 *   Cannot find module '../../../../../examples/self-hosting/docker-compose.tier1.yml'
 *
 * This test exists so that regression can NEVER ship again. It:
 *   1. Runs the same `bun run build` command `prepack` triggers.
 *   2. Asserts the bundle exists with the expected shebang.
 *   3. Greps the bundle for signatures from each of the three YAML
 *      templates — if any tier is missing, YAML inlining regressed.
 *   4. Spawns the bundle with `--help` and asserts it prints usage.
 *
 * If this test breaks, `bunx appstrate` will break for users. Do
 * not skip or delete — fix the underlying cause.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(cliRoot, "dist");
const bundlePath = join(distDir, "cli.js");

describe("npm bundle", () => {
  beforeAll(() => {
    // Match `prepack` exactly — if this command drifts from
    // `package.json::scripts.build`, the test no longer protects npm
    // publishes. Keep them in lockstep.
    const res = spawnSync("bun", ["run", "build"], {
      cwd: cliRoot,
      stdio: "pipe",
    });
    if (res.status !== 0) {
      throw new Error(
        `bun run build failed (exit ${res.status}):\n` +
          `stdout: ${res.stdout?.toString()}\n` +
          `stderr: ${res.stderr?.toString()}`,
      );
    }
  });

  afterAll(() => {
    // Local dev/CI cleanliness — `dist/` is gitignored but leaving it
    // behind leaks into other test runs that might rebuild and see
    // stale content.
    rmSync(distDir, { recursive: true, force: true });
  });

  it("produces dist/cli.js with a Bun shebang", () => {
    expect(existsSync(bundlePath)).toBe(true);
    const head = readFileSync(bundlePath, "utf8").slice(0, 30);
    // `bunx` / `npm install` chmods bin +x and invokes via the shebang,
    // so a missing/wrong shebang breaks post-install invocation.
    expect(head.startsWith("#!/usr/bin/env bun")).toBe(true);
  });

  it("inlines all three docker-compose tier templates", () => {
    const bundle = readFileSync(bundlePath, "utf8");
    // Tier-specific signatures chosen so each string appears in EXACTLY
    // one of the three YAMLs — a cross-tier match wouldn't prove the
    // missing tier is actually inlined.
    //   - Tier 1 adds Postgres only   → `POSTGRES_PASSWORD` (also in 2/3, but absent means broken)
    //   - Tier 2 adds Redis           → `redis:7-alpine`
    //   - Tier 3 adds MinIO           → `MINIO_ROOT_PASSWORD`
    expect(bundle).toContain("POSTGRES_PASSWORD");
    expect(bundle).toContain("redis:7-alpine");
    expect(bundle).toContain("MINIO_ROOT_PASSWORD");
  });

  it("runs --help via the bundle and exits cleanly", () => {
    const res = spawnSync("bun", [bundlePath, "--help"], {
      stdio: "pipe",
      // Isolate from the dev `APPSTRATE_PROFILE` / config so the
      // command resolution is deterministic across contributor machines.
      env: { ...process.env, APPSTRATE_PROFILE: "" },
    });
    expect(res.status).toBe(0);
    const out = res.stdout.toString();
    // `commander` prints this header for the program root — a change
    // here means the bin entry wasn't the CLI we expected.
    expect(out).toContain("Usage: appstrate");
    // Sanity: the four subcommands are wired in — regression if the
    // bundle is missing a command module.
    expect(out).toContain("install");
    expect(out).toContain("login");
    expect(out).toContain("logout");
    expect(out).toContain("whoami");
  });
});
