// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { libcPath, makeProcessNonDumpable } from "../non-dumpable.ts";

describe("libcPath", () => {
  it("picks the musl loader when present (Alpine runtime image)", () => {
    expect(libcPath("aarch64", () => true)).toBe("/lib/ld-musl-aarch64.so.1");
    expect(libcPath("x86_64", () => true)).toBe("/lib/ld-musl-x86_64.so.1");
  });

  it("falls back to glibc otherwise", () => {
    expect(libcPath("x86_64", () => false)).toBe("libc.so.6");
  });
});

describe("makeProcessNonDumpable", () => {
  it("is a no-op off Linux", () => {
    expect(makeProcessNonDumpable("darwin")).toBe(false);
  });

  // Root holds CAP_SYS_PTRACE and reads a non-dumpable process anyway.
  const canProve = process.platform === "linux" && process.getuid?.() !== 0;
  const DUMMY = "non-dumpable-test-dummy-value";

  /** Spawn a same-uid child holding DUMMY in its env; read its /proc environ. */
  async function readChildEnviron(harden: boolean): Promise<string | NodeJS.ErrnoException> {
    const helper = join(import.meta.dir, "../non-dumpable.ts");
    const script =
      (harden ? `(await import(${JSON.stringify(helper)})).makeProcessNonDumpable();` : "") +
      `console.log("ready"); await Bun.sleep(10_000);`;
    const child = Bun.spawn(["bun", "-e", script], {
      env: { ...process.env, NON_DUMPABLE_DUMMY: DUMMY },
      stdout: "pipe",
    });
    try {
      const reader = child.stdout.getReader();
      await reader.read(); // "ready": the flag is set before this line prints
      return readFileSync(`/proc/${child.pid}/environ`, "utf8");
    } catch (err) {
      return err as NodeJS.ErrnoException;
    } finally {
      child.kill();
    }
  }

  it.skipIf(!canProve)("control: a dumpable child's environ is readable by its uid", async () => {
    expect(await readChildEnviron(false)).toContain(DUMMY);
  });

  it.skipIf(!canProve)("refuses the same uid access to the process environ", async () => {
    const result = await readChildEnviron(true);
    expect(result).toBeInstanceOf(Error);
    expect((result as NodeJS.ErrnoException).code).toBe("EACCES");
  });
});
