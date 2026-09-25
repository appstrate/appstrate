// SPDX-License-Identifier: Apache-2.0

/**
 * `prctl(PR_SET_DUMPABLE, 0)`: the kernel serves a process's ORIGINAL
 * environment at `/proc/<pid>/environ` to its uid whatever `process.env` says
 * later, and the agent's tools share the runtime's uid. Non-dumpable, its
 * `/proc/<pid>/{environ,mem,fd}` belong to root and ptrace is refused, for the
 * process lifetime (only a credential change or an exec resets it).
 *
 * Linux only (Docker, Firecracker); a no-op returning `false` elsewhere — the
 * process orchestrator on a macOS dev host, which isolates nothing by design.
 */

import { existsSync } from "node:fs";
import { machine } from "node:os";
import { dlopen, FFIType } from "bun:ffi";

const PR_SET_DUMPABLE = 4;

/** The libc exporting `prctl`: musl in the Alpine runtime image, glibc otherwise. */
export function libcPath(arch: string = machine(), exists = existsSync): string {
  const musl = `/lib/ld-musl-${arch}.so.1`;
  return exists(musl) ? musl : "libc.so.6";
}

/** Throws when the flag cannot be set: the caller must not run the agent without it. */
export function makeProcessNonDumpable(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "linux") return false;
  const libc = dlopen(libcPath(), {
    prctl: {
      args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
      returns: FFIType.i32,
    },
  });
  try {
    if (libc.symbols.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) !== 0) {
      throw new Error("prctl(PR_SET_DUMPABLE, 0) failed");
    }
  } finally {
    libc.close();
  }
  return true;
}
