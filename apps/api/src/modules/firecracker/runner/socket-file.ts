// SPDX-License-Identifier: Apache-2.0

/**
 * Unix-socket filesystem guard for the daemon's UDS listen path (#868).
 *
 * The daemon runs as root, so an unconditional `unlink(path)` before bind
 * would delete WHATEVER a misconfigured FIRECRACKER_RUNNER_SOCKET points
 * at (`/etc/important.conf`, a data file, …). The guard here is the whole
 * point of this module: only a node that IS a socket may be removed.
 */

import { lstat, unlink } from "node:fs/promises";

/**
 * Remove a stale socket node at `path` so a fresh bind can succeed
 * (Bun.serve refuses to bind over an existing node). Fail-closed:
 *
 * - nothing at `path` (ENOENT) → fine, nothing to do;
 * - a socket → unlinked (the stale leftover of a crashed daemon — a LIVE
 *   daemon on the same path is refused earlier by systemd's single-instance
 *   model, and stealing it silently is exactly what TCP's EADDRINUSE
 *   prevents, so this stays scoped to what we can check: the node type);
 * - anything else (regular file, directory, device, …) → throw with the
 *   offending path, NEVER delete. A root daemon must not destroy operator
 *   data because of an env-file typo.
 */
export async function removeStaleSocket(path: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw err;
  }
  if (!stats.isSocket()) {
    throw new Error(
      `FIRECRACKER_RUNNER_SOCKET points at ${path}, which exists and is NOT a ` +
        `unix socket — refusing to delete it. Point the variable at a socket ` +
        `path (e.g. /run/appstrate-runner/runner.sock) or remove the node yourself.`,
    );
  }
  await unlink(path);
}

/**
 * Best-effort shutdown cleanup: unlink `path` only if it is (still) a
 * socket, swallow every error — shutdown must reach exit(0), and a
 * leftover node is handled by {@link removeStaleSocket} on the next boot.
 */
export async function unlinkSocketIfPresent(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isSocket()) await unlink(path);
  } catch {
    // ENOENT or a racing replacement — nothing worth failing shutdown over.
  }
}
