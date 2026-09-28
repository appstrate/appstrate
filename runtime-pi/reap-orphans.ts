// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal orphan reaper for a process that is PID 1 in its container.
 *
 * The launcher is PID 1 (so it can hold the run's secrets and be non-dumpable
 * — see `launcher.ts`), which makes it the reaper of every process the agent
 * orphans. Bun's event loop only reaps its own `Bun.spawn` child, so reparented
 * orphans would pile up as zombies against the container's `PidsLimit`.
 *
 * A `waitpid(-1)` loop would race Bun for its tracked child and lose that
 * child's exit code, so this reaps only zombies whose parent is us and that are
 * NOT the tracked child: it scans `/proc` on a timer and `waitpid`s each by pid.
 * Linux only (there is nothing to reap elsewhere).
 */

import { readdirSync, readFileSync } from "node:fs";
import { dlopen, FFIType } from "bun:ffi";
import { libcPath } from "./non-dumpable.ts";

const WNOHANG = 1;
const REAP_INTERVAL_MS = 1000;

/** A zombie (state `Z`) child of `self`, other than `keepPid`. */
function zombieChildren(self: number, keepPid: number): number[] {
  const out: number[] = [];
  for (const name of readdirSync("/proc")) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid === keepPid) continue;
    try {
      // `pid (comm) state ppid …` — comm may hold spaces/parens, so read the
      // fields after the last ')'.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z" && Number(fields[1]) === self) out.push(pid);
    } catch {
      // The process vanished between readdir and read — nothing to reap.
    }
  }
  return out;
}

/** Start reaping. Returns a stop function; the timer is unref'd. */
export function startOrphanReaper(
  keepPid: number,
  platform: NodeJS.Platform = process.platform,
): () => void {
  if (platform !== "linux") return () => {};
  const libc = dlopen(libcPath(), {
    waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  });
  const status = new Int32Array(1);
  const self = process.pid;
  const timer = setInterval(() => {
    for (const pid of zombieChildren(self, keepPid)) {
      libc.symbols.waitpid(pid, status, WNOHANG);
    }
  }, REAP_INTERVAL_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    libc.close();
  };
}
