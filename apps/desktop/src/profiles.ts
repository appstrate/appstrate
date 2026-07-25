// SPDX-License-Identifier: Apache-2.0

/**
 * Browser profile housekeeping.
 *
 * Every agent gets its own Chromium partition (see the session modes in
 * the platform's `desktop_browser.session`), which is what keeps one
 * agent's cookies unreadable by another. The cost is that profiles
 * accumulate: try five agents once each and five profile directories
 * stay on disk forever, holding whatever sessions those runs opened.
 *
 * Two janitors, matching the two profile kinds:
 *
 *   - `persist:appstrate-agent-*` lives in `userData/Partitions/<name>`.
 *     It SHOULD survive across runs (that is the point — no re-login
 *     every time), so it is purged only after a long idle period.
 *   - `appstrate-run-*` (no `persist:`) is in-memory and dies with its
 *     last view, but Chromium may still hold cached entries until then;
 *     clearing it explicitly at close makes "isolated" mean it.
 */

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** Prefix Electron gives the on-disk directory of a persistent partition. */
const AGENT_PROFILE_PREFIX = "appstrate-agent-";
const DEFAULT_MAX_IDLE_DAYS = 30;

/**
 * Delete agent profiles untouched for `maxIdleDays`. Called once at
 * startup, before any tab opens: a profile in use by a live view must
 * never be removed under it.
 *
 * Silent by design on failure — housekeeping must never keep the app
 * from starting.
 */
export async function purgeStaleAgentProfiles(
  userDataPath: string,
  debugLog: (msg: string) => void,
  maxIdleDays: number = DEFAULT_MAX_IDLE_DAYS,
): Promise<string[]> {
  const partitionsDir = join(userDataPath, "Partitions");
  let entries: string[];
  try {
    entries = await readdir(partitionsDir);
  } catch {
    return []; // no partitions yet — nothing to clean
  }
  const cutoff = Date.now() - maxIdleDays * 24 * 60 * 60 * 1000;
  const purged: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(AGENT_PROFILE_PREFIX)) continue;
    const path = join(partitionsDir, entry);
    try {
      const info = await stat(path);
      if (info.mtimeMs > cutoff) continue;
      await rm(path, { recursive: true, force: true });
      purged.push(entry);
      debugLog(`[profiles] purged idle agent profile: ${entry}\n`);
    } catch (err) {
      debugLog(`[profiles] could not purge ${entry}: ${String(err)}\n`);
    }
  }
  return purged;
}

/**
 * Wipe a run-scoped profile's storage. Called when the last tab using it
 * closes, so an `isolated` run leaves nothing behind — not even in the
 * in-memory session Chromium would otherwise keep alive as long as the
 * partition is referenced.
 */
export async function clearEphemeralProfile(
  partition: string,
  debugLog: (msg: string) => void,
): Promise<void> {
  if (partition.startsWith("persist:")) return; // durable by design
  try {
    // Imported lazily: the startup purge above is plain filesystem work
    // and stays runnable (and testable) outside an Electron runtime.
    const { session } = await import("electron");
    await session.fromPartition(partition).clearStorageData();
    debugLog(`[profiles] cleared ephemeral profile: ${partition}\n`);
  } catch (err) {
    debugLog(`[profiles] could not clear ${partition}: ${String(err)}\n`);
  }
}
