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
});
