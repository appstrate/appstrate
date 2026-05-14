// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the `options.retry` path of `createMcpHttpClient` (issue #406).
 *
 * The retry policy is the platform-side absorption of the agent-vs-sidecar
 * boot race: the platform now starts the agent in parallel with the
 * sidecar's `/mcp` listener wiring up + Docker DNS alias propagation, so
 * the first MCP handshake may briefly see `ECONNREFUSED` / `ENOTFOUND` /
 * `ECONNRESET` while the sidecar finishes coming up.
 *
 * Every test injects a deterministic `fetch` mock via `options.fetch` —
 * no real network, no real timing dependence (jitter is bounded by
 * `capMs`, so we assert ranges rather than exact delays).
 */

import { describe, it, expect } from "bun:test";
import { createMcpHttpClient } from "../src/index.ts";
import { createMcpServer, type AppstrateToolDefinition } from "../src/index.ts";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

function noopTool(): AppstrateToolDefinition {
  return {
    descriptor: {
      name: "noop",
      description: "Returns an empty result.",
      inputSchema: { type: "object" },
    },
    handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
}

/**
 * Build a working `/mcp` handler — same shape used by the suite's other
 * tests. Used for the "succeeds-eventually" path.
 */
function buildWorkingFetch(): typeof fetch {
  const handler = async (request: Request): Promise<Response> => {
    const server = createMcpServer([noopTool()], { name: "test", version: "0.0.0" });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: false,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } finally {
      await transport.close();
      await server.close();
    }
  };
  return ((req: Request | string | URL, init?: RequestInit) => {
    const request = req instanceof Request ? req : new Request(req as string, init);
    return handler(request);
  }) as typeof fetch;
}

/**
 * Build a `fetch` mock that fails the first `failCount` calls with a
 * pseudo-network error carrying a Node-style `code`, then delegates to
 * a working `/mcp` handler. Mirrors the shape Bun/undici surface for
 * ECONNREFUSED on a not-yet-listening port (`TypeError("fetch failed")`
 * with `cause: { code: "ECONNREFUSED" }`).
 */
function buildFlakyFetch(
  failCount: number,
  failCode: string,
): { fetch: typeof fetch; callCount: () => number } {
  let count = 0;
  const working = buildWorkingFetch();
  const fetcher: typeof fetch = ((req: Request | string | URL, init?: RequestInit) => {
    count += 1;
    if (count <= failCount) {
      const err = new TypeError("fetch failed");
      (err as { cause?: unknown }).cause = { code: failCode };
      return Promise.reject(err);
    }
    return working(req as Request, init);
  }) as typeof fetch;
  return { fetch: fetcher, callCount: () => count };
}

const TARGET_URL = new URL("http://test.invalid/mcp");

