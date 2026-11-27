// SPDX-License-Identifier: Apache-2.0

/**
 * The journal of a local MCP server the sidecar does not front with a MITM listener: one row per
 * `tools/call` it forwards (`journalToolCalls`), host NULL, outcome `200` for any answer of the
 * server and a failure code when there is none.
 */

import { describe, expect, it } from "bun:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { AppstrateMcpClient, CallToolResult } from "@appstrate/mcp-transport";
import { journalToolCalls } from "../integrations-boot.ts";
import { recordingJournal } from "./helpers/call-journal.ts";

function clientAnswering(answer: () => Promise<CallToolResult>): AppstrateMcpClient {
  return {
    callTool: answer,
    listTools: async () => ({ tools: [] }),
  } as unknown as AppstrateMcpClient;
}

const timeoutError = () => {
  const cause = new Error("The operation timed out.");
  cause.name = "TimeoutError";
  return new Error("fetch failed", { cause });
};

describe("journalToolCalls", () => {
  it("journals a result and a tool error as 200, with no host", async () => {
    const { journal, calls } = recordingJournal();
    const ok: CallToolResult = { content: [{ type: "text", text: "fine" }] };
    const toolError: CallToolResult = { isError: true, content: [{ type: "text", text: "no" }] };
    const answers = [ok, toolError];
    const client = journalToolCalls(
      clientAnswering(async () => answers.shift()!),
      journal,
    );

    expect(await client.callTool({ name: "a", arguments: {} })).toBe(ok);
    expect(await client.callTool({ name: "b", arguments: {} })).toBe(toolError);
    expect(calls.map(({ durationMs: _, startedAtMs: __, ...call }) => call)).toEqual([
      { method: "POST", host: null, outcome: "200", credential: null },
      { method: "POST", host: null, outcome: "200", credential: null },
    ]);
  });

  it("journals a JSON-RPC error answer as 200 and rethrows it", async () => {
    const { journal, calls } = recordingJournal();
    const refused = new McpError(ErrorCode.InvalidParams, "bad arguments");
    const client = journalToolCalls(
      clientAnswering(async () => {
        throw refused;
      }),
      journal,
    );
    await expect(client.callTool({ name: "a", arguments: {} })).rejects.toBe(refused);
    expect(calls.map((c) => c.outcome)).toEqual(["200"]);
  });

  it("journals no answer as upstream_timeout or upstream_unreachable", async () => {
    const { journal, calls } = recordingJournal();
    const failures = [
      new McpError(ErrorCode.RequestTimeout, "Request timed out"),
      new McpError(ErrorCode.ConnectionClosed, "Connection closed"),
      timeoutError(),
      new Error("runner gone"),
    ];
    const client = journalToolCalls(
      clientAnswering(async () => {
        throw failures.shift()!;
      }),
      journal,
    );
    for (let i = 0; i < 4; i++) {
      await expect(client.callTool({ name: "a", arguments: {} })).rejects.toBeDefined();
    }
    expect(calls.map((c) => c.outcome)).toEqual([
      "upstream_timeout",
      "upstream_unreachable",
      "upstream_timeout",
      "upstream_unreachable",
    ]);
  });

  it("journals nothing for a listing", async () => {
    const { journal, calls } = recordingJournal();
    const client = journalToolCalls(
      clientAnswering(async () => ({ content: [] })),
      journal,
    );
    await client.listTools();
    expect(calls).toEqual([]);
  });
});
