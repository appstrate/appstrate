// SPDX-License-Identifier: Apache-2.0

/**
 * Two Claude Code sessions opened together each fire the background command,
 * and nothing survives that: the swaps race and the ledger's last writer wins.
 * A directory is the lock because `mkdir` is atomically create-or-fail
 * everywhere; `mtime` dates it, so a killed process's lock expires.
 */

import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { getDataDir } from "../config.ts";

export interface SyncLockOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** A lock older than this belonged to a process that is gone. */
  staleMs?: number;
}

const DEFAULTS: Required<SyncLockOptions> = {
  // Fits a large org's first sync, inside a marketplace command's timeout.
  timeoutMs: 60_000,
  pollMs: 500,
  // Far above any plausible sync: only ever fires for a dead process.
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

/** Released in a `finally`. Throws {@link SyncLockBusyError} past `timeoutMs`. */
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
    // No `recursive`: it would succeed on an existing directory.
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
    return true; // vanished since the failed `mkdir` — the next attempt takes it
  }
  await rm(path, { recursive: true, force: true }).catch(() => {});
  return true;
}
