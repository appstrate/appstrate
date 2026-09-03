// SPDX-License-Identifier: Apache-2.0

/**
 * Two Claude Code sessions opened together each fire the background command,
 * and nothing survives that: the swaps race and the ledger's last writer wins.
 * A directory is the lock because `mkdir` is atomically create-or-fail
 * everywhere. Two facts decide whether a lock still has an owner: the pid it
 * recorded (gone = reaped at once, which covers a session closing seconds
 * after it opened and SIGKILL-ing the sync it spawned) and a heartbeat — the
 * holder touches the lock's `mtime` while it runs, so a pid that was reused,
 * a zombie or a frozen holder is reaped once the beat stops. Neither is
 * consulted alone.
 */

import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDataDir } from "../config.ts";
import { onShutdown } from "../shutdown.ts";

export interface SyncLockOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** How often the holder touches the lock's `mtime`. */
  heartbeatMs?: number;
  /** A lock whose last beat is older than this belonged to a holder that is gone. */
  staleMs?: number;
}

const DEFAULTS: Required<SyncLockOptions> = {
  // Fits a large org's first sync, inside a marketplace command's timeout.
  timeoutMs: 60_000,
  pollMs: 500,
  heartbeatMs: 2_000,
  // Several missed beats: a scheduler hiccup must not look like a death.
  staleMs: 15_000,
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
  const { timeoutMs, pollMs, heartbeatMs, staleMs } = { ...DEFAULTS, ...options };
  const path = getLockPath();
  await mkdir(join(getDataDir(), "skills-sync"), { recursive: true, mode: 0o700 });

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await tryAcquire(path)) break;
    if (await reapIfAbandoned(path, staleMs)) continue;
    if (Date.now() >= deadline) throw new SyncLockBusyError();
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  const beat = setInterval(() => {
    const now = new Date();
    void utimes(path, now, now).catch(() => {});
  }, heartbeatMs);
  const release = (): Promise<void> => rm(path, { recursive: true, force: true }).catch(() => {});
  // SIGTERM/SIGHUP from a closing session: release before the exit the
  // coordinator performs. SIGKILL cannot be caught — the owner pid covers it.
  const unregister = onShutdown(release);
  try {
    return await body();
  } finally {
    clearInterval(beat);
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
 * Remove a lock whose holder is gone: its recorded pid no longer exists, or
 * its heartbeat stopped `staleMs` ago. Returns whether it did.
 */
async function reapIfAbandoned(path: string, staleMs: number): Promise<boolean> {
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    return true; // vanished since the failed `mkdir` — the next attempt takes it
  }
  const abandoned = Date.now() - mtimeMs >= staleMs || !(await ownerAlive(path));
  if (!abandoned) return false;
  await rm(path, { recursive: true, force: true }).catch(() => {});
  return true;
}

/**
 * `true` when the owner cannot be proven dead: an unreadable or missing owner
 * file (the holder is between its `mkdir` and its write) leaves the verdict
 * to the heartbeat.
 */
async function ownerAlive(path: string): Promise<boolean> {
  let pid: number;
  try {
    pid = Number((await readFile(join(path, OWNER_FILE), "utf-8")).trim());
  } catch {
    return true;
  }
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: exists, owned by someone else — alive. Only ESRCH proves death.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
