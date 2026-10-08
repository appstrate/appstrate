// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTempDir, sweepOrphanedTempDirs } from "./temp-dirs.ts";

/** A pid no process holds: spawn one, let it exit, reuse its number. */
async function deadPid(): Promise<number> {
  const proc = Bun.spawn(["true"]);
  await proc.exited;
  return proc.pid;
}

describe("sweepOrphanedTempDirs", () => {
  it("removes a directory whose owning process is gone", async () => {
    const orphan = join(tmpdir(), `appstrate-test-pglite-${await deadPid()}-sweepme`);
    mkdirSync(orphan);
    sweepOrphanedTempDirs();
    expect(existsSync(orphan)).toBe(false);
  });

  it("keeps the directories of a process that is still running", () => {
    const mine = makeTempDir("storage");
    sweepOrphanedTempDirs();
    expect(existsSync(mine)).toBe(true);
  });

  it("leaves alone a directory whose name carries no owner", () => {
    const foreign = join(tmpdir(), `appstrate-test-pglite-noowner${process.pid}`);
    mkdirSync(foreign, { recursive: true });
    try {
      sweepOrphanedTempDirs();
      expect(existsSync(foreign)).toBe(true);
    } finally {
      rmSync(foreign, { recursive: true, force: true });
    }
  });
});
