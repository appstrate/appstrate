// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for token-aware context budgeting end-to-end
 * through the MCP `/mcp` endpoint.
 *
 * These tests exercise the full path:
 *
 *   agent → POST /mcp (JSON-RPC) → mountMcp → tools/call →
 *     api_call / run_history / recall_memory →
 *       executeApiCall (or platform fetchFn) →
 *         responseToToolResult — the function under test, where the
 *         token-budget tracker is consulted.
 *
 * Coverage focus:
 *   - dense JSON below the byte threshold but above the token cap
 *     spills correctly (issue #390 primary scenario).
 *   - 50× small-call cumulative pressure forces spill once the run
 *     budget is exhausted, without any single call hitting the
 *     per-call cap (issue #390 secondary scenario).
 *   - the budget tracker's own accounting (`consumedTokens`) reflects
 *     what was inlined and what was spilled.
 *   - `run_history` and `recall_memory` honour the same gate as
 *     `api_call`.
 */

import { describe, it, expect, mock } from "bun:test";
import { Hono } from "hono";
import { buildSidecarRuntimeDeps, type AppDeps } from "../app.ts";
import { createTestApp } from "./helpers/authed-app.ts";
import { mountMcp } from "../mcp.ts";
import { buildApiCallHost } from "./helpers/api-call-host.ts";
import { BlobStore } from "../blob-store.ts";
import { TokenBudget, estimateTokens } from "../token-budget.ts";
import type { CredentialsResponse } from "../helpers.ts";

function makeDeps(overrides?: Partial<AppDeps>): AppDeps {
  return {
    config: { platformApiUrl: "http://mock:3000", runToken: "tok", proxyUrl: "" },
    cookieJar: new Map(),
    // bun:test Mock lacks fetch.preconnect — cross-lib friction with DOM `typeof fetch`.
    fetchFn: mock(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    isReady: () => true,
    ...overrides,
  };
}

const defaultFetchCredentials = async (): Promise<CredentialsResponse> => ({
  credentials: { access_token: "test-123" },
  authorizedUris: ["https://api.example.com/**"],
  allowAllUris: false,
  credentialHeaderName: "Authorization",
  credentialHeaderPrefix: "Bearer",
  credentialFieldName: "access_token",
});

async function rpc(
  app: ReturnType<typeof createTestApp>,
  body: { method: string; params?: unknown },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Host: "localhost",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
  });
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text) };
}

interface ContentBlock {
  type: string;
  text?: string;
  uri?: string;
  name?: string;
  mimeType?: string;
}

interface CallToolResult {
  content: ContentBlock[];
  isError?: boolean;
}

/**
 * Build a Hono app wired with a custom `TokenBudget`. Bypasses
 * `createApp` so tests can drive the budget independently of env vars
 * (which createApp reads at boot).
 */
async function buildTestApp(opts: {
  deps: AppDeps;
  tokenBudget: TokenBudget;
  blobStore?: BlobStore;
}): Promise<Hono> {
  const app = new Hono();
  const blobStore =
    opts.blobStore ?? new BlobStore("run-test", { maxTotalBytes: 256 * 1024 * 1024 });
  const proxyDeps = {
    config: opts.deps.config,
    cookieJar: opts.deps.cookieJar,
    fetchFn: opts.deps.fetchFn ?? fetch,
    reportedAuthFailures: new Set<string>(),
  };
  // The credential-proxy core (token-budget / blob spillover) is exercised
  // through the generic `{ns}__api_call` tool, now hosted as a trusted
  // in-process MCP server on an McpHost. The SAME blobStore + tokenBudget
  // flow into both the api_call tool (via the host) and the outer server.
  const host = await buildApiCallHost(
    [
      {
        namespace: "test",
        integrationId: "@test/integ",
        fetchCredentials: defaultFetchCredentials,
        refreshCredentials: defaultFetchCredentials,
      },
    ],
    { proxyDeps, blobStore, tokenBudget: opts.tokenBudget },
  );
  mountMcp(app, {
    blobStore,
    tokenBudget: opts.tokenBudget,
    additionalToolsProvider: () => host.buildTools(),
    proxyDeps,
  });
  return app;
}

