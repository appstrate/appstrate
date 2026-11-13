// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { runAgainstStub, stubGatewayModel } from "./helpers.ts";

/** Names of the tools the first model request offered. */
async function offeredTools(outputSchema?: Record<string, unknown>): Promise<string[]> {
  const { requests } = await runAgainstStub({
    model: stubGatewayModel("openai-completions"),
    runner: { modelRetry: false, ...(outputSchema ? { outputSchema } : {}) },
  });
  const body = JSON.parse(requests[0]!.body) as {
    tools?: Array<{ function?: { name?: string; parameters?: unknown } }>;
  };
  return (body.tools ?? []).map((t) => t.function?.name ?? "");
}

describe("PiRunner — output tool", () => {
  it("offers `output` when the agent declares an output schema", async () => {
    expect(await offeredTools({ type: "object", properties: { n: { type: "number" } } })).toContain(
      "output",
    );
  });

  it("offers no `output` without an output schema", async () => {
    expect(await offeredTools()).not.toContain("output");
  });

  it("advertises the declared schema as the `data` argument", async () => {
    const { requests } = await runAgainstStub({
      model: stubGatewayModel("openai-completions"),
      runner: {
        modelRetry: false,
        outputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
      },
    });
    const body = JSON.parse(requests[0]!.body) as {
      tools: Array<{ function: { name: string; parameters: { properties: { data: unknown } } } }>;
    };
    const output = body.tools.find((t) => t.function.name === "output")!;
    expect(output.function.parameters.properties.data).toMatchObject({
      properties: { n: { type: "number" } },
      required: ["n"],
    });
  });

  // The runner stamps `runId` and `timestamp` on a harness event (the reducer
  // copies `timestamp` into RunResult, where the finalize endpoint requires a
  // number), and the call settles its write before the run finalizes.
  it("emits `output.emitted` stamped with the run id and a timestamp", async () => {
    let calls = 0;
    const { sink } = await runAgainstStub({
      model: stubGatewayModel("openai-completions"),
      runner: { modelRetry: false, outputSchema: { type: "object" } },
      respond: () => {
        if (calls++ > 0) return new Response("stop", { status: 400 });
        const chunk = (delta: unknown, finish: string | null) =>
          `data: ${JSON.stringify({
            id: "c1",
            object: "chat.completion.chunk",
            created: 0,
            model: "gateway-model",
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`;
        const toolCall = {
          index: 0,
          id: "call_1",
          type: "function",
          function: { name: "output", arguments: JSON.stringify({ data: { ok: true } }) },
        };
        return new Response(
          chunk({ role: "assistant", tool_calls: [toolCall] }, null) +
            chunk({}, "tool_calls") +
            "data: [DONE]\n\n",
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    const emitted = sink.events.filter((event) => event.type === "output.emitted");
    expect(emitted).toEqual([
      {
        type: "output.emitted",
        data: { ok: true },
        runId: "run_test",
        timestamp: expect.any(Number),
      },
    ]);
    expect(sink.finalized?.output).toEqual({ ok: true });
  });
});