describe("createMcpHttpClient — retry", () => {
  it("succeeds on the first attempt with zero retries when the server is healthy", async () => {
    const seen: number[] = [];
    const client = await createMcpHttpClient(TARGET_URL, {
      fetch: buildWorkingFetch(),
      retry: {
        deadlineMs: 5_000,
        baseMs: 50,
        capMs: 1_000,
        onRetry: ({ attempt }) => seen.push(attempt),
      },
    });
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(1);
      expect(seen).toEqual([]); // no retry callback fired
    } finally {
      await client.close();
    }
  });

  it("retries on ECONNREFUSED and eventually connects (3 failures → success)", async () => {
    const { fetch: fetcher, callCount } = buildFlakyFetch(3, "ECONNREFUSED");
    const attempts: number[] = [];
    const delays: number[] = [];
    const startedAt = Date.now();

    const client = await createMcpHttpClient(TARGET_URL, {
      fetch: fetcher,
      retry: {
        deadlineMs: 10_000,
        baseMs: 50,
        capMs: 200,
        onRetry: ({ attempt, delayMs }) => {
          attempts.push(attempt);
          delays.push(delayMs);
        },
      },
    });
    const elapsed = Date.now() - startedAt;

    try {
      expect(attempts).toEqual([0, 1, 2]);
      // Full jitter: every delay is bounded by `min(cap, base * 2^n)`.
      // attempt 0 → [0, 50]; attempt 1 → [0, 100]; attempt 2 → [0, 200].
      expect(delays[0]).toBeGreaterThanOrEqual(0);
      expect(delays[0]).toBeLessThanOrEqual(50);
      expect(delays[1]).toBeLessThanOrEqual(100);
      expect(delays[2]).toBeLessThanOrEqual(200);
      // Total elapsed loosely upper-bounded by the sum of caps + overhead.
      expect(elapsed).toBeLessThan(5_000);
      // 3 failed attempts + 1 successful = 4 fetch calls in the simplest
      // SDK shape; in practice the SDK may issue more on connect — the
      // important invariant is that retries actually fired.
      expect(callCount()).toBeGreaterThanOrEqual(4);
    } finally {
      await client.close();
    }
  });

  it("retries on ENOTFOUND (Docker DNS alias not yet propagated)", async () => {
    const { fetch: fetcher } = buildFlakyFetch(2, "ENOTFOUND");
    const attempts: number[] = [];
    const client = await createMcpHttpClient(TARGET_URL, {
      fetch: fetcher,
      retry: {
        deadlineMs: 5_000,
        baseMs: 10,
        capMs: 50,
        onRetry: ({ attempt }) => attempts.push(attempt),
      },
    });
    try {
      expect(attempts.length).toBeGreaterThanOrEqual(2);
    } finally {
      await client.close();
    }
  });

  it("throws immediately on HTTP 401 (auth error — fatal, no retries)", async () => {
    let calls = 0;
    const fetcher = (() => {
      calls += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;

    const retryCalls: number[] = [];
    let caught: unknown;
    try {
      await createMcpHttpClient(TARGET_URL, {
        fetch: fetcher,
        retry: {
          deadlineMs: 5_000,
          baseMs: 50,
          capMs: 1_000,
          onRetry: ({ attempt }) => retryCalls.push(attempt),
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(retryCalls).toEqual([]); // no retry callbacks
    // SDK calls fetch exactly once before throwing — the second 401
    // would mean the retry loop ran.
    expect(calls).toBeLessThanOrEqual(2);
  });

  it("throws immediately on TypeError (malformed URL / programmer error)", async () => {
    const fetcher = (() => {
      // TypeError without a Node `code` — looks like a programmer error,
      // not a transient network blip. Must be fatal.
      return Promise.reject(new TypeError("Invalid URL"));
    }) as unknown as typeof fetch;

    const retryCalls: number[] = [];
    let caught: unknown;
    try {
      await createMcpHttpClient(TARGET_URL, {
        fetch: fetcher,
        retry: {
          deadlineMs: 5_000,
          baseMs: 50,
          capMs: 1_000,
          onRetry: ({ attempt }) => retryCalls.push(attempt),
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect(retryCalls).toEqual([]);
  });

  it("throws a deadline-exceeded error with the last code embedded when retries run out", async () => {
    // Permanent ECONNREFUSED: deadline must fire and carry the last code.
    let calls = 0;
    const fetcher = (() => {
      calls += 1;
      const err = new TypeError("fetch failed");
      (err as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
      return Promise.reject(err);
    }) as unknown as typeof fetch;

    const deadlineMs = 200;
    const startedAt = Date.now();
    let caught: unknown;
    try {
      await createMcpHttpClient(TARGET_URL, {
        fetch: fetcher,
        retry: {
          deadlineMs,
          baseMs: 10,
          capMs: 30,
        },
      });
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - startedAt;

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/deadline exceeded after 200ms/);
    expect((caught as Error).message).toMatch(/ECONNREFUSED/);
    // Total elapsed within [deadline, deadline + capMs + overhead].
    expect(elapsed).toBeGreaterThanOrEqual(deadlineMs - 10);
    expect(elapsed).toBeLessThan(deadlineMs + 500);
    expect(calls).toBeGreaterThan(1); // multiple attempts before deadline
  });

  it("aborts mid-retry when the caller signal fires — no further attempts", async () => {
    let calls = 0;
    const fetcher = (() => {
      calls += 1;
      const err = new TypeError("fetch failed");
      (err as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
      return Promise.reject(err);
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    // Abort after the first retry sleep is queued.
    setTimeout(() => controller.abort(), 30);

    let caught: unknown;
    try {
      await createMcpHttpClient(TARGET_URL, {
        fetch: fetcher,
        signal: controller.signal,
        retry: {
          deadlineMs: 10_000,
          baseMs: 50,
          capMs: 500,
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(
      (caught as Error).name === "AbortError" || /aborted/i.test((caught as Error).message),
    ).toBe(true);
    // Should NOT have spun an unbounded number of attempts after abort.
    expect(calls).toBeLessThan(20);
  });

  it("preserves the legacy single-shot behaviour when `retry` is omitted", async () => {
    // No retry option → single attempt, throw immediately on failure.
    let calls = 0;
    const fetcher = (() => {
      calls += 1;
      const err = new TypeError("fetch failed");
      (err as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
      return Promise.reject(err);
    }) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await createMcpHttpClient(TARGET_URL, { fetch: fetcher });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    // SDK may retry inside its transport, but our wrapper does not — so
    // the call count is bounded by the SDK's own behaviour, NOT by the
    // deadline loop. Realistically: 1 call.
    expect(calls).toBeLessThanOrEqual(2);
  });
});
