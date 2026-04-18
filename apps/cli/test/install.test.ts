// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `commands/install.ts` parsing helpers.
 *
 * We only exercise the non-interactive branches (`raw !== undefined`).
 * The interactive clack `select`/`askText` paths require a real TTY
 * and are exercised by the e2e install smoke test in CI.
 *
 * Coverage targets the three safety-critical validations:
 *   - `resolveTier` rejects anything other than 0/1/2/3 (a stray `--tier
 *     4` must abort BEFORE `generateEnvForTier` asserts non-exhaustively).
 *   - `resolveDir` rejects newlines + NUL bytes so no downstream shell
 *     script / backup tool gets confused (see the threat model comment
 *     in install.ts).
 *   - `resolveDir` normalizes to an absolute path so the spawn layer
 *     in tier0/tier123 gets a stable cwd.
 */

import { describe, it, expect } from "bun:test";
import { resolve } from "node:path";
import { resolveTier, resolveDir } from "../src/commands/install.ts";

describe("resolveTier", () => {
  it("accepts '0', '1', '2', '3' as literal strings", async () => {
    expect(await resolveTier("0")).toBe(0);
    expect(await resolveTier("1")).toBe(1);
    expect(await resolveTier("2")).toBe(2);
    expect(await resolveTier("3")).toBe(3);
  });

  it("rejects out-of-range values", async () => {
    await expect(resolveTier("4")).rejects.toThrow(/Invalid --tier/);
    await expect(resolveTier("-1")).rejects.toThrow(/Invalid --tier/);
  });

  it("rejects non-numeric values", async () => {
    await expect(resolveTier("standard")).rejects.toThrow(/Invalid --tier/);
    await expect(resolveTier("1.5")).rejects.toThrow(/Invalid --tier/);
    await expect(resolveTier("NaN")).rejects.toThrow(/Invalid --tier/);
  });
});

describe("resolveDir", () => {
  it("resolves a relative path to an absolute one", async () => {
    const out = await resolveDir("./my-install");
    expect(out).toBe(resolve("./my-install"));
    expect(out.startsWith("/")).toBe(true);
  });

  it("leaves an already-absolute path untouched except for normalization", async () => {
    const out = await resolveDir("/tmp/foo/../foo");
    expect(out).toBe("/tmp/foo");
  });

  it("rejects paths containing a newline", async () => {
    await expect(resolveDir("/tmp/bad\npath")).rejects.toThrow(/newlines or NUL/);
    await expect(resolveDir("/tmp/bad\rpath")).rejects.toThrow(/newlines or NUL/);
  });

  it("rejects paths containing a NUL byte", async () => {
    await expect(resolveDir("/tmp/bad\0path")).rejects.toThrow(/newlines or NUL/);
  });
});
