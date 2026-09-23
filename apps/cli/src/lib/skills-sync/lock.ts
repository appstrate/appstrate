// SPDX-License-Identifier: Apache-2.0

/**
 * Two Claude Code sessions opened together each fire the background command,
 * and nothing survives that: the swaps race and the ledger's last writer wins.
 * So the sync runs under the CLI's `flock(2)` primitive (`../file-lock.ts`,
 * where the errno and fail-open reasoning lives), on a file of its own.
 */

import { join } from "node:path";
import { getDataDir } from "../config.ts";
import { withFileLock, type FileLockOptions } from "../file-lock.ts";

export function getLockPath(): string {
  return join(getDataDir(), "skills-sync", "sync.lock");
}

/**
 * Released in a `finally`. Throws `FileLockBusyError` past `timeoutMs`
 * (default 60 s — fits a large org's first sync, inside a marketplace
 * command's timeout) while another process holds the lock; runs `body`
 * unlocked, after a warning on stderr, where `flock(2)` does not work.
 */
export function withSyncLock<T>(body: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  return withFileLock(getLockPath(), "packages sync", body, options);
}
