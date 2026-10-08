// SPDX-License-Identifier: Apache-2.0

/**
 * Drive the credentials lock from a test: probe it, hold it as a stuck peer
 * would, and make a waiter give up without sitting out the real wait.
 */

import { closeSync, openSync } from "node:fs";
import { setSystemTime } from "bun:test";
import { getCredentialsLockPath, withCredentialsLock } from "../../src/lib/api.ts";
import { resolveTryLock } from "../../src/lib/file-lock.ts";

/**
 * Whether anyone, this process included, holds the credentials lock right now.
 * The probe opens a descriptor of its own: flock is per open file description,
 * so a hold taken by the code under test reads as busy from here. No lock file
 * means nobody ever took it.
 */
export function credentialsLockHeld(): boolean {
  let fd: number;
  try {
    fd = openSync(getCredentialsLockPath(), "r");
  } catch {
    return false;
  }
  try {
    return resolveTryLock()(fd).status === "busy";
  } finally {
    // Releases the lock too, when the probe was the one that took it.
    closeSync(fd);
  }
}

/** Another process, stuck holding the credentials lock until released. */
export async function holdCredentialsLock(): Promise<() => Promise<void>> {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holder = withCredentialsLock(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  return async () => {
    release.resolve();
    await holder;
  };
}

/**
 * Jump the clock a minute every 10 ms, past any deadline a lock waiter
 * computes, so it gives up on its next poll. Start it only once the code
 * under test is past anything else that reads the clock — an access token's
 * expiry, a device code's — and call the returned function to restore the
 * real clock.
 */
export function jumpClock(): () => void {
  const timer = setInterval(() => setSystemTime(new Date(Date.now() + 60_000)), 10);
  return () => {
    clearInterval(timer);
    setSystemTime();
  };
}
