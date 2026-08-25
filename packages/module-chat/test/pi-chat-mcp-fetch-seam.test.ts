// SPDX-License-Identifier: Apache-2.0

/**
 * `BuildPlatformMcpToolsOptions.fetch` — the seam that keeps the tool layer's
 * platform hops IN-PROCESS.
 *
 * The MCP handshake has always ridden it. `run_and_wait` did not: its ctx took
 * no transport and closed over the global `fetch`, so the launch POST and the
 * whole poll loop opened real loopback sockets back into this same process —
 * on the tool that makes by far the most hops (three handshake calls per turn,
 * versus one launch plus a poll per ~55 s of wait, per run).
 *
 * The stub origin here is deliberately `http://127.0.0.1:1`, a port nothing
 * listens on: a hop that escapes the seam does not silently succeed against a
 * live server, it throws ECONNREFUSED out of `execute`. So "the injected fetch
 * saw the launch and the poll" and "no hop escaped" are the same assertion.
 */

import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@appstrate/runner-pi";
import { buildPlatformMcpTools } from "../src/pi-chat/mcp-tools.ts";

/** Nothing listens here — see the file header. */
const ORIGIN = "http://127.0.0.1:1";
const MCP_URL = `${ORIGIN}/api/mcp/o/org_1`;
const RUN_ID = "run_seam_1";

interface RegisteredTool {
  name: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

/** Capture what an extension factory registers, without a real Pi session. */
function capturePi() {
  const tools: RegisteredTool[] = [];
  const pi = {
    registerTool: (tool: RegisteredTool) => tools.push(tool),
  } as unknown as ExtensionAPI;
  return { pi, tools };
}

/**
 * One transport playing both servers the tool layer talks to: the platform MCP
 * endpoint (Streamable HTTP, advertising `run_and_wait`) and the run REST API.
 * Every call it answers is a call that did NOT open a socket.
 */
function seamFetch() {
  const seen: Array<{ method: string; url: string }> = [];
  const json = (body: unknown, extra?: Record<string, string>) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", ...extra },
    });

  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    seen.push({ method: req.method, url: url.pathname + url.search });

    if (url.pathname.startsWith("/api/mcp/")) {
      if (req.method === "GET") return new Response(null, { status: 405 });
      if (req.method === "DELETE") return new Response(null, { status: 202 });
      const msg = (await req.json()) as { id?: unknown; method?: string };
      // Notifications carry no id and expect no body.
      if (!("id" in msg) || msg.id === undefined) return new Response(null, { status: 202 });
      const reply = (result: unknown, extra?: Record<string, string>) =>
        json({ jsonrpc: "2.0", id: msg.id, result }, extra);
      if (msg.method === "initialize") {
        return reply(
          {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "stub-platform-mcp", version: "1.0.0" },
          },
          { "mcp-session-id": "sess_seam" },
        );
      }
      if (msg.method === "tools/list") {
        return reply({
          tools: [
            {
              name: "run_and_wait",
              description: "Launch an Appstrate run and wait for completion.",
              inputSchema: { type: "object" },
            },
          ],
        });
      }
      return reply({});
    }

    // Launch POST.
    if (req.method === "POST" && url.pathname.endsWith("/run")) {
      return json({ id: RUN_ID, packageId: "@acme/demo", status: "pending" });
    }
    // Poll GET — terminal on the first read.
    if (req.method === "GET" && url.pathname === `/api/runs/${RUN_ID}`) {
      return json({ id: RUN_ID, packageId: "@acme/demo", status: "success" });
    }
    // Produced-file read on the terminal step.
    if (req.method === "GET" && url.pathname === "/api/files") return json({ data: [] });

    return new Response(null, { status: 404 });
  }) as typeof fetch;

  return { fetch: impl, seen };
}

describe("buildPlatformMcpTools fetch seam", () => {
  it("routes the run_and_wait launch AND poll through the injected fetch", async () => {
    const transport = seamFetch();
    const built = await buildPlatformMcpTools({
      url: MCP_URL,
      headers: { authorization: "Bearer loopback", "x-org-id": "org_1" },
      writeChunk: () => {},
      signal: new AbortController().signal,
      turnBudget: { deadlineAt: Date.now() + 10 * 60_000, stepCount: () => 0 },
      fetch: transport.fetch,
    });

    try {
      const { pi, tools } = capturePi();
      for (const factory of built.extensionFactories) factory(pi);
      const runAndWait = tools.find((t) => t.name === "run_and_wait");
      expect(runAndWait).toBeDefined();

      const result = await runAndWait!.execute("call_1", {
        kind: "agent",
        scope: "@acme",
        name: "demo",
      });

      // The run reached its terminal status, which is only reachable if BOTH
      // hops were answered by the stub — nothing listens on the origin.
      const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
      expect(payload.id).toBe(RUN_ID);
      expect(payload.status).toBe("success");

      // And the seam saw them by name, so this fails on a silent re-route too.
      const seen = transport.seen;
      expect(seen).toContainEqual({ method: "POST", url: "/api/agents/@acme/demo/run" });
      expect(
        seen.some((h) => h.method === "GET" && h.url.startsWith(`/api/runs/${RUN_ID}?wait=`)),
      ).toBe(true);
    } finally {
      await built.close();
    }
  });
});
