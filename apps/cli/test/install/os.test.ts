// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `lib/install/os.ts`.
 *
 * The module is deliberately thin — these tests are mostly to protect
 * the small handful of branches that matter in practice:
 *   - `runCommand` returns ok=false (not throws) when the binary is
 *     missing, so callers can short-circuit with a DockerMissing /
 *     GitMissing error.
 *   - `waitForHttp` polls until 2xx/3xx, promotes 405 to a GET retry,
 *     and returns false on timeout without hanging.
 *   - `commandExists` uses the right platform lookup tool (which/where)
 *     and returns a clean boolean.
 *   - `openBrowser` swallows errors (headless/CI safety).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { platform } from "node:os";
import { runCommand, waitForHttp, commandExists, openBrowser } from "../../src/lib/install/os.ts";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  // Default stub — each test overrides.
  globalThis.fetch = (async () => {
    throw new Error("no fetch stub installed");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("runCommand", () => {
  it("returns ok=true + exit code 0 on success", async () => {
    const cmd = platform() === "win32" ? "cmd" : "true";
    const args = platform() === "win32" ? ["/c", "exit 0"] : [];
    const res = await runCommand(cmd, args, { stdio: "ignore" });
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
  });

  it("returns ok=false + non-zero exit when the command fails", async () => {
    if (platform() === "win32") return;
    const res = await runCommand("false", [], { stdio: "ignore" });
    expect(res.ok).toBe(false);
    expect(res.exitCode).not.toBe(0);
  });

  it("returns ok=false + exitCode=-1 when the binary is missing (ENOENT)", async () => {
    const res = await runCommand("___appstrate_definitely_not_a_binary___", [], {
      stdio: "ignore",
    });
    expect(res.ok).toBe(false);
    // spawn fires `error` on ENOENT — runCommand maps that to -1.
    expect(res.exitCode).toBe(-1);
  });

  it("captures stdout when stdio=pipe", async () => {
    if (platform() === "win32") return;
    const res = await runCommand("printf", ["hello"]);
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe("hello");
  });
});

describe("commandExists", () => {
  it("returns true for a universally-available shell tool", () => {
    // `sh` on unix, `cmd` on Windows — both ship by default.
    const probe = platform() === "win32" ? "cmd" : "sh";
    expect(commandExists(probe)).toBe(true);
  });

  it("returns false for a non-existent binary", () => {
    expect(commandExists("___appstrate_no_such_command_xyz___")).toBe(false);
  });
});

describe("waitForHttp", () => {
  it("returns true on the first 2xx response", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const ok = await waitForHttp("http://127.0.0.1:65535/", 3_000);
    expect(ok).toBe(true);
    expect(calls).toBe(1);
  });

  it("accepts 3xx redirects as healthy", async () => {
    globalThis.fetch = (async () => new Response("", { status: 302 })) as unknown as typeof fetch;
    const ok = await waitForHttp("http://127.0.0.1:65535/", 3_000);
    expect(ok).toBe(true);
  });

  it("falls back to GET when HEAD returns 405", async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      // HEAD → 405, GET → 200
      if (init?.method === "HEAD") return new Response("", { status: 405 });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const ok = await waitForHttp("http://127.0.0.1:65535/", 3_000);
    expect(ok).toBe(true);
    expect(methods).toEqual(["HEAD", "GET"]);
  });

  it("returns false when the deadline elapses without a healthy response", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const start = Date.now();
    const ok = await waitForHttp("http://127.0.0.1:65535/", 50);
    expect(ok).toBe(false);
    // Deadline is respected within a few seconds (not hours). `waitForHttp`
    // sleeps 1s between attempts so a 50ms budget completes in well under 2s.
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it("keeps polling through connection errors", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls < 2) throw new TypeError("ECONNREFUSED");
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const ok = await waitForHttp("http://127.0.0.1:65535/", 5_000);
    expect(ok).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

describe("openBrowser", () => {
  it("never throws even if the platform has no GUI", async () => {
    // `open` on a headless CI container fails silently; the wrapper
    // swallows. This test just asserts no exception escapes.
    await openBrowser("http://127.0.0.1:65535");
  });
});
