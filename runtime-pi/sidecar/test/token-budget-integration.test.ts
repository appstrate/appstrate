// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for token-aware context budgeting end-to-end
 * through the MCP `/mcp` endpoint.
 *
 * These tests exercise the full path:
 *
 *   agent → POST /mcp (JSON-RPC) → mountMcp → tools/call →
 *     provider_call / run_history / recall_memory →
 *       executeProviderCall (or platform fetchFn) →
 *         responseToToolResult — the function under test, where the
 *         token-budget tracker is consulted.
 *
 * Coverage focus:
 *   - dense JSON below the byte threshold but above the token cap
 *     spills correctly (issue #390 primary scenario).
 *   - 50× small-call cumulative pressure forces spill once the run
 *     budget is exhausted, without any single call hitting the
 *     per-call cap (issue #390 secondary scenario).
 *   - `_meta` payload carries the budget accounting so the agent
 *     runtime can react to structured truncation events.
 *   - `run_history` and `recall_memory` honour the same gate as
 *     `provider_call`.
 *   - Without a token budget configured, the legacy byte threshold
 *     remains in force (no regression for embedders that don't wire
 *     the budget).
 */

import { describe, it, expect, mock } from "bun:test";
import { Hono } from "hono";
import { createApp, type AppDeps } from "../app.ts";
import { mountMcp } from "../mcp.ts";
import { BlobStore } from "../blob-store.ts";
import { TokenBudget, estimateTokens } from "../token-budget.ts";
import type { CredentialsResponse } from "../helpers.ts";

function makeDeps(overrides?: Partial<AppDeps>): AppDeps {
  return {
    config: { platformApiUrl: "http://mock:3000", runToken: "tok", proxyUrl: "" },
    fetchCredentials: mock(
      async (): Promise<CredentialsResponse> => ({
        credentials: { access_token: "test-123" },
        authorizedUris: ["https://api.example.com/**"],
        allowAllUris: false,
        credentialHeaderName: "Authorization",
        credentialHeaderPrefix: "Bearer",
        credentialFieldName: "access_token",
      }),
    ),
    cookieJar: new Map(),
    fetchFn: mock(async () => new Response("{}", { status: 200 })),
    isReady: () => true,
    ...overrides,
  };
}

async function rpc(
  app: ReturnType<typeof createApp>,
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

const TOKEN_BUDGET_META_KEY = "appstrate://token-budget";

interface BudgetMeta {
  estimatedTokens: number;
  consumedTokens: number;
  runBudgetTokens: number;
  inlineCapTokens: number;
  decision: "inline" | "spill";
  reason:
    | "under_inline_cap"
    | "exceeds_inline_cap"
    | "exceeds_run_budget"
    | "no_blob_store_fallback_inline";
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
  _meta?: Record<string, unknown>;
}

/**
 * Build a Hono app wired with a custom `TokenBudget`. Bypasses
 * `createApp` so tests can drive the budget independently of env vars
 * (which createApp reads at boot).
 */
function buildTestApp(opts: {
  deps: AppDeps;
  tokenBudget?: TokenBudget;
  blobStore?: BlobStore;
}): Hono {
  const app = new Hono();
  const blobStore = opts.blobStore ?? new BlobStore("run-test");
  mountMcp(app, {
    blobStore,
    ...(opts.tokenBudget ? { tokenBudget: opts.tokenBudget } : {}),
    proxyDeps: {
      config: opts.deps.config,
      cookieJar: opts.deps.cookieJar,
      fetchFn: opts.deps.fetchFn ?? fetch,
      fetchCredentials: opts.deps.fetchCredentials,
      reportedAuthFailures: new Set<string>(),
    },
  });
  return app;
}

describe("token-aware spill — dense JSON (issue #390 primary)", () => {
  // 30 KB of dense JSON ≈ 8572 tokens. Under the 32 KB legacy byte
  // threshold but ABOVE a tight 4000-token inline cap. With the token
  // budget configured, this MUST spill — the legacy byte path would
  // have inlined it and burned 8.5 K of context for free.

  it("spills 30 KB JSON when token cap is 4000 tokens (legacy byte path would inline)", async () => {
    const denseJson = JSON.stringify({ items: "x".repeat(30_000) });
    const fetchFn = mock(
      async () =>
        new Response(denseJson, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const tokenBudget = new TokenBudget({ inlineCapTokens: 4_000, runBudgetTokens: 100_000 });
    const app = buildTestApp({ deps: makeDeps({ fetchFn }), tokenBudget });

    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "test-provider",
          target: "https://api.example.com/items",
          method: "GET",
        },
      },
    });
    const result = res.json.result as CallToolResult;
    expect(result.content[0]!.type).toBe("resource_link");
    expect(result.content[0]!.uri).toMatch(/^appstrate:\/\/provider-response\//);

    const meta = result._meta?.[TOKEN_BUDGET_META_KEY] as BudgetMeta | undefined;
    expect(meta).toBeDefined();
    expect(meta!.decision).toBe("spill");
    expect(meta!.reason).toBe("exceeds_inline_cap");
    expect(meta!.estimatedTokens).toBeGreaterThan(4_000);
    expect(meta!.inlineCapTokens).toBe(4_000);
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
    const app = buildTestApp({ deps: makeDeps({ fetchFn }), tokenBudget });

    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "test-provider",
          target: "https://api.example.com/items",
          method: "GET",
        },
      },
    });
    const result = res.json.result as CallToolResult;
    expect(result.content[0]!.type).toBe("text");
    expect(result.content[0]!.text).toBe(smallJson);

    const meta = result._meta?.[TOKEN_BUDGET_META_KEY] as BudgetMeta | undefined;
    expect(meta).toBeDefined();
    expect(meta!.decision).toBe("inline");
    expect(meta!.reason).toBe("under_inline_cap");
    expect(meta!.estimatedTokens).toBeGreaterThanOrEqual(1);
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
    const app = buildTestApp({ deps: makeDeps({ fetchFn }), tokenBudget });

    let inlineCount = 0;
    let spillCount = 0;
    let firstSpillReason: string | undefined;

    for (let i = 0; i < 30; i++) {
      const res = await rpc(app, {
        method: "tools/call",
        params: {
          name: "provider_call",
          arguments: {
            providerId: "test-provider",
            target: "https://api.example.com/items",
            method: "GET",
          },
        },
      });
      const result = res.json.result as CallToolResult;
      const meta = result._meta?.[TOKEN_BUDGET_META_KEY] as BudgetMeta | undefined;
      if (result.content[0]!.type === "text") {
        inlineCount++;
        expect(meta!.decision).toBe("inline");
      } else {
        spillCount++;
        if (!firstSpillReason) firstSpillReason = meta!.reason;
        expect(meta!.decision).toBe("spill");
      }
    }

    // Some calls should inline (early), others spill (late).
    expect(inlineCount).toBeGreaterThan(0);
    expect(spillCount).toBeGreaterThan(0);
    // The first spill should be due to the cumulative budget — no
    // single call exceeds the per-call cap.
    expect(firstSpillReason).toBe("exceeds_run_budget");
  });
});