describe("token-aware spill — dense JSON (issue #390 primary)", () => {
  // 30 KB of dense JSON ≈ 8572 tokens: above a tight 4000-token inline
  // cap even though the raw byte size is modest. The token budget must
  // spill it instead of burning 8.5 K of context inline.

  it("spills 30 KB JSON when token cap is 4000 tokens", async () => {
    const denseJson = JSON.stringify({ items: "x".repeat(30_000) });
    const fetchFn = mock(
      async () =>
        new Response(denseJson, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const tokenBudget = new TokenBudget({ inlineCapTokens: 4_000, runBudgetTokens: 100_000 });
    const app = await buildTestApp({
      deps: makeDeps({ fetchFn: fetchFn as unknown as typeof fetch }),
      tokenBudget,
    });

    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "test__api_call",
        arguments: {
          target: "https://api.example.com/items",
          method: "GET",
        },
      },
    });
    const result = res.json.result as CallToolResult;
    expect(result.content[0]!.type).toBe("resource_link");
    expect(result.content[0]!.uri).toMatch(/^appstrate:\/\/api-response\//);

    // Spilled because this single body exceeds the per-call inline cap,
    // not because the run budget was under pressure.
    expect(estimateTokens(denseJson)).toBeGreaterThan(4_000);
    // tryReserve() does NOT record on the spill path — the agent never
    // paid the context cost, so the run budget is untouched.
    expect(tokenBudget.consumedTokens()).toBe(0);
  });

  it("inlines small JSON that comfortably fits the per-call cap", async () => {
    const smallJson = JSON.stringify({ ok: true, value: 42 });
    const fetchFn = mock(
      async () =>
        new Response(smallJson, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const tokenBudget = new TokenBudget({ inlineCapTokens: 4_000, runBudgetTokens: 100_000 });
    const app = await buildTestApp({
      deps: makeDeps({ fetchFn: fetchFn as unknown as typeof fetch }),
      tokenBudget,
    });

    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "test__api_call",
        arguments: {
          target: "https://api.example.com/items",
          method: "GET",
        },
      },
    });
    const result = res.json.result as CallToolResult;
    expect(result.content[0]!.type).toBe("text");
    expect(result.content[0]!.text).toBe(smallJson);

    expect(estimateTokens(smallJson)).toBeLessThan(4_000);
    // Inlined output IS recorded against the run budget.
    expect(tokenBudget.consumedTokens()).toBe(estimateTokens(smallJson));
  });
});

