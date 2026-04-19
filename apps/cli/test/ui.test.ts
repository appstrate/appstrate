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
 */

import { describe, it, expect } from "bun:test";
import { askText, confirm } from "../src/lib/ui.ts";

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