describe("token-aware spill — `_meta` accounting", () => {
  it("attaches token-budget meta to every tool result (text path)", async () => {
    const fetchFn = mock(
      async () =>
        new Response('{"hello":"world"}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const tokenBudget = new TokenBudget({ inlineCapTokens: 4_000, runBudgetTokens: 100_000 });
    const app = buildTestApp({ deps: makeDeps({ fetchFn }), tokenBudget });

    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "test-provider",
          target: "https://api.example.com/items",
          method: "GET",
        },
      },
    });
    const result = res.json.result as CallToolResult;
    const meta = result._meta?.[TOKEN_BUDGET_META_KEY] as BudgetMeta | undefined;
    expect(meta).toBeDefined();
    expect(meta!.runBudgetTokens).toBe(100_000);
    expect(meta!.inlineCapTokens).toBe(4_000);
    expect(meta!.consumedTokens).toBe(0); // before this call
    expect(meta!.estimatedTokens).toBeGreaterThan(0);
  });

  it("reports increasing consumedTokens across successive inline calls", async () => {
    const payload = '{"hello":"world","data":"' + "x".repeat(100) + '"}';
    const fetchFn = mock(
      async () =>
        new Response(payload, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const tokenBudget = new TokenBudget({ inlineCapTokens: 4_000, runBudgetTokens: 100_000 });
    const app = buildTestApp({ deps: makeDeps({ fetchFn }), tokenBudget });

    const consumed: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await rpc(app, {
        method: "tools/call",
        params: {
          name: "provider_call",
          arguments: {
            providerId: "test-provider",
            target: "https://api.example.com/items",
            method: "GET",
          },
        },
      });
      const result = res.json.result as CallToolResult;
      const meta = result._meta?.[TOKEN_BUDGET_META_KEY] as BudgetMeta;
      consumed.push(meta.consumedTokens);
    }
    // The reported `consumedTokens` is the value BEFORE this call's
    // record(), so call N+1 sees what call N delivered.
    expect(consumed[0]).toBe(0);
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
    const app = buildTestApp({ deps: makeDeps({ fetchFn }), tokenBudget });

    const res = await rpc(app, {
      method: "tools/call",
      params: { name: "run_history", arguments: { limit: 1 } },
    });
    const result = res.json.result as CallToolResult;
    expect(result.content[0]!.type).toBe("resource_link");
    const meta = result._meta?.[TOKEN_BUDGET_META_KEY] as BudgetMeta;
    expect(meta.decision).toBe("spill");
    expect(meta.reason).toBe("exceeds_inline_cap");
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
    const app = buildTestApp({ deps: makeDeps({ fetchFn }), tokenBudget });

    const res = await rpc(app, {
      method: "tools/call",
      params: { name: "recall_memory", arguments: { q: "foo" } },
    });
    const result = res.json.result as CallToolResult;
    expect(result.content[0]!.type).toBe("resource_link");
    const meta = result._meta?.[TOKEN_BUDGET_META_KEY] as BudgetMeta;
    expect(meta.decision).toBe("spill");
  });
});

