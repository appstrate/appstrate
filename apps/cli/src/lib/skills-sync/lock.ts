// SPDX-License-Identifier: Apache-2.0

/**
 * Two Claude Code sessions opened together each fire the background command,
 * and nothing survives that: the swaps race and the ledger's last writer wins.
 * The lock is `flock(2)` on a file that is never unlinked: the kernel ties it
 * to the open descriptor and drops it when the process ends, however it ends
 * — SIGKILL from a session closed seconds after it opened included. No pid to
 * trust, no age to guess, no heartbeat. Bun is the runtime on every channel
 * (npm shebang, curl binary), so the libc call comes through `bun:ffi`.
 *
 * **Why errno is read.** A non-zero return means "did not lock", not "someone
 * else holds it". Only `EWOULDBLOCK` names a competitor; `ENOLCK` /
 * `EOPNOTSUPP` (NFS without lockd, some 9p and virtiofs mounts) mean the
 * filesystem has no `flock` at all, and must not enter the poll loop.
 *
 * **Why an unavailable lock fails open.** Where `flock` does not work — an
 * unsupported mount, or Windows — refusing every sync is a larger breakage
 * than the rare race the lock guards, so the body runs and stderr says so.
 */

import { dlopen, FFIType, read, type Pointer } from "bun:ffi";
import { closeSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getDataDir } from "../config.ts";
import { DEFAULT_IO, type CommandIO } from "../io.ts";

/** The outcome of one non-blocking attempt at the lock. */
export type LockAttempt =
  { status: "acquired" } | { status: "busy" } | { status: "unsupported"; reason: string };

/** Takes an open descriptor, tries once, never blocks, never throws. */
export type TryLock = (fd: number) => LockAttempt;

export interface SyncLockOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** Where the "running unlocked" warning goes. */
  io?: CommandIO;
  /** Test seam; production resolves the libc binding once per process. */
  tryLock?: TryLock;
}

const DEFAULTS: Required<Pick<SyncLockOptions, "timeoutMs" | "pollMs">> = {
  // Fits a large org's first sync, inside a marketplace command's timeout.
  timeoutMs: 60_000,
  pollMs: 500,
};

// <sys/file.h>, identical on macOS and Linux.
const LOCK_EX = 2;
const LOCK_NB = 4;

// <errno.h>. EINTR agrees across platforms; EWOULDBLOCK does not.
const EINTR = 4;
const EWOULDBLOCK_DARWIN = 35;
const EWOULDBLOCK_LINUX = 11;

const ACQUIRED: LockAttempt = { status: "acquired" };
const BUSY: LockAttempt = { status: "busy" };

export class SyncLockBusyError extends Error {
  constructor() {
    super("Another appstrate skills sync is running");
    this.name = "SyncLockBusyError";
  }
}

export function getLockPath(): string {
  return join(getDataDir(), "skills-sync", "sync.lock");
}

/**
 * Released in a `finally`. Throws {@link SyncLockBusyError} past `timeoutMs`
 * while another process holds the lock; runs `body` unlocked, after a warning
 * on stderr, where the platform or the filesystem has no working `flock(2)`.
 */
export async function withSyncLock<T>(
  body: () => Promise<T>,
  options: SyncLockOptions = {},
): Promise<T> {
  const { timeoutMs, pollMs } = { ...DEFAULTS, ...options };
  const io = options.io ?? DEFAULT_IO;
  const tryLock = options.tryLock ?? sharedTryLock();
  const path = getLockPath();
  await mkdir(join(getDataDir(), "skills-sync"), { recursive: true, mode: 0o700 });

  // Never unlinked: a holder that removed it would let the next opener lock a
  // file nobody else can see, and two syncs would run at once.
  const fd = openSync(path, "a", 0o600);
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const attempt = tryLock(fd);
      if (attempt.status === "acquired") return await body();
      if (attempt.status === "unsupported") {
        io.stderr.write(
          `warning: skills sync lock unavailable (${attempt.reason}); continuing unlocked — do not run two syncs at once.\n`,
        );
        return await body();
      }
      if (Date.now() >= deadline) throw new SyncLockBusyError();
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } finally {
    // Closing the descriptor releases the lock — the same thing the kernel
    // does on exit, so there is no signal handling to get right.
    closeSync(fd);
  }
}

let cachedTryLock: TryLock | undefined;

function sharedTryLock(): TryLock {
  return (cachedTryLock ??= resolveTryLock());
}

/** Binds `flock(2)`, or reports why it cannot be had. */
export function resolveTryLock(): TryLock {
  const platform = process.platform;
  if (platform === "win32") return unsupported("Windows has no flock(2)");

  /** glibc first; the musl spellings cover a Bun built for Alpine. */
  const candidates =
    platform === "darwin"
      ? ["libSystem.B.dylib"]
      : ["libc.so.6", "libc.musl-x86_64.so.1", "libc.musl-aarch64.so.1"];

  const failures: string[] = [];
  for (const name of candidates) {
    try {
      return bindFlock(name, platform);
    } catch (err) {
      failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return unsupported(`cannot load flock(2) from libc — tried ${failures.join("; ")}`);
}

function unsupported(reason: string): TryLock {
  const attempt: LockAttempt = { status: "unsupported", reason };
  return () => attempt;
}

function bindFlock(library: string, platform: NodeJS.Platform): TryLock {
  // errno is thread-local, so libc exposes it as a function returning `int*`.
  const errnoLocation = platform === "darwin" ? "__error" : "__errno_location";
  const { symbols } = dlopen(library, {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    [errnoLocation]: { args: [], returns: FFIType.ptr },
  });
  const flock = symbols.flock as (fd: number, operation: number) => number;
  const errnoAt = symbols[errnoLocation] as unknown as () => Pointer;
  const wouldBlock = platform === "darwin" ? EWOULDBLOCK_DARWIN : EWOULDBLOCK_LINUX;

  return (fd) => {
    if (flock(fd, LOCK_EX | LOCK_NB) === 0) return ACQUIRED;
    // Read straight away: errno holds until the next libc call on this thread.
    const errno = read.i32(errnoAt());
    // A signal-interrupted call is busy too: waiting out the poll interval is
    // the right answer to both, and the only one that yields the event loop.
    if (errno === wouldBlock || errno === EINTR) return BUSY;
    return { status: "unsupported", reason: `flock(2) failed with errno ${errno}` };
  };
}
