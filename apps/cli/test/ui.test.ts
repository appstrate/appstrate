// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `lib/ui.ts` — specifically the non-TTY guard on
 * `askText` and `confirm`. Issue #184: `curl … | bash` inherits a
 * closed pipe as stdin, and `@clack/prompts` crashes silently
 * (SIGKILL, no readable error) when asked to prompt against it. The
 * guard turns every prompt call into an explicit, actionable throw.
 *
 * bun:test runs with `process.stdin.isTTY === false`, so any call to
 * the guarded helpers in this test file exercises the non-TTY branch.
 * The happy-path (TTY present) is covered by the e2e install smoke.
 *
 * Also covers the `CommandIO` parameter on the rendering wrappers
 * (`intro` / `outro` / `spinner`) added for issue #1180: with a sink they
 * render into it, and with no sink they must still produce byte-for-byte
 * what bare clack produced before the seam existed. `io.test.ts` owns the
 * `CommandIO`/`exitWithError` contract itself; what is asserted here is the
 * clack-facing half of it, which lives only in these three wrappers.
 */

import { describe, it, expect } from "bun:test";
import { askText, confirm, intro, outro, spinner } from "../src/lib/ui.ts";
import { createMemoryIO } from "./helpers/memory-io.ts";
import { runIsolated } from "./helpers/isolated-process.ts";

const UI_MODULE = JSON.stringify(`${import.meta.dir}/../src/lib/ui.ts`);

describe("askText non-TTY guard", () => {
  it("throws before clack when stdin is not a TTY", async () => {
    expect(process.stdin.isTTY).toBeFalsy();
    await expect(askText("Instance URL")).rejects.toThrow(/stdin is not a TTY/);
  });

  it("names the prompt message so the user can identify the missing flag", async () => {
    await expect(askText("Install directory")).rejects.toThrow(/Install directory/);
  });
});

describe("confirm non-TTY guard", () => {
  it("throws before clack when stdin is not a TTY", async () => {
    expect(process.stdin.isTTY).toBeFalsy();
    await expect(confirm("Start the dev server now?")).rejects.toThrow(/stdin is not a TTY/);
  });

  it("names the prompt message for identifiability", async () => {
    await expect(confirm("Install Bun now?")).rejects.toThrow(/Install Bun now\?/);
  });
});

describe("intro / outro / spinner io seam", () => {
  it("renders the intro frame into the injected sink, not the real stdout", () => {
    const { io, stdout, stderr } = createMemoryIO();
    intro("Appstrate login");
    // No `io` on that first call: it went to the real stream, so the sink
    // this test owns is still empty — the property the whole seam exists for.
    expect(stdout()).toBe("");
    intro("Appstrate login", io);
    expect(stdout()).toContain("Appstrate login");
    expect(stderr()).toBe("");
  });

  it("renders the outro frame into the injected sink", () => {
    const { io, stdout, stderr } = createMemoryIO();
    outro("Logged in as alice@example.com");
    expect(stdout()).toBe("");
    outro("Logged in as alice@example.com", io);
    expect(stdout()).toContain("Logged in as alice@example.com");
    expect(stderr()).toBe("");
  });

  it("gives the spinner the injected sink for both start and stop", () => {
    const { io, stdout, stderr } = createMemoryIO();
    const s = spinner(io);
    s.start("Requesting device code");
    s.stop("Code received");
    expect(stdout()).toContain("Code received");
    expect(stderr()).toBe("");
  });

  // The two comparisons below are the "flake fix, not a UX change" guard for
  // the rendering wrappers: handing clack an explicit `output` must not move
  // a byte or a colour. Each asserts non-empty output first — a child that
  // fails to boot writes nothing, and two empty buffers compare equal.
  it("renders intro byte-for-byte as bare clack did before the seam", async () => {
    const message = JSON.stringify(`Appstrate login — profile "default"`);
    const [before, after] = await Promise.all([
      runIsolated(`const c = await import("@clack/prompts"); c.intro(${message});`),
      runIsolated(`const u = await import(${UI_MODULE}); u.intro(${message});`),
    ]);
    expect(before.stdout).not.toBe("");
    expect(after.stdout).toBe(before.stdout);
    expect(after.stderr).toBe("");
  });

  it("renders outro byte-for-byte as bare clack did before the seam", async () => {
    const message = JSON.stringify(`Logged in as alice@example.com to "Acme" (org_1)`);
    const [before, after] = await Promise.all([
      runIsolated(`const c = await import("@clack/prompts"); c.outro(${message});`),
      runIsolated(`const u = await import(${UI_MODULE}); u.outro(${message});`),
    ]);
    expect(before.stdout).not.toBe("");
    expect(after.stdout).toBe(before.stdout);
    expect(after.stderr).toBe("");
  });
});
