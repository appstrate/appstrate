// SPDX-License-Identifier: Apache-2.0

/**
 * Probe the credentials lock from a test, to assert that a credential write
 * happened while it was held.
 */

import { closeSync, openSync } from "node:fs";
import { getCredentialsLockPath } from "../../src/lib/api.ts";
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
