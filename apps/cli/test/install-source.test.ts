// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { INSTALL_SOURCE, upgradeHint } from "../src/lib/install-source.ts";

/**
 * Phase 1 — `__APPSTRATE_INSTALL_SOURCE__` build-time stamp (issue #249).
 *
 * Validates three layers:
 *   1. `INSTALL_SOURCE` resolves to `"unknown"` in source/dev (no `--define`).
 *   2. `bun build --define='__APPSTRATE_INSTALL_SOURCE__="curl"'` produces a
 *      bundle whose `INSTALL_SOURCE` is `"curl"` at runtime.
 *   3. Same for `"bun"`, and bogus values fall back to `"unknown"`.
 *
 * The build-time tests `bun build` a tiny probe that imports `INSTALL_SOURCE`
 * and prints it, then `bun` the output. This is the same wiring used by
 * `release.yml` (`bun build --compile`) and `apps/cli/scripts/build.ts`
 * (`bun build` for npm), so a regression in either workflow surfaces here.
 */

describe("install-source", () => {
  describe("dev / source build", () => {
    it("resolves to 'unknown' when the identifier is not defined", () => {
      // `bun test` runs source files directly without a `--define`, so the
      // identifier is undefined and the typeof guard kicks in.
      expect(INSTALL_SOURCE).toBe("unknown");
    });

    it("returns a stable upgrade hint per channel", () => {
      expect(upgradeHint("curl")).toContain("get.appstrate.dev");
      expect(upgradeHint("bun")).toContain("bun update -g appstrate");
      expect(upgradeHint("unknown")).toContain("appstrate");
    });
  });

  describe("build-time substitution", () => {
    async function buildAndRun(stampValue: string | null): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), "appstrate-install-source-"));
      try {
        const probeSrc = join(dir, "probe.ts");
        const probeOut = join(dir, "probe.js");
        const installSourceSrc = await Bun.file(
          join(import.meta.dir, "../src/lib/install-source.ts"),
        ).text();
        await writeFile(join(dir, "install-source.ts"), installSourceSrc);
        await writeFile(
          probeSrc,
          `import { INSTALL_SOURCE } from "./install-source.ts";\nprocess.stdout.write(INSTALL_SOURCE);`,
        );

        const buildArgs = ["build", "--target=bun", "--outfile", probeOut, probeSrc];
        if (stampValue !== null) {
          buildArgs.push(`--define=__APPSTRATE_INSTALL_SOURCE__="${stampValue}"`);
        }
        const buildRes = spawnSync("bun", buildArgs, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (buildRes.status !== 0) {
          throw new Error(`bun build failed: ${buildRes.stderr}`);
        }

        const runRes = spawnSync("bun", [probeOut], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (runRes.status !== 0) {
          throw new Error(`probe failed: ${runRes.stderr}`);
        }
        return runRes.stdout;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    it("stamps 'curl' when --define='__APPSTRATE_INSTALL_SOURCE__=\"curl\"'", async () => {
      const out = await buildAndRun("curl");
      expect(out).toBe("curl");
    });

    it("stamps 'bun' when --define='__APPSTRATE_INSTALL_SOURCE__=\"bun\"'", async () => {
      const out = await buildAndRun("bun");
      expect(out).toBe("bun");
    });

    it("falls back to 'unknown' when no --define is provided", async () => {
      const out = await buildAndRun(null);
      expect(out).toBe("unknown");
    });

    it("falls back to 'unknown' for an unrecognised stamp value", async () => {
      const out = await buildAndRun("brew");
      expect(out).toBe("unknown");
    });
  });
});
