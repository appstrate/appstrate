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
 * Probe whether something is still ACCEPTING connections on the socket —
 * the unix-domain equivalent of TCP's EADDRINUSE, which filesystem binds
 * don't get for free (the node outlives its listener). ECONNREFUSED (or
 * any other connect failure) means no listener: the node is a stale
 * leftover. Fail-closed on ambiguity: a wedged peer that accepts nothing
 * within the timeout is still treated as alive — never delete a socket we
 * are not sure is dead.
 */
async function isSocketAlive(path: string, timeoutMs = 1_000): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(true), timeoutMs);
    Bun.connect({
      unix: path,
      socket: {
        data() {},
        open(socket) {
          clearTimeout(timer);
          socket.end();
          resolve(true);
        },
        error() {},
        connectError() {
          clearTimeout(timer);
          resolve(false);
        },
      },
    }).catch(() => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/**
 * Remove a stale socket node at `path` so a fresh bind can succeed
 * (Bun.serve refuses to bind over an existing node). Fail-closed:
 *
 * - nothing at `path` (ENOENT) → fine, nothing to do;
 * - a socket nobody answers on → unlinked (the leftover of a crashed
 *   predecessor — SIGKILL and hard reboots never reach shutdown cleanup);
 * - a socket a live process is ACCEPTING on → throw. systemd's
 *   single-instance model covers the nominal path, but a manual second
 *   launch (or a unit-name mixup) must fail like TCP's EADDRINUSE would,
 *   not silently steal a running daemon's socket;
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
  if (await isSocketAlive(path)) {
    throw new Error(
      `A live process is already accepting connections on ${path} — refusing to ` +
        `steal its socket. Stop the other daemon first (systemctl stop ` +
        `appstrate-runner) or point FIRECRACKER_RUNNER_SOCKET at a different path.`,
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
