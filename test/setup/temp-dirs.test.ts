// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ownTmpdir, sweepOrphanedTempDirs } from "./temp-dirs.ts";

/** A pid no process holds: spawn one, let it exit, reuse its number. */
async function deadPid(): Promise<number> {
  const proc = Bun.spawn(["true"]);
  await proc.exited;
  return proc.pid;
}

describe("sweepOrphanedTempDirs", () => {
  it("removes a directory whose owning process is gone", async () => {
    const orphan = join(tmpdir(), `apst-${await deadPid()}`);
    mkdirSync(orphan);
    sweepOrphanedTempDirs();
    expect(existsSync(orphan)).toBe(false);
  });

  it("keeps the directory of a process that is still running", () => {
    const mine = join(tmpdir(), `apst-${process.pid}`);
    mkdirSync(mine);
    try {
      sweepOrphanedTempDirs();
      expect(existsSync(mine)).toBe(true);
    } finally {
      rmSync(mine, { recursive: true, force: true });
    }
  });

  it("leaves alone a directory that only starts like an owned one", async () => {
    const foreign = join(tmpdir(), `apst-${await deadPid()}-foreign`);
    mkdirSync(foreign);
    try {
      sweepOrphanedTempDirs();
      expect(existsSync(foreign)).toBe(true);
    } finally {
      rmSync(foreign, { recursive: true, force: true });
    }
  });

  // Several processes sweep the same orphan at once; the one that loses sees
  // its removal fail. A read-only subdirectory fails it the same way (not for
  // root, which removes it: a green run as root proves nothing here).
  it("does not throw when an orphan cannot be removed", async () => {
    const orphan = join(tmpdir(), `apst-${await deadPid()}`);
    const locked = join(orphan, "locked");
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, "file"), "");
    chmodSync(locked, 0o555);
    try {
      expect(() => sweepOrphanedTempDirs()).not.toThrow();
    } finally {
      chmodSync(locked, 0o755);
      rmSync(orphan, { recursive: true, force: true });
    }
  });
});

describe("ownTmpdir", () => {
  it("is what the preload points os.tmpdir() at", () => {
    expect(basename(tmpdir())).toBe(`apst-${process.pid}`);
    expect(process.env.TMPDIR).toBe(tmpdir());
  });

  // Only another `bun test` process shows the directory gone after its last
  // file. Its tmpdir at start is this one: it sweeps the orphan planted here.
  // It loads the light preload, after one that plants the leftover of a dead
  // process under its own pid.
  it("sweeps, drops a same-pid leftover, redirects, and cleans up at the end", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "fixture-"));
    const report = join(fixture, "report.json");
    const orphan = join(tmpdir(), `apst-${await deadPid()}`);
    mkdirSync(orphan);
    writeFileSync(
      join(fixture, "leftover.ts"),
      `import { mkdirSync, writeFileSync } from "node:fs";
       import { tmpdir } from "node:os";
       import { join } from "node:path";
       const leftover = join(tmpdir(), "apst-" + process.pid);
       mkdirSync(leftover);
       writeFileSync(join(leftover, "stale"), "");`,
    );
    writeFileSync(
      join(fixture, "probe.test.ts"),
      `import { it } from "bun:test";
       import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
       import { tmpdir } from "node:os";
       import { join } from "node:path";
       it("probe", () => {
         const made = mkdtempSync(join(tmpdir(), "x-"));
         const stale = existsSync(join(tmpdir(), "stale"));
         writeFileSync(${JSON.stringify(report)}, JSON.stringify({ pid: process.pid, made, stale }));
       });`,
    );
    const preloads = ["./leftover.ts", join(import.meta.dir, "tmpdir-preload.ts")];
    const child = Bun.spawn(
      ["bun", "test", ...preloads.flatMap((file) => ["--preload", file]), "./probe.test.ts"],
      { cwd: fixture, env: { ...process.env }, stdout: "ignore", stderr: "ignore" },
    );
    try {
      expect(await child.exited).toBe(0);
      const seen = JSON.parse(readFileSync(report, "utf8")) as {
        pid: number;
        made: string;
        stale: boolean;
      };
      const owned = join(tmpdir(), `apst-${seen.pid}`);
      expect(existsSync(orphan)).toBe(false);
      expect(seen.stale).toBe(false);
      expect(dirname(seen.made)).toBe(owned);
      expect(existsSync(owned)).toBe(false);
    } finally {
      rmSync(orphan, { recursive: true, force: true });
    }
  });

  // Same lever as the sweep test above, and the same caveat as root.
  it("comes up over a same-pid leftover it cannot remove", () => {
    const original = process.env.TMPDIR;
    const scratch = mkdtempSync(join(tmpdir(), "scratch-"));
    const owned = join(scratch, `apst-${process.pid}`);
    const locked = join(owned, "locked");
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, "file"), "");
    chmodSync(locked, 0o555);
    process.env.TMPDIR = scratch;
    try {
      ownTmpdir();
      expect(tmpdir()).toBe(owned);
    } finally {
      process.env.TMPDIR = original;
      chmodSync(locked, 0o755);
    }
  });
});
