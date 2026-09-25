// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dlopen, FFIType } from "bun:ffi";
import { startOrphanReaper } from "../reap-orphans.ts";
import { libcPath } from "../non-dumpable.ts";

const PR_SET_CHILD_SUBREAPER = 36;

/** Make this process adopt orphans, as PID 1 does in the container. */
function setChildSubreaper(on: boolean): void {
  const libc = dlopen(libcPath(), {
    prctl: { args: [FFIType.i32, FFIType.u64], returns: FFIType.i32 },
  });
  try {
    expect(libc.symbols.prctl(PR_SET_CHILD_SUBREAPER, on ? 1 : 0)).toBe(0);
  } finally {
    libc.close();
  }
}

describe("startOrphanReaper", () => {
  it("is a no-op off Linux", () => {
    expect(startOrphanReaper(1, "darwin")()).toBeUndefined();
  });

  const state = (pid: number): string | null => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] ?? null;
    } catch {
      return null; // entry gone = reaped
    }
  };

  it.skipIf(process.platform !== "linux")(
    "reaps an orphaned zombie child without touching the kept child",
    async () => {
      // `sh` prints its `sleep` child's pid then exits, orphaning the sleep to
      // this process (a subreaper, like PID 1); when it exits it is our zombie.
      setChildSubreaper(true);
      const orphan = Bun.spawn(["sh", "-c", "sleep 0.3 & echo $!; exit 0"], { stdout: "pipe" });
      const grandchildPid = Number((await new Response(orphan.stdout).text()).trim());
      const keep = Bun.spawn(["sleep", "30"], { stdout: "ignore" });
      await orphan.exited;
      for (let i = 0; i < 20 && state(grandchildPid) !== "Z"; i++) await Bun.sleep(50);
      expect(state(grandchildPid)).toBe("Z");

      const stop = startOrphanReaper(keep.pid);
      try {
        for (let i = 0; i < 40 && state(grandchildPid) === "Z"; i++) await Bun.sleep(100);
        expect(state(grandchildPid)).toBeNull(); // reaped
        expect(keep.killed).toBe(false); // Bun's tracked child untouched
        expect(state(keep.pid)).toBe("S");
      } finally {
        stop();
        setChildSubreaper(false);
        keep.kill();
        await keep.exited;
      }
    },
  );
});
