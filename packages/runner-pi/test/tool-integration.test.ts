// SPDX-License-Identifier: Apache-2.0

/**
 * A real Pi session reports a call to an integration's tool by the identity its host stamped on
 * the descriptor, on the start and the end event: the session keeps the definition the tool was
 * registered with, which is where the runner reads it back. A harness tool carries none.
 */

import { describe, it, expect } from "bun:test";
import { TOOL_INTEGRATION_META_KEY } from "@appstrate/mcp-transport";
import { mcpToolForwardFactory } from "../src/mcp-forward.ts";
import { runAgainstStub, stubGatewayModel } from "./helpers.ts";

const chunk = (delta: unknown, finish: string | null) =>
  `data: ${JSON.stringify({
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model: "gateway-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

/** One streamed turn calling `name` with `args`. */
const toolCallTurn = (id: string, name: string, args: unknown) =>
  new Response(
    chunk(
      {
        role: "assistant",
        tool_calls: [
          { index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } },
        ],
      },
      null,
    ) +
      chunk({}, "tool_calls") +
      "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } },
  );

describe("PiRunner — integration identity on tool events", () => {
  it("stamps the integration tool on both events of its call, nothing on a harness tool", async () => {
    const integration = { id: "@acme/github", tool: "list.issues", title: "List issues" };
    const exposed = "acme_github__list_issues_1a2b3c4d";
    let turn = 0;
    const { sink } = await runAgainstStub({
      model: stubGatewayModel("openai-completions"),
      runner: {
        modelRetry: false,
        outputSchema: { type: "object" },
        extensionFactories: [
          mcpToolForwardFactory({
            mcp: {
              callTool: async () => ({ content: [{ type: "text", text: "[]" }] }),
              readResource: async () => ({ contents: [] }),
            },
            tool: {
              name: exposed,
              inputSchema: { type: "object" },
              _meta: { [TOOL_INTEGRATION_META_KEY]: integration },
            },
            upstreamName: "list.issues",
            runId: "run_test",
            workspace: "/tmp",
            emit: () => {},
          }),
        ],
      },
      respond: () => {
        turn += 1;
        if (turn === 1) return toolCallTurn("call_1", exposed, {});
        if (turn === 2) return toolCallTurn("call_2", "output", { data: { ok: true } });
        return new Response("stop", { status: 400 });
      },
    });
    const toolEvents = sink.events
      .filter((event) => event.type === "appstrate.progress")
      .map((event) => event.data as Record<string, unknown>)
      .filter((data) => data.toolCallId !== undefined);
    expect(toolEvents.map((data) => [data.tool, "result" in data, data.integration])).toEqual([
      [exposed, false, integration],
      [exposed, true, integration],
      ["output", false, undefined],
      ["output", true, undefined],
    ]);
  });
});
