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
import { askText, confirm, intro, outro, spinner, withSpinner } from "../src/lib/ui.ts";
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
  // Only the *injected* half is exercised in-process. The complementary
  // property — an un-injected call still reaching the real stdout — cannot be
  // observed from here without owning the process streams, which is exactly
  // the pattern issue #1180 retires; asserting an un-injected call left this
  // sink empty would be vacuous (the sink was created two lines earlier and is
  // unreachable from a call that was never handed it), and the call itself
  // would spray clack ANSI into the runner's own output. The un-injected path
  // is covered instead by the byte-for-byte child-process comparisons at the
  // bottom of this file, which own a stdout no other suite can write to.
  it("renders the intro frame into the injected sink", () => {
    const { io, stdout, stderr } = createMemoryIO();
    intro("Appstrate login", io);
    expect(stdout()).toContain("Appstrate login");
    expect(stderr()).toBe("");
  });

  it("renders the outro frame into the injected sink", () => {
    const { io, stdout, stderr } = createMemoryIO();
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

  // The comparison below is the "flake fix, not a UX change" guard for the
  // rendering wrappers: handing clack an explicit `output` must not move a
  // byte or a colour. One wrapper is enough — `intro`, `outro` and `spinner`
  // share the single `clackOutput` adapter, so the property is the adapter's,
  // not each wrapper's. It asserts non-empty output first: a child that fails
  // to boot writes nothing, and two empty buffers compare equal.
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
});

describe("withSpinner", () => {
  it("returns the body's value and renders the stop frame into the injected sink", async () => {
    const { io, stdout } = createMemoryIO();
    const value = await withSpinner("Working", async () => 42, "Done", { io });
    expect(value).toBe(42);
    // Only the stop frame is asserted: a body that resolves immediately gives
    // the paint interval no tick, so the start label never reaches the sink.
    expect(stdout()).toContain("Done");
  });

  it("rethrows the body's error after closing the frame", async () => {
    const { io, stdout } = createMemoryIO();
    await expect(
      withSpinner(
        "Working",
        async () => {
          throw new Error("boom");
        },
        "Done",
        { io, errorLabel: "Failed" },
      ),
    ).rejects.toThrow("boom");
    expect(stdout()).toContain("Failed");
    expect(stdout()).not.toContain("Done");
  });

  /**
   * Redirected output must not receive cursor motion (`> install.log`).
   *
   * `@clack/prompts` writes `cursor.up` / `cursor.to(0)` / `erase.down()`
   * unconditionally between frames — the only thing it gates is one extra
   * newline, on `isCI = process.env.CI === "true"`. So a developer piping
   * `appstrate install` on a box with no `CI` set got the escapes in the file.
   * `spinner()` now branches on `process.stdout.isTTY` and emits the start
   * label and the resolved stop label as plain lines instead.
   *
   * A child process owns the observation: `runIsolated` gives it a piped
   * stdout, which is exactly the non-TTY condition under test, and a buffer no
   * other suite can write to. The second `runIsolated` is the control — the
   * same start/tick/stop against bare clack, in the same non-TTY child, so a
   * green assertion cannot come from the escapes having never been there. Both
   * bodies sleep past one 80ms paint tick; without it clack's first frame
   * never fires and the control would be vacuously escape-free.
   */
  it("emits plain lines, not cursor escapes, when stdout is not a TTY", async () => {
    const [guarded, control] = await Promise.all([
      runIsolated(`
        const { withSpinner } = await import(${UI_MODULE});
        await withSpinner(
          "Downloading",
          async (s) => { s.message("Downloading — 50%"); await Bun.sleep(250); },
          "Downloaded",
        );
      `),
      runIsolated(`
        const clack = await import("@clack/prompts");
        const s = clack.spinner();
        s.start("Downloading");
        await Bun.sleep(250);
        s.stop("Downloaded");
      `),
    ]);
    expect(guarded.stdout).toBe("Downloading\nDownloaded\n");
    // eslint-disable-next-line no-control-regex -- asserting on ANSI CSI bytes
    expect(guarded.stdout).not.toMatch(/\x1b\[/);
    // eslint-disable-next-line no-control-regex -- same, for the control
    expect(control.stdout).toMatch(/\x1b\[/);
  });

  /**
   * The defect this helper exists for. A clack spinner paints from a
   * `setInterval` that only `stop()` clears; every site that hand-rolled
   * start/await/stop leaked that interval when the body threw, and under
   * `bun test` — one process for the whole repo — the frames kept landing in
   * whatever suite ran next. That is the `Received: "◒  Enabling systemd
   * unit..."` on an innocent `whoami` test in issue #1180.
   *
   * Observing "nothing paints after the throw" means observing a real stdout,
   * so a child process owns it: this suite must not touch the globals it is
   * proving clean. The window after MARKER is what a live interval would paint
   * into. Control: the same snippet with a raw `clack.spinner()` fills that
   * window with frames.
   */
  it("clears the paint interval when the body throws (issue #1180)", async () => {
    const { stdout } = await runIsolated(`
      const { withSpinner } = await import(${UI_MODULE});
      await withSpinner("Working", async () => { throw new Error("boom"); }, "Done")
        .catch(() => {});
      process.stdout.write("MARKER");
      await Bun.sleep(400);
      process.stdout.write("END");
    `);
    const tail = stdout.split("MARKER")[1] ?? "";
    expect(stdout).toContain("MARKER");
    expect(tail).toContain("END");
    // A live interval paints a frame every ~80ms, so 400ms of silence is the
    // falsifiable claim.
    expect(tail).not.toMatch(/[◒◐◓◑]/);
  });
});