describe("token-aware spill — backwards compatibility", () => {
  it("without a TokenBudget, the legacy byte threshold still applies", async () => {
    // 40 KB > 32 KB legacy threshold. With no TokenBudget wired, this
    // should still spill via the byte path.
    const payload = "y".repeat(40 * 1024);
    const fetchFn = mock(
      async () =>
        new Response(payload, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    // Build app with NO tokenBudget passed — exercise the legacy path.
    const app = buildTestApp({ deps: makeDeps({ fetchFn }) });

    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "test-provider",
          target: "https://api.example.com/items",
          method: "GET",
        },
      },
    });
    const result = res.json.result as CallToolResult;
    expect(result.content[0]!.type).toBe("resource_link");
    // No token-budget meta should be attached when the budget isn't wired.
    expect(result._meta?.[TOKEN_BUDGET_META_KEY]).toBeUndefined();
  });

  it("without a TokenBudget, small responses inline as before", async () => {
    const fetchFn = mock(
      async () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const app = buildTestApp({ deps: makeDeps({ fetchFn }) });
    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "test-provider",
          target: "https://api.example.com/items",
          method: "GET",
        },
      },
    });
    const result = res.json.result as CallToolResult;
    expect(result.content[0]!.type).toBe("text");
    expect(result.content[0]!.text).toBe('{"ok":true}');
    expect(result._meta?.[TOKEN_BUDGET_META_KEY]).toBeUndefined();
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
      const app = createApp(makeDeps({ fetchFn }));
      const res = await rpc(app, {
        method: "tools/call",
        params: {
          name: "provider_call",
          arguments: {
            providerId: "test-provider",
            target: "https://api.example.com/items",
            method: "GET",
          },
        },
      });
      const result = res.json.result as CallToolResult;
      // 2000 chars / 3.5 ≈ 572 tokens — above the 100-token cap.
      expect(result.content[0]!.type).toBe("resource_link");
      const meta = result._meta?.[TOKEN_BUDGET_META_KEY] as BudgetMeta;
      expect(meta.inlineCapTokens).toBe(100);
      expect(meta.runBudgetTokens).toBe(1000);
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
      expect(() => createApp(makeDeps())).toThrow(/positive integer/);
    } finally {
      if (original === undefined) delete process.env.SIDECAR_INLINE_TOOL_OUTPUT_TOKENS;
      else process.env.SIDECAR_INLINE_TOOL_OUTPUT_TOKENS = original;
    }
  });
});

describe("token-aware spill — fallback when blob store is full", () => {
  it("falls back to inline with no_blob_store_fallback_inline reason when blob store is full", async () => {
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
    const app = buildTestApp({ deps: makeDeps({ fetchFn }), tokenBudget, blobStore });

    const res = await rpc(app, {
      method: "tools/call",
      params: {
        name: "provider_call",
        arguments: {
          providerId: "test-provider",
          target: "https://api.example.com/items",
          method: "GET",
        },
      },
    });
    const result = res.json.result as CallToolResult;
    // Spill failed → forced inline.
    expect(result.content[0]!.type).toBe("text");
    const meta = result._meta?.[TOKEN_BUDGET_META_KEY] as BudgetMeta;
    expect(meta.decision).toBe("inline");
    expect(meta.reason).toBe("no_blob_store_fallback_inline");
    // The forced-inline tokens are still recorded against the budget
    // — the agent paid the context cost.
    expect(tokenBudget.consumedTokens()).toBe(meta.estimatedTokens);
  });
});
