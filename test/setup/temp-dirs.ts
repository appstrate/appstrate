// SPDX-License-Identifier: Apache-2.0

/**
 * One scratch directory per test process, installed as its `TMPDIR`: whatever
 * a test, or the code it exercises, creates under `os.tmpdir()` leaves with the
 * process. The name carries the owner's pid, so a process that ended before its
 * teardown ran (killed, `--bail`) is swept by the next one, without touching the
 * directories of processes still running.
 *
 * The name stays short because tests bind unix sockets below it: `sun_path`
 * holds 104 bytes on macOS, and `$TMPDIR` alone takes 48 of them there.
 */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OWNED_BY_PID = /^apst-(\d+)$/;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the pid exists, it just belongs to another user.
    return (err as { code?: string }).code === "EPERM";
  }
}

function remove(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort: several processes sweep the same orphan at once, and
    // teardown never masks the test outcome.
  }
}

/** Remove the scratch directories of test processes that no longer exist. */
export function sweepOrphanedTempDirs(): void {
  for (const name of readdirSync(tmpdir())) {
    const owner = OWNED_BY_PID.exec(name)?.[1];
    if (owner === undefined || isAlive(Number(owner))) continue;
    remove(join(tmpdir(), name));
  }
}

/**
 * Point `os.tmpdir()` at a directory this process owns and return the function
 * that removes it. No `process.on("exit")` listener runs under `bun test`: the
 * preload hands that function to its last `afterAll`, which runs once, after
 * every file.
 */
export function ownTmpdir(): () => void {
  sweepOrphanedTempDirs();
  const dir = join(tmpdir(), `apst-${process.pid}`);
  // The sweep spares this pid: a leftover is a dead process that held the number.
  // One that resists removal is reused, never a reason to fail the whole run.
  remove(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  process.env.TMPDIR = dir;
  return () => remove(dir);
}
