// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import {
  makeRunHistoryTool,
  createSidecarRunHistoryCall,
  type RunHistoryCallFn,
  type RunHistoryRequest,
  type RunHistoryResponse,
  type RunEvent,
  type ToolContext,
} from "../../src/resolvers/index.ts";

function makeCtx(): { ctx: ToolContext; events: RunEvent[] } {
  const events: RunEvent[] = [];
  return {
    events,
    ctx: {
      emit: (e) => {
        events.push(e);
      },
      workspace: "/tmp",
      runId: "run_test",
      toolCallId: "call_1",
      signal: new AbortController().signal,
    },
  };
}

function okCall(runs: RunHistoryResponse["runs"]): RunHistoryCallFn {
  return async () => ({ runs });
}

const sampleRuns = [
  { id: "run_a", status: "success", date: "2026-04-01T00:00:00Z", duration: 1234, state: { n: 1 } },
  { id: "run_b", status: "failed", date: "2026-03-31T00:00:00Z", duration: 4567 },
];

// ─────────────────────────────────────────────
// Tool surface
// ─────────────────────────────────────────────

describe("makeRunHistoryTool — tool surface", () => {
  it("produces a tool named run_history with a strict JSON Schema", () => {
    const tool = makeRunHistoryTool(okCall([]));
    expect(tool.name).toBe("run_history");
    const params = tool.parameters as {
      type: string;
      additionalProperties: boolean;
      properties: Record<string, Record<string, unknown>>;
    };
    expect(params.type).toBe("object");
    expect(params.additionalProperties).toBe(false);
    expect(params.properties.limit).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 50,
    });
    expect(params.properties.fields).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 2,
      uniqueItems: true,
    });
    const fieldsSchema = params.properties.fields as { items: { enum: string[] } };
    expect(fieldsSchema.items.enum).toEqual(["state", "result"]);
  });

  it("mentions use-cases in the description (replaces legacy Run History prompt section)", () => {
    const tool = makeRunHistoryTool(okCall([]));
    expect(tool.description).toMatch(/trend analysis|audit|recover/i);
    expect(tool.description).toContain("runs");
  });
});

// ─────────────────────────────────────────────
// Request normalisation (defaults + bounds)
// ─────────────────────────────────────────────

describe("makeRunHistoryTool — request normalisation", () => {
  it("applies defaults when no args are supplied", async () => {
    let captured: RunHistoryRequest | null = null;
    const tool = makeRunHistoryTool(async (req) => {
      captured = req;
      return { runs: [] };
    });
    const { ctx } = makeCtx();
    await tool.execute({}, ctx);
    expect(captured!).toEqual({ limit: 10, fields: ["state"] });
  });

  it("applies defaults on undefined args (LLM omits the parameters entirely)", async () => {
    let captured: RunHistoryRequest | null = null;
    const tool = makeRunHistoryTool(async (req) => {
      captured = req;
      return { runs: [] };
    });
    const { ctx } = makeCtx();
    await tool.execute(undefined, ctx);
    expect(captured!).toEqual({ limit: 10, fields: ["state"] });
  });

  it("clamps limit above MAX_LIMIT (50) defensively", async () => {
    let captured: RunHistoryRequest | null = null;
    const tool = makeRunHistoryTool(async (req) => {
      captured = req;
      return { runs: [] };
    });
    const { ctx } = makeCtx();
    await tool.execute({ limit: 9999 }, ctx);
    expect(captured!).toEqual({ limit: 50, fields: ["state"] });
  });

  it("falls back to default limit for non-integer or < 1 values", async () => {
    let captured: RunHistoryRequest | null = null;
    const tool = makeRunHistoryTool(async (req) => {
      captured = req;
      return { runs: [] };
    });
    const { ctx } = makeCtx();
    await tool.execute({ limit: 0 }, ctx);
    expect(captured!.limit).toBe(10);
    await tool.execute({ limit: -3 }, ctx);
    expect(captured!.limit).toBe(10);
    await tool.execute({ limit: "5" as unknown as number }, ctx);
    expect(captured!.limit).toBe(10);
  });

  it("floors fractional limits and keeps them within bounds", async () => {
    let captured: RunHistoryRequest | null = null;
    const tool = makeRunHistoryTool(async (req) => {
      captured = req;
      return { runs: [] };
    });
    const { ctx } = makeCtx();
    await tool.execute({ limit: 7.8 }, ctx);
    expect(captured!.limit).toBe(7);
  });

  it("deduplicates and filters fields to known values", async () => {
    let captured: RunHistoryRequest | null = null;
    const tool = makeRunHistoryTool(async (req) => {
      captured = req;
      return { runs: [] };
    });
    const { ctx } = makeCtx();
    await tool.execute({ fields: ["state", "state", "result", "unknown"] }, ctx);
    expect(captured!.fields.sort()).toEqual(["result", "state"]);
  });

  it("falls back to default fields when the filtered set is empty", async () => {
    let captured: RunHistoryRequest | null = null;
    const tool = makeRunHistoryTool(async (req) => {
      captured = req;
      return { runs: [] };
    });
    const { ctx } = makeCtx();
    await tool.execute({ fields: ["garbage"] }, ctx);
    expect(captured!.fields).toEqual(["state"]);
  });
});

