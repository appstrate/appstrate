// SPDX-License-Identifier: Apache-2.0

/**
 * Per-process scratch directories for the test harness.
 *
 * A test process removes its own directories on exit, but `exit` never fires
 * for a process that is killed or crashes, and a tier-0 run leaves a PGlite
 * cluster behind every time that happens. So each directory name carries the
 * pid that created it, and every new process sweeps the ones whose owner is
 * gone — which also makes the sweep safe while other test processes run.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OWNED_BY_PID = /^appstrate-test-[a-z]+-(\d+)-/;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the pid exists, it just belongs to another user.
    return (err as { code?: string }).code === "EPERM";
  }
}

/** Remove the scratch directories of test processes that no longer exist. */
export function sweepOrphanedTempDirs(): void {
  for (const name of readdirSync(tmpdir())) {
    const owner = OWNED_BY_PID.exec(name)?.[1];
    if (owner === undefined || isAlive(Number(owner))) continue;
    rmSync(join(tmpdir(), name), { recursive: true, force: true });
  }
}

const owned: string[] = [];
process.on("exit", () => {
  for (const dir of owned) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort — never let teardown mask the test outcome.
    }
  }
});

/** A fresh directory removed when this process exits (or swept after it dies). */
export function makeTempDir(kind: string): string {
  const dir = mkdtempSync(join(tmpdir(), `appstrate-test-${kind}-${process.pid}-`));
  owned.push(dir);
  return dir;
}
