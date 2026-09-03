// SPDX-License-Identifier: Apache-2.0

/**
 * Two Claude Code sessions opened together each fire the background command,
 * and nothing survives that: the swaps race and the ledger's last writer wins.
 * A directory is the lock because `mkdir` is atomically create-or-fail
 * everywhere. It records its owner's pid: a session closed seconds after it
 * opened kills the sync it spawned, and a lock that only expired by age left
 * every session of the next ten minutes failing "busy". `mtime` stays as the
 * fallback for a lock whose owner cannot be read.
 */

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDataDir } from "../config.ts";
import { onShutdown } from "../shutdown.ts";

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
  // Only consulted when the owner pid cannot be read; a dead owner is reaped
  // at once regardless of age.
  staleMs: 10 * 60_000,
};

const OWNER_FILE = "owner";

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
    if (await reapIfAbandoned(path, staleMs)) continue;
    if (Date.now() >= deadline) throw new SyncLockBusyError();
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  const release = (): Promise<void> => rm(path, { recursive: true, force: true }).catch(() => {});
  // SIGTERM/SIGHUP from a closing session: release before the exit the
  // coordinator performs. SIGKILL cannot be caught — the owner pid covers it.
  const unregister = onShutdown(release);
  try {
    return await body();
  } finally {
    unregister();
    await release();
  }
}

async function tryAcquire(path: string): Promise<boolean> {
  try {
    // No `recursive`: it would succeed on an existing directory.
    await mkdir(path, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  await writeFile(join(path, OWNER_FILE), String(process.pid));
  return true;
}

/**
 * Remove a lock whose owner is gone — its pid no longer exists, or it has no
 * readable owner and is older than `staleMs`. Returns whether it did.
 */
async function reapIfAbandoned(path: string, staleMs: number): Promise<boolean> {
  let abandoned: boolean;
  try {
    const pid = Number((await readFile(join(path, OWNER_FILE), "utf-8")).trim());
    abandoned = Number.isInteger(pid) && pid > 0 && !isAlive(pid);
  } catch {
    // Between the holder's `mkdir` and its owner write, or an unreadable file:
    // age decides.
    try {
      abandoned = Date.now() - (await stat(path)).mtimeMs >= staleMs;
    } catch {
      return true; // vanished since the failed `mkdir` — the next attempt takes it
    }
  }
  if (!abandoned) return false;
  await rm(path, { recursive: true, force: true }).catch(() => {});
  return true;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: exists, owned by someone else — alive. Only ESRCH proves death.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
