// SPDX-License-Identifier: Apache-2.0

/**
 * Two Claude Code sessions opened together each fire the background command,
 * and nothing survives that: the swaps race and the ledger's last writer wins.
 * The lock is `flock(2)` on a file that is never unlinked: the kernel ties it
 * to the open descriptor and drops it when the process ends, however it ends
 * — SIGKILL from a session closed seconds after it opened included. No pid to
 * trust, no age to guess, no heartbeat. Bun is the runtime on every channel
 * (npm shebang, curl binary), so the libc call comes through `bun:ffi`.
 */

import { dlopen, FFIType } from "bun:ffi";
import { closeSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getDataDir } from "../config.ts";

export interface SyncLockOptions {
  timeoutMs?: number;
  pollMs?: number;
}

const DEFAULTS: Required<SyncLockOptions> = {
  // Fits a large org's first sync, inside a marketplace command's timeout.
  timeoutMs: 60_000,
  pollMs: 500,
};

// <sys/file.h>, identical on macOS and Linux.
const LOCK_EX = 2;
const LOCK_NB = 4;

/** glibc first; the musl spellings cover a Bun built for Alpine. */
const LIBC_CANDIDATES =
  process.platform === "darwin"
    ? ["libSystem.B.dylib"]
    : ["libc.so.6", "libc.musl-x86_64.so.1", "libc.musl-aarch64.so.1"];

export class SyncLockBusyError extends Error {
  constructor() {
    super("Another appstrate skills sync is running");
    this.name = "SyncLockBusyError";
  }
}

export function getLockPath(): string {
  return join(getDataDir(), "skills-sync", "sync.lock");
}

/** Released in a `finally`. Throws {@link SyncLockBusyError} past `timeoutMs`. */
export async function withSyncLock<T>(
  body: () => Promise<T>,
  options: SyncLockOptions = {},
): Promise<T> {
  const { timeoutMs, pollMs } = { ...DEFAULTS, ...options };
  const path = getLockPath();
  await mkdir(join(getDataDir(), "skills-sync"), { recursive: true, mode: 0o700 });

  // Never unlinked: a holder that removed it would let the next opener lock a
  // file nobody else can see, and two syncs would run at once.
  const fd = openSync(path, "a", 0o600);
  try {
    const deadline = Date.now() + timeoutMs;
    while (flock(fd, LOCK_EX | LOCK_NB) !== 0) {
      if (Date.now() >= deadline) throw new SyncLockBusyError();
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return await body();
  } finally {
    // Closing the descriptor releases the lock — the same thing the kernel
    // does on exit, so there is no signal handling to get right.
    closeSync(fd);
  }
}

let flockSymbol: ((fd: number, operation: number) => number) | undefined;

function flock(fd: number, operation: number): number {
  if (!flockSymbol) {
    const failures: string[] = [];
    for (const name of LIBC_CANDIDATES) {
      try {
        flockSymbol = dlopen(name, {
          flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        }).symbols.flock;
        break;
      } catch (err) {
        failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!flockSymbol) {
      throw new Error(`Cannot load flock(2) from libc — tried ${failures.join("; ")}`);
    }
  }
  return flockSymbol(fd, operation);
}