// ─────────────────────────────────────────────
// Execution + events
// ─────────────────────────────────────────────

describe("makeRunHistoryTool — execution + events", () => {
  it("returns the response serialised as JSON text content", async () => {
    const tool = makeRunHistoryTool(okCall(sampleRuns));
    const { ctx } = makeCtx();
    const result = await tool.execute({ limit: 2 }, ctx);
    expect(result.content).toHaveLength(1);
    const entry = result.content[0]!;
    expect(entry.type).toBe("text");
    const parsed = JSON.parse((entry as { text: string }).text);
    expect(parsed).toEqual({ runs: sampleRuns });
    expect(result.isError).toBeUndefined();
  });

  it("emits run_history.called with success status + count on success", async () => {
    const tool = makeRunHistoryTool(okCall(sampleRuns));
    const { ctx, events } = makeCtx();
    await tool.execute({ limit: 2 }, ctx);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("run_history.called");
    expect(event.runId).toBe("run_test");
    expect(event.toolCallId).toBe("call_1");
    expect(event.status).toBe("success");
    expect(event.count).toBe(2);
    expect(event.limit).toBe(2);
    expect(event.fields).toEqual(["state"]);
    expect(typeof event.durationMs).toBe("number");
    expect(event.durationMs as number).toBeGreaterThanOrEqual(0);
    expect(event.error).toBeUndefined();
  });

  it("emits run_history.called with error status and re-throws on transport failure", async () => {
    const tool = makeRunHistoryTool(async () => {
      throw new Error("boom");
    });
    const { ctx, events } = makeCtx();
    await expect(tool.execute({}, ctx)).rejects.toThrow("boom");
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("run_history.called");
    expect(event.status).toBe("error");
    expect(event.error).toBe("boom");
    expect(event.count).toBeUndefined();
  });

  it("skips event emission when emitEvent: false", async () => {
    const tool = makeRunHistoryTool(okCall([]), { emitEvent: false });
    const { ctx, events } = makeCtx();
    await tool.execute({}, ctx);
    expect(events).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────
// Sidecar transport factory
// ─────────────────────────────────────────────

describe("createSidecarRunHistoryCall — URL + headers", () => {
  it("rejects an empty sidecarUrl at construction time", () => {
    expect(() => createSidecarRunHistoryCall({ sidecarUrl: "" })).toThrow(/sidecarUrl is required/);
  });

  it("builds the URL with encoded limit + comma-separated fields", async () => {
    const captured: { url: string; init: RequestInit }[] = [];
    const call = createSidecarRunHistoryCall({
      sidecarUrl: "http://sidecar:8080",
      fetch: ((url: string, init: RequestInit) => {
        captured.push({ url, init });
        return Promise.resolve(
          new Response(JSON.stringify({ runs: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }) as typeof fetch,
    });
    await call({ limit: 7, fields: ["state", "result"] });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe("http://sidecar:8080/run-history?limit=7&fields=state%2Cresult");
    expect(captured[0]!.init.method).toBe("GET");
  });

  it("rtrims trailing slashes on the sidecarUrl", async () => {
    const captured: string[] = [];
    const call = createSidecarRunHistoryCall({
      sidecarUrl: "http://sidecar:8080/",
      fetch: ((url: string) => {
        captured.push(url);
        return Promise.resolve(new Response(JSON.stringify({ runs: [] })));
      }) as typeof fetch,
    });
    await call({ limit: 1, fields: ["state"] });
    expect(captured[0]).toBe("http://sidecar:8080/run-history?limit=1&fields=state");
  });

  it("forwards baseHeaders on every dispatch", async () => {
    const captured: RequestInit[] = [];
    const call = createSidecarRunHistoryCall({
      sidecarUrl: "http://sidecar:8080",
      baseHeaders: { "X-Trace-Id": "trace-xyz" },
      fetch: ((_url: string, init: RequestInit) => {
        captured.push(init);
        return Promise.resolve(new Response(JSON.stringify({ runs: [] })));
      }) as typeof fetch,
    });
    await call({ limit: 1, fields: ["state"] });
    const headers = captured[0]!.headers as Record<string, string>;
    expect(headers["X-Trace-Id"]).toBe("trace-xyz");
  });
});

describe("createSidecarRunHistoryCall — error surfaces", () => {
  it("throws a descriptive error on non-2xx status", async () => {
    const call = createSidecarRunHistoryCall({
      sidecarUrl: "http://sidecar:8080",
      fetch: ((_url: string, _init: RequestInit) =>
        Promise.resolve(
          new Response("sidecar unavailable", { status: 503 }),
        )) as unknown as typeof fetch,
    });
    await expect(call({ limit: 1, fields: ["state"] })).rejects.toThrow(
      /HTTP 503.*sidecar unavailable/,
    );
  });

  it("throws a descriptive error on non-JSON bodies", async () => {
    const call = createSidecarRunHistoryCall({
      sidecarUrl: "http://sidecar:8080",
      fetch: ((_url: string, _init: RequestInit) =>
        Promise.resolve(
          new Response("<html>nope</html>", { status: 200 }),
        )) as unknown as typeof fetch,
    });
    await expect(call({ limit: 1, fields: ["state"] })).rejects.toThrow(/non-JSON body/);
  });

  it("rejects responses missing the runs array", async () => {
    const call = createSidecarRunHistoryCall({
      sidecarUrl: "http://sidecar:8080",
      fetch: ((_url: string, _init: RequestInit) =>
        Promise.resolve(
          new Response(JSON.stringify({ wrong: "shape" }), { status: 200 }),
        )) as unknown as typeof fetch,
    });
    await expect(call({ limit: 1, fields: ["state"] })).rejects.toThrow(/missing "runs" array/);
  });

  it("rejects entries with missing mandatory fields", async () => {
    const call = createSidecarRunHistoryCall({
      sidecarUrl: "http://sidecar:8080",
      fetch: ((_url: string, _init: RequestInit) =>
        Promise.resolve(
          new Response(
            JSON.stringify({ runs: [{ id: "x", status: "success" /* date missing */ }] }),
            { status: 200 },
          ),
        )) as unknown as typeof fetch,
    });
    await expect(call({ limit: 1, fields: ["state"] })).rejects.toThrow(/missing "runs" array/);
  });

  it("reports a clean timeout message when the call is aborted", async () => {
    const call = createSidecarRunHistoryCall({
      sidecarUrl: "http://sidecar:8080",
      timeoutMs: 5,
      fetch: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            (err as Error & { name: string }).name = "AbortError";
            reject(err);
          });
        })) as unknown as typeof fetch,
    });
    await expect(call({ limit: 1, fields: ["state"] })).rejects.toThrow(/timed out after 5ms/);
  });

  it("wraps network failures with a contextual message", async () => {
    const call = createSidecarRunHistoryCall({
      sidecarUrl: "http://sidecar:8080",
      fetch: ((_url: string, _init: RequestInit) =>
        Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch,
    });
    await expect(call({ limit: 1, fields: ["state"] })).rejects.toThrow(
      /sidecar call failed.*ECONNREFUSED/,
    );
  });
});