describe("token-aware spill — cumulative pressure (issue #390 secondary)", () => {
  // 50 successive calls, each well under the per-call cap, should
  // eventually trip the run-level budget — the scenario the byte cap
  // cannot detect because each call is judged in isolation.

  it("forces spill once cumulative budget is exhausted, never before", async () => {
    // Per-call payload: ~3 K tokens (10500 chars / 3.5).
    const perCallPayload = JSON.stringify({ rows: "x".repeat(10_500 - 13) });
    expect(estimateTokens(perCallPayload)).toBeGreaterThan(2_000);
    expect(estimateTokens(perCallPayload)).toBeLessThan(4_000);

    const fetchFn = mock(
      async () =>
        new Response(perCallPayload, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    // Inline cap allows each call individually; run budget tight
    // enough to exhaust within 50 calls.
    const tokenBudget = new TokenBudget({ inlineCapTokens: 4_000, runBudgetTokens: 20_000 });
    const app = await buildTestApp({
      deps: makeDeps({ fetchFn: fetchFn as unknown as typeof fetch }),
      tokenBudget,
    });

    let inlineCount = 0;
    let spillCount = 0;
    let consumedAtFirstSpill: number | undefined;

    for (let i = 0; i < 30; i++) {
      const res = await rpc(app, {
        method: "tools/call",
        params: {
          name: "test__api_call",
          arguments: {
            target: "https://api.example.com/items",
            method: "GET",
          },
        },
      });
      const result = res.json.result as CallToolResult;
      if (result.content[0]!.type === "text") {
        inlineCount++;
      } else {
        spillCount++;
        // Spilling does not record, so this reads the total the earlier
        // inlined calls accumulated.
        consumedAtFirstSpill ??= tokenBudget.consumedTokens();
      }
    }

    // Some calls should inline (early), others spill (late).
    expect(inlineCount).toBeGreaterThan(0);
    expect(spillCount).toBeGreaterThan(0);
    // The first spill was due to the CUMULATIVE budget, not the per-call
    // cap: no single call exceeds the cap (asserted above), and at the
    // moment it spilled one more call would have pushed the run total
    // past the 20 K ceiling.
    expect(consumedAtFirstSpill).toBeDefined();
    expect(consumedAtFirstSpill! + estimateTokens(perCallPayload)).toBeGreaterThan(20_000);
  });
});

describe("token-aware spill — run-budget accounting", () => {
  it("records an inlined tool result against the run budget (text path)", async () => {
    const fetchFn = mock(
      async () =>
        new Response('{"hello":"world"}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const tokenBudget = new TokenBudget({ inlineCapTokens: 4_000, runBudgetTokens: 100_000 });
    const app = await buildTestApp({
      deps: makeDeps({ fetchFn: fetchFn as unknown as typeof fetch }),
      tokenBudget,
    });

    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "test__api_call",
        arguments: {
          target: "https://api.example.com/items",
          method: "GET",
        },
      },
    });
    const result = res.json.result as CallToolResult;
    expect(result.content[0]!.type).toBe("text");
    // tryReserve records on the inline path, so the run total after one
    // call is exactly that call's estimate.
    expect(tokenBudget.consumedTokens()).toBeGreaterThan(0);
    expect(tokenBudget.consumedTokens()).toBe(estimateTokens('{"hello":"world"}'));
  });

  it("accumulates consumedTokens across successive inline calls", async () => {
    const payload = '{"hello":"world","data":"' + "x".repeat(100) + '"}';
    const fetchFn = mock(
      async () =>
        new Response(payload, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const tokenBudget = new TokenBudget({ inlineCapTokens: 4_000, runBudgetTokens: 100_000 });
    const app = await buildTestApp({
      deps: makeDeps({ fetchFn: fetchFn as unknown as typeof fetch }),
      tokenBudget,
    });

    const consumed: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await rpc(app, {
        method: "tools/call",
        params: {
          name: "test__api_call",
          arguments: {
            target: "https://api.example.com/items",
            method: "GET",
          },
        },
      });
      const result = res.json.result as CallToolResult;
      expect(result.content[0]!.type).toBe("text");
      consumed.push(tokenBudget.consumedTokens());
    }
    // tryReserve records before returning, so the total read after call N
    // includes call N's own contribution.
    expect(consumed[0]).toBeGreaterThan(0);
    expect(consumed[1]).toBeGreaterThan(consumed[0]!);
    expect(consumed[2]).toBeGreaterThan(consumed[1]!);
  });
});

describe("token-aware spill — applied to all platform tools", () => {
  it("run_history is gated by the token budget", async () => {
    const oversized = "y".repeat(60_000); // ~17 K tokens
    const fetchFn = mock(
      async () =>
        new Response(oversized, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const tokenBudget = new TokenBudget({ inlineCapTokens: 4_000, runBudgetTokens: 100_000 });
    const app = await buildTestApp({
      deps: makeDeps({ fetchFn: fetchFn as unknown as typeof fetch }),
      tokenBudget,
    });

    const res = await rpc(app, {
      method: "tools/call",
      params: { name: "run_history", arguments: { limit: 1 } },
    });
    const result = res.json.result as CallToolResult;
    expect(result.content[0]!.type).toBe("resource_link");
    // Spilled on the per-call cap; nothing recorded against the run budget.
    expect(estimateTokens(oversized)).toBeGreaterThan(4_000);
    expect(tokenBudget.consumedTokens()).toBe(0);
  });

  it("recall_memory is gated by the token budget", async () => {
    const oversized = "z".repeat(60_000);
    const fetchFn = mock(
      async () =>
        new Response(oversized, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const tokenBudget = new TokenBudget({ inlineCapTokens: 4_000, runBudgetTokens: 100_000 });
    const app = await buildTestApp({
      deps: makeDeps({ fetchFn: fetchFn as unknown as typeof fetch }),
      tokenBudget,
    });

    const res = await rpc(app, {
      method: "tools/call",
      params: { name: "recall_memory", arguments: { q: "foo" } },
    });
    const result = res.json.result as CallToolResult;
    expect(result.content[0]!.type).toBe("resource_link");
    expect(tokenBudget.consumedTokens()).toBe(0);
  });
});

describe("token-aware spill — env-var configuration via createApp", () => {
  // `createApp` reads the env vars at boot; verify the wiring runs.
  // The actual TokenBudget constructor invariants are tested in
  // token-budget.test.ts.

  it("respects SIDECAR_INLINE_TOOL_OUTPUT_TOKENS / SIDECAR_RUN_TOOL_OUTPUT_BUDGET_TOKENS", async () => {
    const original = {
      inline: process.env.SIDECAR_INLINE_TOOL_OUTPUT_TOKENS,
      run: process.env.SIDECAR_RUN_TOOL_OUTPUT_BUDGET_TOKENS,
    };
    try {
      process.env.SIDECAR_INLINE_TOOL_OUTPUT_TOKENS = "100";
      process.env.SIDECAR_RUN_TOOL_OUTPUT_BUDGET_TOKENS = "1000";

      const fetchFn = mock(
        async () =>
          new Response('{"big":"' + "x".repeat(2000) + '"}', {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      // Build runtimeDeps explicitly so the env-var-driven TokenBudget is
      // shared with the in-process api_call host (mirrors server.ts).
      const appDeps = makeDeps({ fetchFn: fetchFn as unknown as typeof fetch });
      const runtimeDeps = buildSidecarRuntimeDeps(appDeps);
      const host = await buildApiCallHost(
        [
          {
            namespace: "test",
            integrationId: "@test/integ",
            fetchCredentials: defaultFetchCredentials,
            refreshCredentials: defaultFetchCredentials,
          },
        ],
        runtimeDeps,
      );
      const app = createTestApp({
        ...appDeps,
        runtimeDeps,
        additionalMcpToolsProvider: () => host.buildTools(),
      });
      const res = await rpc(app, {
        method: "tools/call",
        params: {
          name: "test__api_call",
          arguments: {
            target: "https://api.example.com/items",
            method: "GET",
          },
        },
      });
      const result = res.json.result as CallToolResult;
      // 2000 chars / 3.5 ≈ 572 tokens — above the 100-token cap.
      expect(result.content[0]!.type).toBe("resource_link");
      expect(runtimeDeps.tokenBudget.inlineCapTokens).toBe(100);
      expect(runtimeDeps.tokenBudget.runBudgetTokens).toBe(1000);
    } finally {
      // Restore env so we don't leak state into the next test file.
      if (original.inline === undefined) delete process.env.SIDECAR_INLINE_TOOL_OUTPUT_TOKENS;
      else process.env.SIDECAR_INLINE_TOOL_OUTPUT_TOKENS = original.inline;
      if (original.run === undefined) delete process.env.SIDECAR_RUN_TOOL_OUTPUT_BUDGET_TOKENS;
      else process.env.SIDECAR_RUN_TOOL_OUTPUT_BUDGET_TOKENS = original.run;
    }
  });

  it("createApp throws at boot when env vars are malformed", () => {
    const original = process.env.SIDECAR_INLINE_TOOL_OUTPUT_TOKENS;
    process.env.SIDECAR_INLINE_TOOL_OUTPUT_TOKENS = "not-a-number";
    try {
      expect(() => createTestApp(makeDeps())).toThrow(/positive integer/);
    } finally {
      if (original === undefined) delete process.env.SIDECAR_INLINE_TOOL_OUTPUT_TOKENS;
      else process.env.SIDECAR_INLINE_TOOL_OUTPUT_TOKENS = original;
    }
  });

  it("boots (does not throw) when modelMaxTokens == modelContextWindow — the run_b6e99890 regression", () => {
    // Exercises the EXACT crash site (`buildSidecarRuntimeDeps`), not just
    // the TokenBudget constructor: the launcher forwards a resolved model's
    // `(contextWindow, maxTokens)` verbatim, and Devstral 2512 carries the
    // impossible `256000 / 256000` from the LiteLLM catalog. Pre-fix this
    // threw → sidecar exited code 1 → no heartbeat → run failed after 60s.
    const appDeps = makeDeps({
      config: {
        platformApiUrl: "http://mock:3000",
        runToken: "tok",
        proxyUrl: "",
        modelContextWindow: 256_000,
        modelMaxTokens: 256_000,
      },
    });
    let runtimeDeps!: ReturnType<typeof buildSidecarRuntimeDeps>;
    expect(() => {
      runtimeDeps = buildSidecarRuntimeDeps(appDeps);
    }).not.toThrow();
    expect(runtimeDeps.tokenBudget.contextWindowTokens).toBe(256_000);
    // Impossible cap dropped → derived default max(16384, 256000 × 0.2).
    expect(runtimeDeps.tokenBudget.reserveTokens).toBe(51_200);
    expect(runtimeDeps.tokenBudget.reserveTokens).toBeLessThan(256_000);
  });

  it("keeps a valid modelMaxTokens (< window) as the reserve at the wiring layer", () => {
    const appDeps = makeDeps({
      config: {
        platformApiUrl: "http://mock:3000",
        runToken: "tok",
        proxyUrl: "",
        modelContextWindow: 200_000,
        modelMaxTokens: 64_000, // Claude Sonnet thinking — must be preserved
      },
    });
    const runtimeDeps = buildSidecarRuntimeDeps(appDeps);
    expect(runtimeDeps.tokenBudget.reserveTokens).toBe(64_000);
  });
});

describe("token-aware spill — fallback when blob store is full", () => {
  it("falls back to inline and records the tokens when the blob store is full", async () => {
    // Blob store with cumulative cap of 100 bytes; first put exhausts.
    const blobStore = new BlobStore("run-test", { maxTotalBytes: 100 });
    blobStore.put(new Uint8Array(95)); // leave only 5 bytes

    const payload = JSON.stringify({ data: "x".repeat(40_000) }); // ~11 K tokens
    const fetchFn = mock(
      async () =>
        new Response(payload, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const tokenBudget = new TokenBudget({ inlineCapTokens: 4_000, runBudgetTokens: 100_000 });
    const app = await buildTestApp({
      deps: makeDeps({ fetchFn: fetchFn as unknown as typeof fetch }),
      tokenBudget,
      blobStore,
    });

    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "test__api_call",
        arguments: {
          target: "https://api.example.com/items",
          method: "GET",
        },
      },
    });
    const result = res.json.result as CallToolResult;
    // Spill failed → forced inline.
    expect(result.content[0]!.type).toBe("text");
    // The forced-inline tokens ARE recorded against the budget — the
    // agent paid the context cost. This is what separates a failed spill
    // from a successful one, which records nothing.
    expect(tokenBudget.consumedTokens()).toBe(estimateTokens(payload));
  });
});
