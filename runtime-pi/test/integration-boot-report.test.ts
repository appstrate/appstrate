// SPDX-License-Identifier: Apache-2.0

/**
 * `fetchIntegrationBootReport` has one deadline for every attempt together,
 * and retries only a request that never reached a listener: a deadline abort
 * or an HTTP error is final.
 */

import { describe, it, expect, afterEach, jest } from "bun:test";
import type { IntegrationBootReport } from "@appstrate/core/sidecar-types";
import { fetchIntegrationBootReport } from "../mcp/integration-boot-report.ts";

const DEADLINE_MS = 120_000;

const report: IntegrationBootReport = {
  ok: true,
  declaredConnections: 0,
  adapter: "none",
  spawned: [],
  failed: [],
  breadcrumbs: [],
};

const quiet = () => {};

afterEach(() => {
  jest.useRealTimers();
});

/** Flush the promise continuations queued by a settled fetch. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("fetchIntegrationBootReport", () => {
  it("retries a transport failure, then returns the report", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      if (calls === 1) throw new TypeError("Unable to connect");
      return Response.json(report);
    }) as unknown as typeof fetch;

    expect(await fetchIntegrationBootReport("http://sidecar", "tok", fetchFn, quiet)).toEqual({
      report,
    });
    expect(calls).toBe(2);
  });

  it("does not retry an HTTP error", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response("nope", { status: 503 });
    }) as unknown as typeof fetch;

    expect(await fetchIntegrationBootReport("http://sidecar", "tok", fetchFn, quiet)).toEqual({
      error: "HTTP 503",
    });
    expect(calls).toBe(1);
  });

  it("does not retry a request the deadline aborted", async () => {
    jest.useFakeTimers();
    let calls = 0;
    const fetchFn = ((_url: string, init: RequestInit) => {
      calls++;
      return new Promise<Response>((_, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
      });
    }) as unknown as typeof fetch;

    let result: unknown;
    const pending = fetchIntegrationBootReport("http://sidecar", "tok", fetchFn, quiet).then(
      (r) => {
        result = r;
      },
    );
    jest.advanceTimersByTime(DEADLINE_MS - 1);
    await settle();
    expect(result).toBeUndefined();

    jest.advanceTimersByTime(1);
    await pending;
    expect(result).toEqual({ error: "no boot report within 120 s" });
    expect(calls).toBe(1);
  });

  it("stops retrying transport failures at the one deadline", async () => {
    jest.useFakeTimers();
    let calls = 0;
    const fetchFn = ((_url: string, init: RequestInit) => {
      calls++;
      return init.signal!.aborted
        ? Promise.reject(init.signal!.reason)
        : Promise.reject(new TypeError("Unable to connect"));
    }) as unknown as typeof fetch;

    let result: unknown;
    void fetchIntegrationBootReport("http://sidecar", "tok", fetchFn, quiet).then((r) => {
      result = r;
    });
    let elapsed = 0;
    while (result === undefined && elapsed < 10 * DEADLINE_MS) {
      await settle();
      jest.advanceTimersByTime(100);
      elapsed += 100;
    }
    await settle();

    expect(result).toEqual({ error: "no boot report within 120 s" });
    expect(calls).toBeGreaterThan(1);
    // Ends within one capped retry delay of the deadline, not after N deadlines.
    expect(elapsed).toBeLessThanOrEqual(DEADLINE_MS + 2_000);
  });
});
