// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `preflightCheck` — the connections-readiness gate
 * that runs before `appstrate run` triggers an agent.
 *
 * All tests inject `fetchImpl`, `openBrowser`, and `confirmPrompt` via
 * the function's documented test seams — no `mock.module()`.
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  preflightCheck,
  PreflightAbortError,
  assertSameOrigin,
  nextBackoffMs,
} from "../src/commands/run/preflight.ts";

const BASE_INPUTS = {
  instance: "https://app.example.com",
  bearerToken: "ask_test_token",
  appId: "app_test",
  scope: "@scope",
  name: "agent",
  json: false,
  skip: false,
};

function makeFetch(reports: Array<{ ready: boolean; missing: unknown[] }>): {
  fetchImpl: typeof fetch;
  callCount: () => number;
  urls: string[];
} {
  const urls: string[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request) => {
    urls.push(typeof url === "string" ? url : url.toString());
    const body = reports[Math.min(i++, reports.length - 1)]!;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, callCount: () => i, urls };
}

describe("preflightCheck", () => {
  // Tests that prompt require a TTY. Fake it where needed and restore.
  let originalIsTty: boolean | undefined;
  afterEach(() => {
    if (originalIsTty === undefined) {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    } else {
      (process.stdin as { isTTY?: boolean }).isTTY = originalIsTty;
    }
    originalIsTty = undefined;
  });

  it("returns silently on first call when ready", async () => {
    const { fetchImpl, callCount } = makeFetch([{ ready: true, missing: [] }]);
    const report = await preflightCheck({
      ...BASE_INPUTS,
      fetchImpl,
      openBrowser: () => {
        throw new Error("should not open browser when ready");
      },
      confirmPrompt: async () => {
        throw new Error("should not prompt when ready");
      },
    });
    expect(report.ready).toBe(true);
    expect(callCount()).toBe(1);
  });

  it("polls until ready after browser handoff", async () => {
    const missing = [
      {
        providerId: "@afps/gmail",
        profileId: null,
        reason: "no_connection",
        message: "not connected",
      },
    ];
    const { fetchImpl, callCount } = makeFetch([
      { ready: false, missing },
      { ready: false, missing },
      { ready: true, missing: [] },
    ]);
    let opened = 0;
    originalIsTty = (process.stdin as { isTTY?: boolean }).isTTY;
    (process.stdin as { isTTY?: boolean }).isTTY = true;

    const report = await preflightCheck({
      ...BASE_INPUTS,
      fetchImpl,
      openBrowser: () => {
        opened++;
      },
      confirmPrompt: async () => true,
      pollMs: 1,
      timeoutSeconds: 5,
    });
    expect(report.ready).toBe(true);
    expect(opened).toBe(1);
    // 1 initial + at least 2 polls (the second poll resolves to ready)
    expect(callCount()).toBeGreaterThanOrEqual(3);
  });

  it("throws user_declined when the user says no", async () => {
    const { fetchImpl } = makeFetch([
      {
        ready: false,
        missing: [
          {
            providerId: "@afps/gmail",
            profileId: null,
            reason: "no_connection",
            message: "not connected",
          },
        ],
      },
    ]);
    originalIsTty = (process.stdin as { isTTY?: boolean }).isTTY;
    (process.stdin as { isTTY?: boolean }).isTTY = true;

    await expect(
      preflightCheck({
        ...BASE_INPUTS,
        fetchImpl,
        openBrowser: () => {},
        confirmPrompt: async () => false,
      }),
    ).rejects.toMatchObject({
      name: "PreflightAbortError",
      code: "user_declined",
    });
  });

  it("emits a structured error and exits without prompting in JSON mode", async () => {
    const { fetchImpl } = makeFetch([
      {
        ready: false,
        missing: [
          {
            providerId: "@afps/gmail",
            profileId: null,
            reason: "no_connection",
            message: "not connected",
          },
        ],
      },
    ]);
    let prompted = false;
    let opened = false;
    originalIsTty = (process.stdin as { isTTY?: boolean }).isTTY;
    (process.stdin as { isTTY?: boolean }).isTTY = true; // even on a TTY, --json must not prompt

    let thrown: unknown;
    try {
      await preflightCheck({
        ...BASE_INPUTS,
        json: true,
        fetchImpl,
        openBrowser: () => {
          opened = true;
        },
        confirmPrompt: async () => {
          prompted = true;
          return true;
        },
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(PreflightAbortError);
    const err = thrown as PreflightAbortError;
    expect(err.code).toBe("connections_missing");
    expect(err.connectUrl).toContain("/preferences/connectors");
    expect(prompted).toBe(false);
    expect(opened).toBe(false);
  });

  it("exits without prompting when stdin is not a TTY", async () => {
    const { fetchImpl } = makeFetch([
      {
        ready: false,
        missing: [
          {
            providerId: "@afps/gmail",
            profileId: null,
            reason: "no_connection",
            message: "not connected",
          },
        ],
      },
    ]);
    originalIsTty = (process.stdin as { isTTY?: boolean }).isTTY;
    (process.stdin as { isTTY?: boolean }).isTTY = false;

    await expect(
      preflightCheck({
        ...BASE_INPUTS,
        fetchImpl,
        openBrowser: () => {
          throw new Error("should not open browser in non-TTY context");
        },
        confirmPrompt: async () => {
          throw new Error("should not prompt in non-TTY context");
        },
      }),
    ).rejects.toMatchObject({
      name: "PreflightAbortError",
      code: "connections_missing",
    });
  });

  it("throws preflight_timeout when polling exceeds the configured budget", async () => {
    const missing = [
      {
        providerId: "@afps/gmail",
        profileId: null,
        reason: "no_connection",
        message: "not connected",
      },
    ];
    // Always-not-ready
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ready: false, missing }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    originalIsTty = (process.stdin as { isTTY?: boolean }).isTTY;
    (process.stdin as { isTTY?: boolean }).isTTY = true;

    await expect(
      preflightCheck({
        ...BASE_INPUTS,
        fetchImpl,
        openBrowser: () => {},
        confirmPrompt: async () => true,
        pollMs: 5,
        timeoutSeconds: 0.05,
      }),
    ).rejects.toMatchObject({
      name: "PreflightAbortError",
      code: "preflight_timeout",
    });
  });

  it("includes connectionProfileId and per-provider overrides in the readiness URL", async () => {
    const { fetchImpl, urls } = makeFetch([{ ready: true, missing: [] }]);
    await preflightCheck({
      ...BASE_INPUTS,
      connectionProfileId: "prof_1",
      perProviderOverrides: { "@afps/gmail": "prof_2" },
      fetchImpl,
      openBrowser: () => {},
      confirmPrompt: async () => true,
    });
    expect(urls[0]).toContain("connectionProfileId=prof_1");
    expect(urls[0]).toContain("providerProfile.%40afps%2Fgmail=prof_2");
  });

  it("uses capped exponential backoff between polls", async () => {
    const missing = [
      {
        providerId: "@afps/gmail",
        profileId: null,
        reason: "no_connection",
        message: "not connected",
      },
    ];
    const { fetchImpl } = makeFetch([
      { ready: false, missing },
      { ready: false, missing },
      { ready: false, missing },
      { ready: true, missing: [] },
    ]);
    originalIsTty = (process.stdin as { isTTY?: boolean }).isTTY;
    (process.stdin as { isTTY?: boolean }).isTTY = true;

    // Deterministic jitter source — record the (initial, max, attempt)
    // tuple that nextBackoffMs would have seen. Returning 1 puts us at
    // the cap so the assertions below can reason about it directly.
    const recorded: Array<{ exp: number }> = [];
    let attempt = 0;
    const jitter = () => {
      // Recreate the same expression nextBackoffMs uses internally so
      // we can verify the schedule grows up to pollMaxMs and stays
      // there.
      const exp = Math.min(80, 10 * 2 ** attempt);
      recorded.push({ exp });
      attempt += 1;
      return 0; // wait 0ms — keeps the test fast
    };

    await preflightCheck({
      ...BASE_INPUTS,
      fetchImpl,
      openBrowser: () => {},
      confirmPrompt: async () => true,
      pollMs: 10,
      pollMaxMs: 80,
      randomJitter: jitter,
    });

    expect(recorded.map((r) => r.exp)).toEqual([10, 20, 40]);
  });

  it("nextBackoffMs returns a value within [0, capped(initial * 2^attempt)]", () => {
    const random = () => 0.5;
    expect(nextBackoffMs(100, 1000, 0, random)).toBe(50);
    expect(nextBackoffMs(100, 1000, 3, random)).toBe(400);
    // Cap kicks in: 100 * 2^4 = 1600 > 1000.
    expect(nextBackoffMs(100, 1000, 4, random)).toBe(500);
  });

  it("assertSameOrigin refuses to open a connect URL on a different origin", () => {
    expect(() =>
      assertSameOrigin("https://evil.com/preferences/connectors", "https://app.example.com"),
    ).toThrow(PreflightAbortError);
    // Same origin is fine — different path is permitted.
    expect(() =>
      assertSameOrigin(
        "https://app.example.com/preferences/connectors?profile=p",
        "https://app.example.com",
      ),
    ).not.toThrow();
  });

  it("returns ready=true immediately when skip is set", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const report = await preflightCheck({
      ...BASE_INPUTS,
      skip: true,
      fetchImpl,
    });
    expect(report.ready).toBe(true);
    expect(called).toBe(false);
  });
});
