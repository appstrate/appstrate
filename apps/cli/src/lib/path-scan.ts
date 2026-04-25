// SPDX-License-Identifier: Apache-2.0

/**
 * Scan `$PATH` for `appstrate` binaries (`appstrate doctor` — issue #249, phase 3).
 *
 * Pure helpers + an injectable filesystem interface so tests don't have to
 * shell out. The "winner" of PATH resolution is the FIRST entry whose
 * `<dir>/appstrate` exists and is executable — same semantics as
 * `command -v appstrate` and `posix execvp(3)`.
 */

import { access, realpath } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";

/** A single PATH directory whose `appstrate` candidate exists + is executable. */
export interface PathHit {
  /** PATH entry the candidate was found in. */
  pathEntry: string;
  /** `<pathEntry>/appstrate` (or `.exe` on platforms we don't ship — kept for symmetry). */
  binary: string;
  /** Resolved real path after `realpath(2)` — for symlink dedupe. */
  realPath: string;
}

export interface PathScanFs {
  /** True if the path exists and is executable by the current process. */
  isExecutable(path: string): Promise<boolean>;
  /** `realpath(2)` — used to dedupe symlinks pointing at the same inode. */
  realpath(path: string): Promise<string>;
}

export const defaultPathScanFs: PathScanFs = {
  async isExecutable(path) {
    try {
      await access(path, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  async realpath(path) {
    try {
      return await realpath(path);
    } catch {
      return path;
    }
  },
};

/**
 * Split a `$PATH` string into ordered, unique directory entries.
 *
 * Empty entries (consecutive `:` or leading/trailing `:`) are conventionally
 * interpreted as "current directory" by POSIX shells — we drop them. Including
 * `.` would be a security pitfall (`appstrate doctor` running in /tmp would
 * "find" any binary the user dropped there).
 */
export function splitPath(path: string, sep = ":"): string[] {
  if (!path) return [];
  const parts = path.split(sep).map((p) => p.trim());
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (!p) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * Walk the PATH and return every entry whose `<entry>/appstrate` is executable.
 * Order matches `$PATH` order — caller's first hit wins.
 */
export async function findAppstrateOnPath(
  pathEnv: string,
  binaryName = "appstrate",
  fs: PathScanFs = defaultPathScanFs,
  separator = ":",
): Promise<PathHit[]> {
  const dirs = splitPath(pathEnv, separator);
  const out: PathHit[] = [];
  const seenReal = new Set<string>();
  for (const dir of dirs) {
    const candidate = join(dir, binaryName);
    if (!(await fs.isExecutable(candidate))) continue;
    const real = await fs.realpath(candidate);
    // Dedupe by realpath: many distros symlink ~/.local/bin/foo →
    // /opt/foo/bin/foo, and reporting both as "two installs" would be a lie.
    // Keep the FIRST occurrence (PATH-resolution winner) and skip later ones.
    if (seenReal.has(real)) continue;
    seenReal.add(real);
    out.push({ pathEntry: dir, binary: candidate, realPath: real });
  }
  return out;
}
