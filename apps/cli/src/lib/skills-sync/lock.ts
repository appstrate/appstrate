// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-process mutual exclusion for `appstrate skills sync`.
 *
 * The design runs this command unattended, once per session, in the
 * background — so two Claude Code sessions opened together run it at the same
 * time. Nothing in the sync is safe under that: two atomic swaps of the same
 * plugin root race (the loser renames the winner's tree aside and deletes it),
 * and the ledger is a read-modify-write whose last writer wins, so one run can
 * publish a ledger that forgets everything the other just created.
 *
 * A directory is the lock because `mkdir` is the one filesystem primitive that
 * is atomically create-or-fail everywhere, with no `O_EXCL` caveats and no
 * cleanup ambiguity. `mtime` dates it, so a lock left behind by a killed
 * process expires instead of wedging every future run — the one failure mode
 * a naive lockfile has and a background command cannot afford.
 */

import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { getDataDir } from "../config.ts";

export interface SyncLockOptions {
  /** Give up after this long and let the caller report a busy sync. */
  timeoutMs?: number;
  /** Gap between acquisition attempts. */
  pollMs?: number;
  /** A lock older than this belonged to a process that is gone. */
  staleMs?: number;
}

const DEFAULTS: Required<SyncLockOptions> = {
  // Long enough for a large org's first sync to finish, short enough that a
  // background run gives up well inside a marketplace command's timeout.
  timeoutMs: 60_000,
  pollMs: 500,
  // Far above any plausible sync, so this only ever fires for a dead process.
  staleMs: 10 * 60_000,
};

export class SyncLockBusyError extends Error {
  constructor() {
    super("Another appstrate skills sync is running");
    this.name = "SyncLockBusyError";
  }
}

export function getLockPath(): string {
  return join(getDataDir(), "skills-sync", "lock");
}

/**
 * Run `body` while holding the sync lock.
 *
 * Released in a `finally`, so a throwing body does not wedge the next run.
 * Throws {@link SyncLockBusyError} when the lock could not be taken inside
 * `timeoutMs`.
 */
export async function withSyncLock<T>(
  body: () => Promise<T>,
  options: SyncLockOptions = {},
): Promise<T> {
  const { timeoutMs, pollMs, staleMs } = { ...DEFAULTS, ...options };
  const path = getLockPath();
  await mkdir(join(getDataDir(), "skills-sync"), { recursive: true, mode: 0o700 });

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await tryAcquire(path)) break;
    if (await reapIfStale(path, staleMs)) continue;
    if (Date.now() >= deadline) throw new SyncLockBusyError();
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  try {
    return await body();
  } finally {
    await rm(path, { recursive: true, force: true }).catch(() => {});
  }
}

async function tryAcquire(path: string): Promise<boolean> {
  try {
    // No `recursive`: with it, `mkdir` succeeds on an existing directory and
    // the lock stops being a lock.
    await mkdir(path, { mode: 0o700 });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/** Remove a lock whose age proves its owner is gone. Returns whether it did. */
async function reapIfStale(path: string, staleMs: number): Promise<boolean> {
  try {
    const stats = await stat(path);
    if (Date.now() - stats.mtimeMs < staleMs) return false;
  } catch {
    // Vanished between the failed `mkdir` and here — the next attempt takes it.
    return true;
  }
  await rm(path, { recursive: true, force: true }).catch(() => {});
  return true;
}
