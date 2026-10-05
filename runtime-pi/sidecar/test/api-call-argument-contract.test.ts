// SPDX-License-Identifier: Apache-2.0

/**
 * The `api_call` handler does not re-check what its `inputSchema` says: the
 * agent runtime does, before it calls. `runtime-pi/mcp/direct.ts` registers
 * the tool with this schema and Pi validates the arguments ahead of `execute`.
 *
 * This pins that reliance against the validator the agent runs. A Pi release
 * that lets one of these through fails here, not as an opaque error in a run.
 */

import { describe, it, expect } from "bun:test";
import { Type, validateToolArguments, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import { buildSidecarRuntimeDeps } from "../app.ts";
import { createApiCallToolDefs } from "../mcp.ts";

const TARGET = "https://api.example.com/v1/messages";

function apiCallTool(): Tool {
  const runtimeDeps = buildSidecarRuntimeDeps({
    config: { platformApiUrl: "http://mock:3000", runToken: "tok", proxyUrl: "" },
    cookieJar: new Map(),
    fetchFn: fetch,
    isReady: () => true,
  });
  const defs = createApiCallToolDefs(
    {
      namespace: "gmail",
      integrationId: "@official/gmail",
      connectionId: "conn-1",
      declaredUris: ["https://api.example.com/**"],
      fetchCredentials: async () => {
        throw new Error("not called");
      },
      refreshCredentials: async () => {
        throw new Error("not called");
      },
    },
    runtimeDeps,
  );
  const { descriptor } = defs.find((def) => def.descriptor.name === "api_call")!;
  return {
    name: descriptor.name,
    description: descriptor.description ?? "",
    parameters: Type.Unsafe(descriptor.inputSchema),
  };
}

type Arguments = ToolCall["arguments"];

function validate(args: Arguments): Arguments {
  const call: ToolCall = { type: "toolCall", id: "call-1", name: "api_call", arguments: args };
  return validateToolArguments(apiCallTool(), call);
}

describe("api_call arguments — what the agent runtime settles before the sidecar", () => {
  const rejected: Array<[string, Arguments]> = [
    ["a missing target", { method: "GET" }],
    ["a target that is not a string", { target: 5 }],
    ["an empty target", { target: "" }],
    ["a lower-case method", { target: TARGET, method: "get" }],
    ["a method outside the enum", { target: TARGET, method: "TRACE" }],
    ["a header value that is an object", { target: TARGET, headers: { "X-Obj": { a: 1 } } }],
    ["headers that are a string", { target: TARGET, headers: "X-Count: 5" }],
    ["headers that are an array", { target: TARGET, headers: ["X-Count: 5"] }],
    ["an argument the schema does not declare", { target: TARGET, integrationId: "@x/y" }],
  ];
  for (const [what, args] of rejected) {
    it(`rejects ${what}`, () => {
      expect(() => validate(args)).toThrow(/Validation failed for tool "api_call"/);
    });
  }

  it("hands header values over as strings", () => {
    const { headers } = validate({
      target: TARGET,
      headers: { "X-Count": 5, "X-Flag": true, "X-Null": null, "X-Text": "v" },
    });
    expect(headers).toEqual({ "X-Count": "5", "X-Flag": "true", "X-Null": "", "X-Text": "v" });
  });
});
