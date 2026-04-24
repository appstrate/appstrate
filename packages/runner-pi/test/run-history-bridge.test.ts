// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `run-history-bridge.ts` — verify the bridge registers a
 * `run_history` tool against Pi, wires the sidecar transport, propagates
 * the run context, and routes events to the supplied emitter.
 */

import { describe, it, expect } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { RunEvent } from "@appstrate/afps-runtime/resolvers";
import { buildRunHistoryExtensionFactory } from "../src/run-history-bridge.ts";

function makeFakePi(): {
  api: ExtensionAPI;
  tools: Array<{
    name: string;
    label?: string;
    description?: string;
    parameters: unknown;
    execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
  }>;
} {
  const tools: Array<{
    name: string;
    label?: string;
    description?: string;
    parameters: unknown;
    execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
  }> = [];
  const api = {
    registerTool(tool: (typeof tools)[number]) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;
  return { api, tools };
}

describe("buildRunHistoryExtensionFactory", () => {
  it("rejects a missing sidecarUrl at build time (fail-fast)", () => {
    expect(() =>
      buildRunHistoryExtensionFactory({
        sidecarUrl: "",
        runId: "run_x",
        workspace: "/tmp",
        emit: () => {},
      }),
    ).toThrow(/sidecarUrl is required/);
  });

  it("registers a single Pi tool named run_history", () => {
    const factory = buildRunHistoryExtensionFactory({
      sidecarUrl: "http://sidecar:8080",
      runId: "run_x",
      workspace: "/tmp",
      emit: () => {},
    });
    const pi = makeFakePi();
    factory(pi.api);
    expect(pi.tools).toHaveLength(1);
    expect(pi.tools[0]!.name).toBe("run_history");
  });

  it("propagates the run context and emits run_history.called", async () => {
    const events: RunEvent[] = [];
    const capturedFetches: { url: string; init: RequestInit }[] = [];
    const factory = buildRunHistoryExtensionFactory({
      sidecarUrl: "http://sidecar:8080",
      runId: "run_123",
      workspace: "/workspace",
      emit: (e) => events.push(e),
      transport: {
        fetch: ((url: string, init: RequestInit) => {
          capturedFetches.push({ url, init });
          return Promise.resolve(
            new Response(
              JSON.stringify({
                runs: [
                  {
                    id: "run_prev",
                    status: "success",
                    date: "2026-04-01T00:00:00Z",
                    duration: 1000,
                  },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          );
        }) as unknown as typeof fetch,
      },
    });
    const pi = makeFakePi();
    factory(pi.api);

    const result = await pi.tools[0]!.execute("call_abc", { limit: 1 }, undefined);

    expect(capturedFetches).toHaveLength(1);
    expect(capturedFetches[0]!.url).toBe("http://sidecar:8080/run-history?limit=1&fields=state");
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("run_history.called");
    expect(event.runId).toBe("run_123");
    expect(event.toolCallId).toBe("call_abc");
    expect(event.status).toBe("success");
    expect(event.count).toBe(1);

    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    expect(content).toHaveLength(1);
    const parsed = JSON.parse(content[0]!.text);
    expect(parsed.runs).toHaveLength(1);
  });

  it("forwards transport overrides (baseHeaders, timeoutMs)", async () => {
    const captured: RequestInit[] = [];
    const factory = buildRunHistoryExtensionFactory({
      sidecarUrl: "http://sidecar:8080",
      runId: "run_y",
      workspace: "/tmp",
      emit: () => {},
      transport: {
        baseHeaders: { "X-Trace-Id": "t-xyz" },
        fetch: ((_url: string, init: RequestInit) => {
          captured.push(init);
          return Promise.resolve(new Response(JSON.stringify({ runs: [] })));
        }) as unknown as typeof fetch,
      },
    });
    const pi = makeFakePi();
    factory(pi.api);
    await pi.tools[0]!.execute("call_x", {}, undefined);
    const headers = captured[0]!.headers as Record<string, string>;
    expect(headers["X-Trace-Id"]).toBe("t-xyz");
  });
});
