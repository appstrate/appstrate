// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `probeUsercontentReachability()` (issue #1001).
 *
 * The probe fires ONE unauthenticated GET at
 * `${USERCONTENT_URL}/preview/documents/_probe` at boot and, unless it observes
 * the expected `401` (route reached AND enforcing the preview token — healthy),
 * emits exactly one `logger.error` naming the URL and observed status. It is
 * never fatal and never runs when `USERCONTENT_URL` is unset.
 *
 * Per AGENTS.md ("No `mock.module()`: use dependency injection instead") the
 * HTTP layer is controlled by swapping `globalThis.fetch` and the env by
 * rewriting `process.env` + dropping the cached `getEnv()` snapshot via
 * `_resetCacheForTesting()`. `logger.error` is observed with `spyOn`.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn } from "bun:test";
import { _resetCacheForTesting } from "@appstrate/env";
import { logger } from "../../src/lib/logger.ts";
import { probeUsercontentReachability } from "../../src/lib/boot.ts";

// Snapshot the env we mutate so sibling test files in the same process are
// unaffected.
const SNAPSHOT = {
  USERCONTENT_URL: process.env.USERCONTENT_URL,
};

function restoreEnv(): void {
  for (const [k, v] of Object.entries(SNAPSHOT)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetCacheForTesting();
}

// A host distinct from APP_URL (localhost in the test preload) so the env
// refinement (USERCONTENT_URL host must differ from APP_URL) is satisfied.
const UC = "http://usercontent.example.test";
const PROBE_URL = `${UC}/preview/documents/_probe`;

type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
let originalFetch: typeof fetch;
function mockFetch(impl: FetchImpl): void {
  originalFetch = globalThis.fetch;
  globalThis.fetch = impl as unknown as typeof fetch;
}
function restoreFetch(): void {
  if (originalFetch) globalThis.fetch = originalFetch;
}

describe("probeUsercontentReachability", () => {
  let errorSpy: ReturnType<typeof spyOn<typeof logger, "error">>;

  beforeEach(() => {
    errorSpy = spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    restoreFetch();
    restoreEnv();
  });

  afterAll(() => {
    restoreEnv();
  });

  it("no-ops when USERCONTENT_URL is unset — no fetch, no log", async () => {
    delete process.env.USERCONTENT_URL;
    _resetCacheForTesting();
    let fetched = false;
    mockFetch(async () => {
      fetched = true;
      return new Response(null, { status: 200 });
    });

    await probeUsercontentReachability();

    expect(fetched).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(0);
  });

  it("stays silent when the probe returns 401 (route reached, auth enforced)", async () => {
    process.env.USERCONTENT_URL = UC;
    _resetCacheForTesting();
    // Collected in an array (not a narrowed `let`): it doubles as the
    // "exactly one request" assertion and keeps the closure write visible to
    // TypeScript's control-flow analysis.
    const probed: string[] = [];
    mockFetch(async (input) => {
      probed.push(typeof input === "string" ? input : input.toString());
      return new Response(null, { status: 401 });
    });

    await probeUsercontentReachability();

    expect(probed).toEqual([PROBE_URL]);
    expect(errorSpy).toHaveBeenCalledTimes(0);
  });

  it("warns exactly once with url + status on a non-401 response (503)", async () => {
    process.env.USERCONTENT_URL = UC;
    _resetCacheForTesting();
    mockFetch(async () => new Response(null, { status: 503 }));

    await probeUsercontentReachability();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [msg, data] = errorSpy.mock.calls[0]!;
    expect(String(msg)).toContain("did not return 401");
    expect(data).toEqual({ url: PROBE_URL, status: 503 });
  });

  it("warns once with status null when the fetch throws (timeout / refused)", async () => {
    process.env.USERCONTENT_URL = UC;
    _resetCacheForTesting();
    mockFetch(async () => {
      throw new Error("connection refused");
    });

    await probeUsercontentReachability();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [, data] = errorSpy.mock.calls[0]!;
    expect(data).toEqual({ url: PROBE_URL, status: null });
  });
});
